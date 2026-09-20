package main

// クラフト。
//
// 統合版は server_authoritative_inventory なので、インベントリを直接いじる形では
// なく ItemStackRequest でサーバーに依頼する。レシピはサーバーが接続時に
// CraftingData で全部送ってくるので、それを出来上がる物の名前で引けるようにする。
//
// 作業台が無いときは 2x2 の枠しか使えない。3x3 のレシピは弾く。
//
// 手順は「枠へ置く → 作る → 枠の消費を申告 → 出来上がりを取る」。
// サーバーはクラフト枠の中身を実際に見てレシピと突き合わせるので、枠を
// 素通りしてレシピだけ指定しても通らない。枠の番号は 2x2 が 28..31、
// 3x3 が 32..40。
//
// 肝は StackNetworkID の扱い。同じ要求の中で新しくできたスタック
// (枠に置いた素材、出来上がった物)は、リクエストIDを識別子として指す。
// 0 を入れると FailedToValidateSrcSlot で拒否される。
//
// クラフトの結果は ItemStackResponse で返り、InventorySlot では来ない。
// しかも応答にアイテムの種類は入っていないので、持ち物の写しはこちらで直す。

import (
	"fmt"
	"strings"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// クラフト枠の先頭番号。
// 28/32 でも通る実装があるが、vanilla は 0 起点を要求する。
const (
	craftingInputBase2x2 byte = 28
	craftingInputBase3x3 byte = 32
)

// craftInput は素材1種。
type craftInput struct {
	// Name は素材そのものの名前。Tag が入っているときは空。
	Name string
	// Tag は「板材ならなんでも」のような素材の指定。棒・作業台・道具の
	// レシピはこの形で来る。名前で1つに決まらないので、実際に何を使うかは
	// クラフトするときに手持ちから選ぶ。
	Tag   string
	Count int
}

// tagMembers はタグに属するかを名前から判定する。
//
// サーバーはタグの中身を送ってこないので、こちらで持つしかない。
// 全部を網羅する必要はなく、序盤の連鎖(棒→作業台→道具→松明)に要るものだけ
// 分かればよい。知らないタグのレシピは取り込まない。
var tagMembers = map[string]func(name string) bool{
	"minecraft:planks": func(n string) bool { return strings.HasSuffix(n, "_planks") },
	"minecraft:logs": func(n string) bool {
		return strings.HasSuffix(n, "_log") || strings.HasSuffix(n, "_wood") ||
			strings.HasSuffix(n, "_stem") || strings.HasSuffix(n, "_hyphae")
	},
	"minecraft:coals":  func(n string) bool { return n == "coal" || n == "charcoal" },
	"minecraft:sticks": func(n string) bool { return n == "stick" },
	"minecraft:stone_crafting_materials": func(n string) bool {
		return n == "cobblestone" || n == "blackstone" || n == "cobbled_deepslate"
	},
	"minecraft:stone_tool_materials": func(n string) bool {
		return n == "cobblestone" || n == "blackstone" || n == "cobbled_deepslate"
	},
	"minecraft:wooden_slabs": func(n string) bool { return strings.HasSuffix(n, "_slab") },
}

// logs_that_burn のように別名で来るものを寄せる。
var tagAliases = map[string]string{
	"minecraft:logs_that_burn":  "minecraft:logs",
	"minecraft:planks_crafting": "minecraft:planks",
}

func normalizeTag(tag string) string {
	if alias, ok := tagAliases[tag]; ok {
		return alias
	}
	return tag
}

// itemMatchesTag はその名前のアイテムがタグに属するか。
func itemMatchesTag(name, tag string) bool {
	if f, ok := tagMembers[normalizeTag(tag)]; ok {
		return f(name)
	}
	return false
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
	// Cells は形のあるレシピの並び。行優先で Width*Height 個。
	// 空の枠は Name も Tag も空。棒のように「板2枚を縦に」といった配置は、
	// 素材の数だけ分かっても再現できない。枠の位置が違うとサーバーは
	// MismatchedRecipeForInputGridItems(35) で拒否する。
	Cells         []craftInput
	Width, Height int
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
		// 形のあるレシピは枠の位置まで合わせないと拒否される。
		rec.Width = int(r.Width)
		rec.Height = int(r.Height)
		if len(rec.Cells) != rec.Width*rec.Height {
			// 記述子の数と縦横が合わない。位置を再現できないので落とす。
			rec.Cells = nil
			rec.Width, rec.Height = 0, 0
		}
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
	// タグ指定の素材。名前と混ざらないよう "tag:" を付けて数える。
	// あわせて枠ごとの中身(Cells)も作る。形のあるレシピはこれが要る。
	cells := make([]craftInput, 0, len(input))
	for _, in := range input {
		var key string
		switch d := in.Descriptor.(type) {
		case *protocol.DefaultItemDescriptor:
			key = strings.TrimPrefix(d.Name, "minecraft:")
		case *protocol.ItemTagItemDescriptor:
			// 中身を知らないタグは扱えない。素材を選べないまま送っても
			// サーバーに弾かれるだけなので、レシピごと落とす。
			if _, known := tagMembers[normalizeTag(d.Tag)]; !known {
				lastReject.NonDefault++
				if lastReject.SampleDesc == "" {
					lastReject.SampleDesc = "tag:" + d.Tag
				}
				return craftRecipe{}, false
			}
			key = "tag:" + normalizeTag(d.Tag)
		case *protocol.InvalidItemDescriptor:
			// 空の枠。形のあるレシピでは意味があるので位置だけ残す。
			cells = append(cells, craftInput{})
			continue
		default:
			// MoLang など。解決できない。
			lastReject.NonDefault++
			if lastReject.SampleDesc == "" {
				lastReject.SampleDesc = fmt.Sprintf("%T", in.Descriptor)
			}
			return craftRecipe{}, false
		}
		if key == "" {
			// 名前の無い記述子も空の枠として扱う。
			cells = append(cells, craftInput{})
			continue
		}
		n := int(in.Count)
		if n <= 0 {
			n = 1
		}
		if tag, ok := strings.CutPrefix(key, "tag:"); ok {
			cells = append(cells, craftInput{Tag: tag, Count: n})
		} else {
			cells = append(cells, craftInput{Name: key, Count: n})
		}
		if _, seen := counts[key]; !seen {
			order = append(order, key)
		}
		counts[key] += n
	}
	rec.Cells = cells
	if len(order) == 0 {
		lastReject.NoInput++
		return craftRecipe{}, false
	}
	for _, key := range order {
		if tag, ok := strings.CutPrefix(key, "tag:"); ok {
			rec.Inputs = append(rec.Inputs, craftInput{Tag: tag, Count: counts[key]})
			continue
		}
		rec.Inputs = append(rec.Inputs, craftInput{Name: key, Count: counts[key]})
	}
	return rec, true
}

// craftRequest は1回ぶんのクラフト依頼を組み立てる。
//
// 手順は「レシピを指定 → 素材を消費 → 出来上がり枠から手持ちへ移す」。
// 素材の消費では、そのスロットの StackNetworkID を正しく載せないと弾かれる。
// 戻り値の []craftInput は、タグを実際の素材に解決したあとの素材表。
// 呼び出し側が「何が減るか」を予測するのに使う。タグのままでは減らせない。
// craftPlan は要求を組んだときに決めた、素材の取り出し元と出来上がりの行き先。
//
// 応答が来たときの写しの更新は、これと同じ枠を使わなければならない。
// 以前は名前だけを渡し、写しの側で「同じ名前の最初の山」から減らし、
// 「同じ名前の山があればそこへ足す」としていた。要求の側は素材を
// rawSlots の走査順(map なので不定)で取り、出来上がりは識別子の分かる山か
// 空き枠を選ぶので、両者は食い違う。実測 2026-09-19 22:08(wood-tool)、
// 拾った棒(識別子 0)があるとき、棒のクラフトは空き枠 S2 へ入ったが写しは
// 拾った山へ足していた。写しに S2 の記録が無いので次の作業台の出来上がりの
// 行き先に S2 を選び、サーバーには埋まっているので
// FailedToValidateDstSlot(50) で7回続けて拒否された。作業台が無いので
// ツルハシも剣もできない。本番でも棒や道具で同じ拒否が出ている。
type craftPlan struct {
	// タグを解決したあとの素材表。
	Inputs []craftInput

	// 持ち物の枠ごとに、この要求で取り出す個数。
	Spent map[int]int

	// 出来上がりを入れる持ち物の枠。
	Dest int
}

func (s *session) craftRequestLocked(rec craftRecipe, requestID int32) (*protocol.ItemStackRequest, craftPlan, error) {
	// タグ指定の素材は、手持ちから実際に使うものを1つ決める。
	// 「板材ならなんでも」のまま送っても、サーバーには何を消費するのか
	// 伝わらない。持っている種類のうち数が足りるものを選ぶ。
	resolved := make([]craftInput, 0, len(rec.Inputs))
	for _, in := range rec.Inputs {
		if in.Tag == "" {
			resolved = append(resolved, in)
			continue
		}
		counts := map[string]int{}
		for _, item := range s.rawSlots {
			name, ok := s.itemNames[item.Stack.ItemType.NetworkID]
			if !ok || !itemMatchesTag(name, in.Tag) {
				continue
			}
			counts[name] += int(item.Stack.Count)
		}
		pick := ""
		for name, have := range counts {
			if have >= in.Count {
				pick = name
				break
			}
		}
		if pick == "" {
			return nil, craftPlan{}, fmt.Errorf("%s に使える素材が %d 個ありません", in.Tag, in.Count)
		}
		resolved = append(resolved, craftInput{Name: pick, Count: in.Count})

		// 枠側にも同じ選択を反映する。枠ごとに別の木材を選ぶと形が崩れる。
		// rec は値渡しなので、書き換えても登録済みのレシピには影響しない。
		if len(rec.Cells) > 0 {
			cells := make([]craftInput, len(rec.Cells))
			copy(cells, rec.Cells)
			for i := range cells {
				if cells[i].Tag == in.Tag {
					cells[i] = craftInput{Name: pick, Count: cells[i].Count}
				}
			}
			rec.Cells = cells
		}
	}
	rec.Inputs = resolved

	// 素材が足りるかは先に見る。足りないまま送っても理由が返らない。
	for _, in := range rec.Inputs {
		have := 0
		for _, item := range s.rawSlots {
			if name, ok := s.itemNames[item.Stack.ItemType.NetworkID]; ok && name == in.Name {
				have += int(item.Stack.Count)
			}
		}
		if have < in.Count {
			return nil, craftPlan{}, fmt.Errorf("%s が %d 個足りません", in.Name, in.Count-have)
		}
	}

	// サーバーはクラフト枠の中身をレシピと突き合わせる。まず枠へ移す。
	// 枠の番号は 2x2 が 28..31、3x3 が 32..40。行優先で並ぶ。
	var actions []protocol.StackRequestAction
	base := craftingInputBase2x2
	gridWidth := 2
	if rec.NeedsTable {
		base = craftingInputBase3x3
		gridWidth = 3
	}

	// 1つ枠へ移す。使ったぶんは残数から引く。
	// 同じ持ち物スロットを2回使うと数が合わなくなるので、使用量を控える。
	spent := map[int]int{}
	// 実際に置いた枠。消費の申告はここに置いたものだけを対象にする。
	// 形のあるレシピは枠が飛び飛びになるので、範囲では表せない。
	var filled []byte
	placeOne := func(want craftInput, dstSlot byte) bool {
		remaining := want.Count
		if remaining <= 0 {
			remaining = 1
		}
		for slot, item := range s.rawSlots {
			if remaining <= 0 {
				break
			}
			name, ok := s.itemNames[item.Stack.ItemType.NetworkID]
			if !ok {
				continue
			}
			if want.Name != "" && name != want.Name {
				continue
			}
			if want.Tag != "" && !itemMatchesTag(name, want.Tag) {
				continue
			}
			avail := int(item.Stack.Count) - spent[slot]
			if avail <= 0 {
				continue
			}
			use := min(avail, remaining)
			// 同じスロットから2回目以降を取り出すときは、元の識別子では指せない。
			// 1回目の取り出しでそのスタックの識別子が変わるため、古いものを
			// 送ると FailedToValidateSrcSlot(49) になる。同一要求の中で
			// 変化したスタックはリクエストIDで指す決まり。
			// 木のツルハシは板3枚を同じスロットから取るので必ず踏む。
			srcID := item.StackNetworkID
			if spent[slot] > 0 {
				srcID = requestID
			}
			place := &protocol.PlaceStackRequestAction{}
			place.Count = byte(use)
			place.Source = protocol.StackRequestSlotInfo{
				Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory},
				Slot:           byte(slot),
				StackNetworkID: srcID,
			}
			place.Destination = protocol.StackRequestSlotInfo{
				Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCraftingInput},
				Slot:           dstSlot,
				StackNetworkID: 0,
			}
			actions = append(actions, place)
			spent[slot] += use
			remaining -= use
		}
		if remaining <= 0 {
			filled = append(filled, dstSlot)
			return true
		}
		return false
	}

	if len(rec.Cells) > 0 && rec.Width > 0 {
		// 形のあるレシピ。枠の位置まで合わせる。左上に寄せて置く。
		// 素材の数だけ合わせて先頭から詰めると、棒(板2枚を縦)のように
		// 並びに意味があるものが MismatchedRecipeForInputGridItems で拒否される。
		for row := 0; row < rec.Height; row++ {
			for col := 0; col < rec.Width; col++ {
				cell := rec.Cells[row*rec.Width+col]
				if cell.Name == "" && cell.Tag == "" {
					continue
				}
				dst := base + byte(row*gridWidth+col)
				if !placeOne(cell, dst) {
					return nil, craftPlan{}, fmt.Errorf("枠に置く素材が足りません")
				}
			}
		}
	} else {
		// 形を問わないレシピ。先頭から順に詰めてよい。
		slot := base
		for _, in := range rec.Inputs {
			if !placeOne(in, slot) {
				return nil, craftPlan{}, fmt.Errorf("枠に置く素材が足りません")
			}
			slot++
		}
	}

	actions = append(actions, &protocol.CraftRecipeStackRequestAction{
		RecipeNetworkID: rec.NetworkID,
		NumberOfCrafts:  1,
	})

	// 枠へ置いた分が消えることの申告。これが無いと
	// ExpectedItemSlotNotFullyConsumed(18) で拒否される。
	// 同じ要求の中で新しくできたスタックは、リクエストIDを識別子として指す。
	// 取り出し元(出来上がり枠)でも同じ規則。
	for _, slot := range filled {
		actions = append(actions, &protocol.ConsumeStackRequestAction{
			DestroyStackRequestAction: protocol.DestroyStackRequestAction{
				Count: 1,
				Source: protocol.StackRequestSlotInfo{
					Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCraftingInput},
					Slot:           slot,
					StackNetworkID: requestID,
				},
			},
		})
	}

	dest, destStackID, ok := s.outputSlotLocked(rec.Output, spent)
	if !ok {
		return nil, craftPlan{}, fmt.Errorf("持ち物に空きがありません")
	}

	// 出来上がりを持ち物へ移す。
	// 取り出し元の StackNetworkID にはリクエストIDを入れる決まりになっている。
	take := &protocol.TakeStackRequestAction{}
	take.Count = byte(rec.OutputCount)
	take.Source = protocol.StackRequestSlotInfo{
		Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCreatedOutput},
		Slot:           0x32,
		StackNetworkID: requestID,
	}
	take.Destination = protocol.StackRequestSlotInfo{
		Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory},
		Slot:           byte(dest),
		StackNetworkID: destStackID,
	}
	actions = append(actions, take)

	return &protocol.ItemStackRequest{RequestID: requestID, Actions: actions},
		craftPlan{Inputs: rec.Inputs, Spent: spent, Dest: dest}, nil
}

// freeSlotLocked は出来上がりを入れる空きスロットを探す。
// 同じ物が既にある枠へ足す方が自然だが、上限の判定が要るので空きを優先する。
func (s *session) freeSlotLocked() (int, bool) {
	for i := 0; i < 36; i++ {
		// 中身が空になったスロットは写しに残ることがある。鍵の有無だけで
		// 判定すると、実際は空いている枠を使えず「持ち物に空きがありません」
		// になる。数まで見る。
		if it, used := s.rawSlots[i]; !used || it.Stack.Count == 0 {
			return i, true
		}
	}
	return 0, false
}

// outputSlotLocked は出来上がりの行き先を選ぶ。
//
// 同じ物が既にある枠へ重ねるのを優先する。空き枠だけを狙うと、写しが
// 古いときに埋まっている枠を指してしまい FailedToValidateDstSlot(50) で
// 拒否される。板を続けて作ると2回目で必ず起きていた。
// used には、この要求の中で素材を取り出したスロットを渡す。そこを行き先に
// すると、サーバーが「取り出し元と行き先が同じ」と見て
// DstContainerAndSlotEqualToSrcContainerAndSlot(48) で拒否する。
func (s *session) outputSlotLocked(outputName string, used map[int]int) (int, int32, bool) {
	for i := 0; i < 36; i++ {
		if used[i] > 0 {
			continue
		}
		it, ok := s.rawSlots[i]
		if !ok || it.Stack.Count == 0 {
			continue
		}
		name, ok := s.itemNames[it.Stack.ItemType.NetworkID]
		if ok && name == outputName && int(it.Stack.Count) < 64 {
			// 既にある山へ重ねるときは、その山の識別子を載せる必要がある。
			// 0 のままだと「空き枠へ置く」ことになり、実際は埋まっているので
			// FailedToValidateDstSlot(50) で拒否される。
			//
			// ただし識別子が 0 の山は、こちらがクラフト後に自前で足したもので
			// サーバーの値を知らない。そこへ重ねようとすると必ず弾かれるので、
			// 空き枠を使う。板を続けて作ると2回目で必ず踏んでいた。
			if it.StackNetworkID == 0 {
				continue
			}
			return i, it.StackNetworkID, true
		}
	}
	for i := 0; i < 36; i++ {
		if used[i] > 0 {
			continue
		}
		if it, ok := s.rawSlots[i]; !ok || it.Stack.Count == 0 {
			return i, 0, true
		}
	}
	return 0, 0, false
}
