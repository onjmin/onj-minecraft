package main

// クラフト。
//
// 統合版は server_authoritative_inventory なので、インベントリを直接いじる形では
// なく ItemStackRequest でサーバーに依頼する。レシピはサーバーが接続時に
// CraftingData で全部送ってくるので、それを出来上がる物の名前で引けるようにする。
//
// 作業台が無いときは 2x2 の枠しか使えない。3x3 のレシピは弾く。
//
// **まだ通っていない。** vanilla 1.26.45 に対して試した組み合わせと、返ってきた
// 拒否理由は以下の通り。同じ道を二度辿らないために残す。
//
//	CraftRecipe + 枠へ置かない            -> 7  InvalidCraftRequest
//	CraftRecipe + 枠(28..31)へ Place      -> 49 FailedToValidateSrcSlot
//	AutoCraft   + 画面を開かない          -> 7  InvalidCraftRequest
//	AutoCraft   + 画面を開く + Take のみ  -> 19 ExpectedAnywhereItemNotFullyConsumed
//	  ↑ ここでクラフト自体は処理されている。消費の申告が要ると分かる。
//	+ Consume(ホットバー/インベントリ)    -> 27 ConsumedItemNotAllowed
//	+ Consume(まとめた ID)                -> 49 FailedToValidateSrcSlot
//	+ Consume(全部 ContainerInventory)    -> 65 CannotRemoveItem
//	+ Consume(クラフト枠)                 -> 49 FailedToValidateSrcSlot
//	枠の番号は 0 起点の方が先へ進む(28 起点だと 49 で止まる)。
//
// 「持ち物の画面を開いた」ことを Interact で伝えるのは必須。伝えないと
// 置き先が不正と判断される(50 FailedToValidateDstSlot)。
//
// 次は実クライアントの ItemStackRequest をプロキシで観測するのが確実。
// プロキシは sidecar/bedrock/proxy.go にあるが、クライアントを繋いだ状態を
// 維持できていない。

import (
	"fmt"
	"os"
	"strings"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// クラフト枠の先頭番号。
// 28/32 でも通る実装があるが、vanilla は 0 起点を要求する。
const (
	craftingInputBase2x2 byte = 0
	craftingInputBase3x3 byte = 0
)

// craftInput は素材1種。
type craftInput struct {
	Name  string
	Count int
}

// craftRecipe は使えるレシピ1件。
type craftRecipe struct {
	NetworkID uint32
	Output    string
	// OutputCount は1回作るとできる数。棒なら4。
	OutputCount int
	Inputs      []craftInput
	// GridSize は必要な枠の広さ。2 なら手持ちの 2x2 で作れる。
	GridSize int
	// NeedsTable は作業台が要るか。
	NeedsTable bool
	// outputNetworkID は出来上がる物の実行時ID。名前はアイテム表から引く。
	outputNetworkID int32
}

// collectRecipes は CraftingData から使えるものだけを取り出す。
//
// タグやMoLangで素材を指定するレシピは、こちらで素材を解決できないので落とす。
// 木材のように「どの木でもよい」類がここに含まれるが、種類ごとの個別レシピも
// 別にあるので実用上は困らない。
// 棄却の理由。なぜ1件も拾えないのかを見るための記録。
type recipeReject struct {
	NoOutput   int
	OtherBlock int
	NonDefault int
	NoInput    int
	SampleDesc string
}

var lastReject recipeReject

// 出来上がる物の名前はここでは決まらない。レシピは実行時IDしか持っておらず、
// アイテム表はセッション側にあるため、名前付けは呼び出し側で行う。
func collectRecipes(pk *packet.CraftingData) []craftRecipe {
	var out []craftRecipe
	lastReject = recipeReject{}

	add := func(r craftRecipe) {
		if len(r.Inputs) == 0 {
			return
		}
		out = append(out, r)
	}

	for _, r := range pk.ShapelessRecipes {
		rec, ok := buildRecipe(r.RecipeNetworkID, r.Block, r.Input, r.Output)
		if !ok {
			continue
		}
		// 形を問わないので、素材の数がそのまま必要な枠の数になる。
		rec.GridSize = 2
		if len(rec.Inputs) > 4 {
			rec.GridSize = 3
		}
		rec.NeedsTable = rec.GridSize > 2
		add(rec)
	}

	for _, r := range pk.ShapedRecipes {
		rec, ok := buildRecipe(r.RecipeNetworkID, r.Block, r.Input, r.Output)
		if !ok {
			continue
		}
		rec.GridSize = int(max(r.Width, r.Height))
		rec.NeedsTable = rec.GridSize > 2
		add(rec)
	}

	return out
}

func buildRecipe(id uint32, block string, input []protocol.ItemDescriptorCount, output []protocol.ItemStack) (craftRecipe, bool) {
	if len(output) == 0 {
		lastReject.NoOutput++
		return craftRecipe{}, false
	}
	// 作業台以外(かまど・醸造など)はここでは扱わない。
	if block != "crafting_table" && block != "" {
		lastReject.OtherBlock++
		return craftRecipe{}, false
	}

	// 出来上がる物の名前は ItemStack からは引けないので、NetworkID で後から引く。
	rec := craftRecipe{
		NetworkID:   id,
		OutputCount: int(output[0].Count),
	}
	rec.outputNetworkID = output[0].ItemType.NetworkID

	// 同じ素材が複数枠にあるならまとめる。
	counts := map[string]int{}
	order := []string{}
	for _, in := range input {
		d, ok := in.Descriptor.(*protocol.DefaultItemDescriptor)
		if !ok {
			// タグ指定などは解決できない。
			lastReject.NonDefault++
			if lastReject.SampleDesc == "" {
				lastReject.SampleDesc = fmt.Sprintf("%T", in.Descriptor)
			}
			return craftRecipe{}, false
		}
		name := strings.TrimPrefix(d.Name, "minecraft:")
		if name == "" {
			continue
		}
		n := int(in.Count)
		if n <= 0 {
			n = 1
		}
		if _, seen := counts[name]; !seen {
			order = append(order, name)
		}
		counts[name] += n
	}
	if len(order) == 0 {
		lastReject.NoInput++
		return craftRecipe{}, false
	}
	for _, name := range order {
		rec.Inputs = append(rec.Inputs, craftInput{Name: name, Count: counts[name]})
	}
	return rec, true
}

// craftRequest は1回ぶんのクラフト依頼を組み立てる。
//
// 手順は「レシピを指定 → 素材を消費 → 出来上がり枠から手持ちへ移す」。
// 素材の消費では、そのスロットの StackNetworkID を正しく載せないと弾かれる。
func (s *session) craftRequestLocked(rec craftRecipe, requestID int32) (*protocol.ItemStackRequest, error) {
	// レシピブックから作る形。素材はサーバーが手持ちから自動で集める。
	// 枠へ自分で移す形も試したが、置く段階で拒否される(CannotPlaceItem)。
	ingredients := make([]protocol.ItemDescriptorCount, 0, len(rec.Inputs))
	for _, in := range rec.Inputs {
		ingredients = append(ingredients, protocol.ItemDescriptorCount{
			Descriptor: &protocol.DefaultItemDescriptor{Name: "minecraft:" + in.Name},
			Count:      int32(in.Count),
		})
	}

	// 素材が足りるかはこちらでも見る。足りないまま送ると理由が分からない。
	for _, in := range rec.Inputs {
		have := 0
		for _, item := range s.rawSlots {
			if name, ok := s.itemNames[item.Stack.ItemType.NetworkID]; ok && name == in.Name {
				have += int(item.Stack.Count)
			}
		}
		if have < in.Count {
			return nil, fmt.Errorf("%s が %d 個足りません", in.Name, in.Count-have)
		}
	}

	actions := []protocol.StackRequestAction{
		&protocol.AutoCraftRecipeStackRequestAction{
			RecipeNetworkID: rec.NetworkID,
			NumberOfCrafts:  1,
			Ingredients:     ingredients,
		},
		&protocol.CraftResultsDeprecatedStackRequestAction{
			ResultItems: []protocol.StackRequestItem{{
				Identifier: "minecraft:" + rec.Output,
				Count:      uint16(rec.OutputCount),
			}},
			TimesCrafted: 1,
		},
	}

	// 素材を実際に減らす申告。これが無いと
	// ExpectedAnywhereItemNotFullyConsumed(19) で拒否される。
	// サーバーが自動で集めてくれるのは「どこから取るか」の話で、
	// 減らす分の申告はこちらの責任。
	// 消費の申告。これが無いと ExpectedAnywhereItemNotFullyConsumed(19) になる。
	for _, in := range rec.Inputs {
		remaining := in.Count
		for slot, item := range s.rawSlots {
			if remaining <= 0 {
				break
			}
			name, ok := s.itemNames[item.Stack.ItemType.NetworkID]
			if !ok || name != in.Name {
				continue
			}
			use := int(item.Stack.Count)
			if use > remaining {
				use = remaining
			}
			actions = append(actions, &protocol.ConsumeStackRequestAction{
				DestroyStackRequestAction: protocol.DestroyStackRequestAction{
					Count: byte(use),
					Source: protocol.StackRequestSlotInfo{
						Container:      protocol.FullContainerName{ContainerID: inventoryContainerFor(slot)},
						Slot:           byte(slot),
						StackNetworkID: item.StackNetworkID,
					},
				},
			})
			remaining -= use
		}
	}

	// 切り分け用。取り出しを外すと、作る部分だけの可否が分かる。
	if os.Getenv("BEDROCK_CRAFT_NO_TAKE") == "1" {
		return &protocol.ItemStackRequest{RequestID: requestID, Actions: actions}, nil
	}

	dest, ok := s.freeSlotLocked()
	if !ok {
		return nil, fmt.Errorf("持ち物に空きがありません")
	}
	// 移動系のアクションは埋め込みが非公開なので、リテラルではなく代入で組む。
	take := &protocol.TakeStackRequestAction{}
	take.Count = byte(rec.OutputCount)
	take.Source = protocol.StackRequestSlotInfo{
		Container: protocol.FullContainerName{ContainerID: protocol.ContainerCreatedOutput},
		// 出来上がりは常に 50 番。固定値。
		Slot:           50,
		StackNetworkID: 0,
	}
	take.Destination = protocol.StackRequestSlotInfo{
		Container:      protocol.FullContainerName{ContainerID: inventoryContainerFor(dest)},
		Slot:           byte(dest),
		StackNetworkID: 0,
	}
	actions = append(actions, take)

	return &protocol.ItemStackRequest{RequestID: requestID, Actions: actions}, nil
}

// inventoryContainerFor は持ち物のスロット番号に対応するコンテナIDを返す。
// 0..8 はホットバー、9..35 が本体。まとめて扱う ID もあるが、
// サーバーによっては区別を要求する。
func inventoryContainerFor(slot int) byte {
	if slot >= 0 && slot <= 8 {
		return protocol.ContainerHotBar
	}
	return protocol.ContainerInventory
}

// freeSlotLocked は出来上がりを入れる空きスロットを探す。
// 同じ物が既にある枠へ足す方が自然だが、上限の判定が要るので空きを優先する。
func (s *session) freeSlotLocked() (int, bool) {
	for i := 0; i < 36; i++ {
		if _, used := s.rawSlots[i]; !used {
			return i, true
		}
	}
	return 0, false
}
