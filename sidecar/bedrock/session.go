package main

// 接続後のセッション。標準入力から改行区切りJSONでコマンドを受け、
// 状態の変化と結果を標準出力へ流す。TypeScript 側の BedrockDriver が
// この向こう側にいる。
//
// 統合版はサーバー権限型だが、クライアントが自分で動いた先を予測して送る前提の
// 設計になっている。予測を送らずに補正だけ待つと補正の刻みぶんしか進まない。
// 楽観的に進めておき、外れたら CorrectPlayerMovePrediction を正として取り込む。

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-gl/mathgl/mgl32"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// 受け取るコマンド。id は結果を対応付けるためのもの。
type command struct {
	ID      int     `json:"id"`
	Cmd     string  `json:"cmd"`
	X       float32 `json:"x"`
	Y       float32 `json:"y"`
	Z       float32 `json:"z"`
	Yaw     float32 `json:"yaw"`
	Pitch   float32 `json:"pitch"`
	Range   float32 `json:"range"`
	State   string  `json:"state"`
	Value   bool    `json:"value"`
	Message string  `json:"message"`
	Timeout int     `json:"timeoutMs"`
	// ブロック探索用
	Names []string `json:"names"`
	Count int      `json:"count"`
	// 設置する面。-1 ならプレイヤー側の面を自動で選ぶ。
	Face int32 `json:"face"`
}

// 統合版のプレイヤー座標は「足元 + 目線の高さ」で送られてくる。
// ブロックを引くときは必ず引き算すること。これを忘れると足場判定が2ブロック
// ずれ、経路探索も採掘対象も全部おかしくなる。
const eyeHeight = float32(1.62)

// 攻撃が届く距離。バニラのプレイヤーは3ブロックほど。
const attackReach = float32(3.5)

// 1tick あたりの移動量。バニラの歩行 4.317 ブロック/秒、走行 5.612 ブロック/秒。
const (
	walkSpeed   = float32(0.2159)
	sprintSpeed = float32(0.2806)
)

type entityInfo struct {
	RuntimeID uint64
	UniqueID  int64
	Name      string
	Type      string
	IsPlayer  bool
	Pos       mgl32.Vec3
}

// digTask は進行中の採掘。統合版の採掘はサーバー権限型で、
// 「開始 → 毎tick継続」を送り続け、壊れたかどうかはサーバーの UpdateBlock で知る。
type digTask struct {
	id       int
	pos      protocol.BlockPos
	face     int32
	started  bool
	deadline time.Time
}

// 到達目標。tick ループが毎回参照して進路を決める。
type target struct {
	id        int
	x, z      float32
	tolerance float32
	deadline  time.Time
	// 進んでいないことを検出して自動ジャンプするための記録
	lastPos      mgl32.Vec3
	stalledTicks int
	// 経路。空なら真っ直ぐ向かう(近距離や、道が見つからなかったとき)。
	path []step
	// 今の1歩で待っている下ごしらえ(掘る/置く)。終わるまで前進しない。
	waiting bool
	// 経路を引き直した時刻。地形の読み込みが進むと道が見つかることがある。
	lastPlan time.Time
}

type session struct {
	conn *minecraft.Conn
	game minecraft.GameData

	mu       sync.Mutex
	pos      mgl32.Vec3
	yaw      float32
	pitch    float32
	onGround bool
	// 跳躍中の縦速度。予測に入れないと、跳んだつもりでも位置が上がらず、
	// 1段の段差すら登れない(掘った穴から出られない)。
	vy       float32
	airborne bool
	health   float32
	food     float32
	controls map[string]bool
	entities map[uint64]*entityInfo
	unique   map[int64]uint64 // RemoveActor は unique ID で来る
	goal     *target

	// 送った位置の履歴。補正は数tick前のものが返ってくるので、その時点の
	// 自分の予測と突き合わせて「ずれ」だけを求めるために要る。
	// start_game の rewind_history_size が 40 なので、それを覆う長さにする。
	history     [64]mgl32.Vec3
	historyTick [64]uint64
	// 診断用。補正がどれだけ来て、どれだけ引き戻されたか。
	corrections int
	driftTotal  float32
	ticksSent   uint64
	// 補正の tick が履歴と噛み合ったか。噛み合わないなら丸ごと差し替えており、
	// その間に進んだぶんを毎回捨てていることになる。
	histHits   int
	histMisses int
	maxDrift   float32

	// インベントリ。パケットは network ID しか持たないので、StartGame の
	// アイテム表で名前に戻す。
	itemNames map[int32]string
	slots     []invSlot
	// 設置に使うため、スロットの生データも持つ。手に持つアイテムは
	// UseItemTransactionData にそのまま載せる必要がある。
	rawSlots map[int]protocol.ItemInstance
	heldSlot int32

	// チャンクの中身は最初の1回だけ報告する。毎チャンク出すと読めない。
	chunkReported bool
	// サーバーから存在を知らされた列と、その次元。
	known map[[2]int32]int32
	// 要求済みの (列, 高さ区画) の組。移動で高さが変われば取り直す。
	requested map[[3]int32]bool
	// 受け取ったブロック。ワールド読み取りの土台。
	world *world
	// 進行中の採掘。tick ループが毎回 BlockActions を積む。
	digging *digTask
	// 次の tick で送る設置。統合版の設置は player_auth_input に載せる。
	pendingPlace *protocol.UseItemTransactionData

	// レシピ。サーバーが接続時に全部送ってくる。出来上がる物の名前で引く。
	recipes map[string][]craftRecipe
	// 進行中のクラフト。応答は ItemStackResponse で返ってくる。
	// リクエストIDは -1, -3, -5 ... と負の奇数を減らしていく決まり。
	craftReqID  int32
	craftWaiter map[int32]int

	done chan struct{}
	once sync.Once
}

type invSlot struct {
	Slot  int
	Name  string
	Count int
}

func newSession(conn *minecraft.Conn, game minecraft.GameData) *session {
	names := make(map[int32]string, len(game.Items))
	for _, it := range game.Items {
		names[int32(it.RuntimeID)] = strings.TrimPrefix(it.Name, "minecraft:")
	}
	return &session{
		itemNames:   names,
		conn:        conn,
		game:        game,
		pos:         mgl32.Vec3{game.PlayerPosition[0], game.PlayerPosition[1], game.PlayerPosition[2]},
		yaw:         game.Yaw,
		pitch:       game.Pitch,
		health:      20,
		food:        20,
		controls:    map[string]bool{},
		entities:    map[uint64]*entityInfo{},
		known:       map[[2]int32]int32{},
		requested:   map[[3]int32]bool{},
		rawSlots:    map[int]protocol.ItemInstance{},
		world:       newWorld(),
		unique:      map[int64]uint64{},
		recipes:     map[string][]craftRecipe{},
		craftReqID:  1, // 最初の -2 で -1 になる
		craftWaiter: map[int32]int{},
		done:        make(chan struct{}),
	}
}

func (s *session) close(reason string) {
	s.once.Do(func() {
		emit(event{Event: "end", Data: map[string]any{"reason": reason}})
		close(s.done)
	})
}

// serve は接続が切れるか標準入力が閉じるまで動き続ける。
func (s *session) serve(ctx context.Context) {
	go s.readPackets()
	go s.tick()
	go s.readCommands()
	go s.requestLoop()

	// StartGame の座標はチャンクが読み込まれるまでの仮値で、Y に 32768 付近の
	// 番兵が入っていることがある。そのまま歩かせると落下中に動かすことになり
	// 移動がまともに進まないので、実位置が来るまで待つ。
	s.waitForRealPosition(10 * time.Second)

	s.mu.Lock()
	feet := s.feetLocked()
	s.mu.Unlock()
	emit(event{Event: "ready_to_act", Data: map[string]any{
		"entityRuntimeID": s.game.EntityRuntimeID,
		"position":        vec(feet),
	}})

	select {
	case <-ctx.Done():
		s.close("コンテキストの終了")
	case <-s.done:
	}
}

func vec(v mgl32.Vec3) []float32 { return []float32{v[0], v[1], v[2]} }

// feetLocked は足元の座標。ブロック空間の計算はすべてこちらを使う。
// 呼び出し側が mu を持つこと。
func (s *session) feetLocked() mgl32.Vec3 {
	return mgl32.Vec3{s.pos[0], s.pos[1] - eyeHeight, s.pos[2]}
}

func (s *session) readPos() mgl32.Vec3 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pos
}

// waitForRealPosition は仮の座標が本物に置き換わるのを待つ。
// 併せて着地も待つので、歩き出しが落下中にならない。
func (s *session) waitForRealPosition(limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		y, grounded := s.pos[1], s.onGround
		s.mu.Unlock()
		// 仮値でなく、かつ着地していれば動かしてよい。
		if y < 1000 && grounded {
			return
		}
		select {
		case <-s.done:
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// --- 受信 ---

func (s *session) readPackets() {
	for {
		pk, err := s.conn.ReadPacket()
		if err != nil {
			s.close(fmt.Sprintf("接続が切れた: %v", err))
			return
		}
		s.handle(pk)
	}
}

func (s *session) handle(pk packet.Packet) {
	switch v := pk.(type) {
	case *packet.CorrectPlayerMovePrediction:
		s.mu.Lock()
		corrected := mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]}
		slot := v.Tick % uint64(len(s.history))
		if s.historyTick[slot] == v.Tick {
			// 補正が指す tick の予測と比べ、ずれたぶんだけ今の位置に反映する。
			// 丸ごと差し替えると、その tick 以降に進んだぶんを毎回捨てることになり、
			// 歩行速度がバニラの3割程度まで落ちる。
			drift := corrected.Sub(s.history[slot])
			s.pos = s.pos.Add(drift)
			s.driftTotal += drift.Len()
			s.histHits++
			if d := drift.Len(); d > s.maxDrift {
				s.maxDrift = d
			}
		} else {
			// 履歴が流れているほど古い補正。素直に従う。
			s.driftTotal += corrected.Sub(s.pos).Len()
			s.histMisses++
			s.pos = corrected
		}
		s.corrections++
		s.onGround = v.OnGround
		if v.OnGround {
			s.airborne = false
			s.vy = 0
		}
		s.mu.Unlock()

	case *packet.MovePlayer:
		if v.EntityRuntimeID == s.game.EntityRuntimeID {
			s.mu.Lock()
			s.pos = mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]}
			s.mu.Unlock()
		} else {
			s.updateEntityPos(v.EntityRuntimeID, v.Position)
		}

	case *packet.SetHealth:
		s.mu.Lock()
		s.health = float32(v.Health)
		s.mu.Unlock()

	case *packet.UpdateAttributes:
		if v.EntityRuntimeID != s.game.EntityRuntimeID {
			return
		}
		s.mu.Lock()
		for _, a := range v.Attributes {
			switch a.Name {
			case "minecraft:health":
				s.health = a.Value
			case "minecraft:player.hunger":
				s.food = a.Value
			}
		}
		s.mu.Unlock()

	case *packet.AddPlayer:
		s.mu.Lock()
		s.entities[v.EntityRuntimeID] = &entityInfo{
			RuntimeID: v.EntityRuntimeID,
			UniqueID:  v.AbilityData.EntityUniqueID,
			Name:      v.Username,
			Type:      "player",
			IsPlayer:  true,
			// 他プレイヤーの座標も「足元+目線」で届く。揃えて足元にする。
			Pos: mgl32.Vec3{v.Position[0], v.Position[1] - eyeHeight, v.Position[2]},
		}
		s.unique[v.AbilityData.EntityUniqueID] = v.EntityRuntimeID
		s.mu.Unlock()

	case *packet.AddItemActor:
		// 落ちているアイテム。統合版は近づけば勝手に拾うので、
		// 「どこに何が落ちているか」が分かれば回収できる。
		name := "item"
		s.mu.Lock()
		if n, ok := s.itemNames[v.Item.Stack.ItemType.NetworkID]; ok {
			name = n
		}
		s.entities[v.EntityRuntimeID] = &entityInfo{
			RuntimeID: v.EntityRuntimeID,
			UniqueID:  v.EntityUniqueID,
			Name:      name,
			Type:      "item",
			Pos:       mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]},
		}
		s.unique[v.EntityUniqueID] = v.EntityRuntimeID
		s.mu.Unlock()

	case *packet.AddActor:
		s.mu.Lock()
		s.entities[v.EntityRuntimeID] = &entityInfo{
			RuntimeID: v.EntityRuntimeID,
			UniqueID:  v.EntityUniqueID,
			Name:      strings.TrimPrefix(v.EntityType, "minecraft:"),
			Type:      strings.TrimPrefix(v.EntityType, "minecraft:"),
			Pos:       mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]},
		}
		s.unique[v.EntityUniqueID] = v.EntityRuntimeID
		s.mu.Unlock()

	case *packet.RemoveActor:
		s.mu.Lock()
		if rid, ok := s.unique[v.EntityUniqueID]; ok {
			delete(s.entities, rid)
			delete(s.unique, v.EntityUniqueID)
		}
		s.mu.Unlock()

	case *packet.MoveActorAbsolute:
		s.updateEntityPos(v.EntityRuntimeID, v.Position)

	case *packet.Text:
		// 自分の発言もサーバーから返ってくるので、送信者で切り分ける。
		// オフラインのサーバーでは XUID が全員空になるため、XUID 同士の比較だけだと
		// 他人の発言まで自分のものと誤判定する。空のときは表示名で見る。
		source := strings.ReplaceAll(v.SourceName, "§r", "")
		me := s.conn.IdentityData()
		self := false
		if v.XUID != "" && me.XUID != "" {
			self = v.XUID == me.XUID
		} else if source != "" {
			self = source == me.DisplayName
		}
		emit(event{Event: "chat", Data: map[string]any{
			"type":    v.TextType,
			"source":  source,
			"message": v.Message,
			"xuid":    v.XUID,
			"self":    self,
		}})

	case *packet.LevelChunk:
		// この版のサーバーはチャンク本体を勝手に送らない。SubChunkCount が 0 なら
		// 「要求モード」で、こちらが SubChunkRequest を出して初めて中身が届く。
		if v.SubChunkCount == 0 {
			// 座標が確定する前に要求すると、存在しない高さを取りに行くことになる。
			// 列を覚えておいて、要求は別のループに任せる。
			s.mu.Lock()
			s.known[[2]int32{v.Position.X(), v.Position.Z()}] = v.Dimension
			s.mu.Unlock()
			return
		}
		s.storeChunk(v.Position.X(), v.Position.Z(), int(v.SubChunkCount), v.RawPayload)

	case *packet.SubChunk:
		for _, e := range v.SubChunkEntries {
			payload, ok := e.RawPayload.Value()
			if !ok || len(payload) == 0 {
				continue
			}
			// SubChunk の Position は要求の中心。実際の列は Offset を足した先。
			cx := v.Position.X() + int32(e.Offset[0])
			cz := v.Position.Z() + int32(e.Offset[2])
			s.storeChunk(cx, cz, 1, payload)
		}

	case *packet.UpdateBlock:
		// 掘った/置いた結果はここで返ってくる。取り込まないと完了を判定できず、
		// スナップショットも古いままになる。レイヤー0(通常のブロック)だけ見る。
		if v.Layer != 0 {
			return
		}
		name, ok := blockNameFor(int32(v.NewBlockRuntimeID))
		if !ok {
			return
		}
		s.mu.Lock()
		s.world.setBlock(int32(v.Position[0]), int32(v.Position[1]), int32(v.Position[2]), name)
		s.mu.Unlock()

	case *packet.InventoryContent:
		// WindowID 0 がプレイヤー自身の持ち物。
		if v.WindowID != 0 {
			return
		}
		s.mu.Lock()
		s.slots = s.slots[:0]
		clear(s.rawSlots)
		for i, item := range v.Content {
			if it, ok := s.itemLocked(item); ok {
				it.Slot = i
				s.slots = append(s.slots, it)
				s.rawSlots[i] = item
			}
		}
		s.mu.Unlock()

	case *packet.InventorySlot:
		if v.WindowID != 0 {
			return
		}
		s.mu.Lock()
		slot := int(v.Slot)
		kept := s.slots[:0]
		for _, x := range s.slots {
			if x.Slot != slot {
				kept = append(kept, x)
			}
		}
		s.slots = kept
		delete(s.rawSlots, slot)
		if it, ok := s.itemLocked(v.NewItem); ok {
			it.Slot = slot
			s.slots = append(s.slots, it)
			s.rawSlots[slot] = v.NewItem
		}
		s.mu.Unlock()

	case *packet.CraftingData:
		recipes := collectRecipes(v)
		s.mu.Lock()
		// 出来上がる物の名前はアイテム表で引く。レシピ側は実行時IDしか持たない。
		named := map[string][]craftRecipe{}
		for _, r := range recipes {
			name, ok := s.itemNames[r.outputNetworkID]
			if !ok {
				continue
			}
			r.Output = name
			named[name] = append(named[name], r)
		}
		s.recipes = named
		s.mu.Unlock()
		emit(event{Event: "recipes", Data: map[string]any{
			"count":     len(named),
			"raw":       len(recipes),
			"shapeless": len(v.ShapelessRecipes),
			"shaped":    len(v.ShapedRecipes),
			// 拾えなかったもの。タグ指定のレシピと、作業台以外の設備のもの。
			"skippedTagged": lastReject.NonDefault,
			"skippedOther":  lastReject.OtherBlock,
		}})

	case *packet.ItemStackResponse:
		for _, r := range v.Responses {
			s.mu.Lock()
			id, waiting := s.craftWaiter[r.RequestID]
			if waiting {
				delete(s.craftWaiter, r.RequestID)
			}
			s.mu.Unlock()
			if !waiting {
				continue
			}
			if r.Status == protocol.ItemStackResponseStatusOK {
				s.reply(id, true, "", nil)
			} else {
				s.reply(id, false, fmt.Sprintf("クラフトが拒否されました(status=%d)", r.Status), nil)
			}
		}

	case *packet.PacketViolationWarning:
		// サーバーが「そのパケットは不正だ」と教えてくれている。
		// 握り潰すと、切断理由が "context canceled" としか分からなくなる。
		emit(event{Event: "violation", Data: map[string]any{
			"packetID": v.PacketID,
			"type":     v.Type,
			"severity": v.Severity,
			"context":  v.ViolationContext,
		}})

	case *packet.Disconnect:
		s.close(fmt.Sprintf("サーバーから切断: %s", v.Message))
	}
}

// itemLocked は network ID を名前に戻す。空スロットは ok=false。
// 呼び出し側が mu を持つこと。
func (s *session) itemLocked(item protocol.ItemInstance) (invSlot, bool) {
	nid := item.Stack.ItemType.NetworkID
	if nid == 0 || item.Stack.Count == 0 {
		return invSlot{}, false
	}
	name, ok := s.itemNames[nid]
	if !ok {
		name = fmt.Sprintf("unknown_%d", nid)
	}
	return invSlot{Name: name, Count: int(item.Stack.Count)}, true
}

func (s *session) updateEntityPos(rid uint64, p mgl32.Vec3) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.entities[rid]; ok {
		e.Pos = p
	}
}

// --- 送信 ---

// tick は20Hzで player_auth_input を送り続ける。これを止めると
// サーバーから見て「操作していないプレイヤー」になり、以降の入力が通らない。
func (s *session) tick() {
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	var n uint64
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		n++
		s.checkDig()
		if err := s.conn.WritePacket(s.buildInput(n)); err != nil {
			s.close(fmt.Sprintf("入力の送信に失敗: %v", err))
			return
		}
	}
}

func (s *session) buildInput(n uint64) *packet.PlayerAuthInput {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 入力フラグはゼロ値だとフィールドごと送られない。空集合とは別物なので
	// 必ず NewInputFlags を通す。
	pk := &packet.PlayerAuthInput{}
	flags := protocol.NewInputFlags(packet.InputFlagCount)
	move := mgl32.Vec2{}
	delta := mgl32.Vec3{}

	s.steerLocked(n)

	if s.controls["forward"] {
		flags.Set(packet.InputFlagUp)
		move[1] += 1
	}
	if s.controls["back"] {
		flags.Set(packet.InputFlagDown)
		move[1] -= 1
	}
	if s.controls["left"] {
		flags.Set(packet.InputFlagLeft)
		move[0] -= 1
	}
	if s.controls["right"] {
		flags.Set(packet.InputFlagRight)
		move[0] += 1
	}
	if s.controls["jump"] {
		flags.Set(packet.InputFlagJumping)
		flags.Set(packet.InputFlagStartJumping)
	}
	if s.controls["sneak"] {
		flags.Set(packet.InputFlagSneaking)
		flags.Set(packet.InputFlagSneakDown)
	}
	if s.controls["sprint"] {
		flags.Set(packet.InputFlagSprinting)
	}

	// 跳躍の縦移動。バニラは初速 0.42、重力 0.08、空気抵抗 0.98。
	// 正確な再現ではないが、サーバーが受理する程度には合っている。
	if s.controls["jump"] && s.onGround && !s.airborne {
		s.vy = 0.42
		s.airborne = true
		flags.Set(packet.InputFlagJumping)
		flags.Set(packet.InputFlagStartJumping)
	}
	if s.airborne {
		s.pos[1] += s.vy
		s.vy = (s.vy - 0.08) * 0.98
		// 落ち切ったら着地とみなす。実際の着地はサーバーの補正で確定する。
		if s.vy < -0.5 {
			s.airborne = false
			s.vy = 0
		}
	}

	// サーバー権限型では、クライアントが自分で動いた先を予測して送る。
	// 補正だけに任せると補正の刻みぶんしか進まず、歩行が極端に遅くなる。
	// 壁にぶつかれば CorrectPlayerMovePrediction が正しい位置へ引き戻すので、
	// 楽観的に進めてよい。縦方向はサーバーの言い値に従う。
	if move[0] != 0 || move[1] != 0 {
		speed := walkSpeed
		if s.controls["sprint"] {
			speed = sprintSpeed
		}
		rad := float64(s.yaw) * math.Pi / 180
		sin, cos := math.Sin(rad), math.Cos(rad)
		// yaw 0 は +Z を向く。前方は (-sin, cos)、右方は (cos, sin)。
		fx := float32(-sin)*move[1] + float32(cos)*move[0]
		fz := float32(cos)*move[1] + float32(sin)*move[0]
		if l := float32(math.Hypot(float64(fx), float64(fz))); l > 0 {
			delta = mgl32.Vec3{fx / l * speed, 0, fz / l * speed}
			s.pos[0] += delta[0]
			s.pos[2] += delta[2]
		}
	}

	// 採掘中は毎tick「継続」を送り続ける。送るのをやめると中断扱いになる。
	if d := s.digging; d != nil {
		action := int32(protocol.PlayerActionCrackBreak)
		if !d.started {
			action = protocol.PlayerActionStartBreak
			d.started = true
		}
		flags.Set(packet.InputFlagPerformBlockActions)
		pk.BlockActions = protocol.Option([]protocol.PlayerBlockAction{{
			Action:   action,
			BlockPos: d.pos,
			Face:     d.face,
		}})
	}

	// 設置は1tickぶんだけ載せる。載せっぱなしにすると毎tick置き続ける。
	if p := s.pendingPlace; p != nil {
		flags.Set(packet.InputFlagPerformItemInteraction)
		pk.ItemInteractionData = protocol.Option(*p)
		s.pendingPlace = nil
	}

	slot := n % uint64(len(s.history))
	s.history[slot] = s.pos
	s.historyTick[slot] = n
	s.ticksSent = n

	pk.Pitch = s.pitch
	pk.Yaw = s.yaw
	pk.HeadYaw = s.yaw
	pk.Position = s.pos
	pk.MoveVector = move
	pk.InputData = flags
	pk.InputMode = packet.InputModeMouse
	pk.PlayMode = packet.PlayModeNormal
	pk.InteractionModel = packet.InteractionModelCrosshair
	pk.Tick = n
	// サーバーは移動量の妥当性を Delta でも見る。空のまま位置だけ進めると
	// 「動いていないのに位置が変わった」と判定されて補正で引き戻される。
	pk.Delta = delta
	return pk
}

// steerLocked は目標があれば向きと前進を設定する。呼び出し側が mu を持つこと。
//
// 経路が引けていればその通過点を順に追い、引けていなければ目標へ真っ直ぐ向かう。
// 真っ直ぐ向かうのは、目の前に道がある短距離と、道が見つからなかったときの
// 最後の手段。障害物があれば進まないので deadline で打ち切られる。
func (s *session) steerLocked(n uint64) {
	g := s.goal
	if g == nil {
		return
	}

	dist := horizontalDist(s.feetLocked(), g.x, g.z)
	if dist <= g.tolerance {
		s.finishGoalLocked(true, "")
		return
	}
	if time.Now().After(g.deadline) {
		s.finishGoalLocked(false, fmt.Sprintf("目標に届かなかった（残り %.1f ブロック）", dist))
		return
	}

	// 経路が尽きた、または一定時間ごとに引き直す。歩くうちに新しい地形が
	// 読み込まれ、さっきは見つからなかった道が見つかることがある。
	//
	// 探索は tick ループの中で走るので、重いと送信間隔が乱れてサーバーに
	// 位置を補正され続ける（実測で 87% → 4% まで落ちた）。上限を低く保ち、
	// 遠い目標は手前の中間地点に切り詰めて、探索が成功しやすい形にする。
	if len(g.path) == 0 && time.Since(g.lastPlan) > planInterval {
		g.lastPlan = time.Now()
		feet := s.feetLocked()
		from := blockPos{
			int32(math.Floor(float64(feet[0]))),
			int32(math.Floor(float64(feet[1]))),
			int32(math.Floor(float64(feet[2]))),
		}
		gx, gz := clampToward(s.feetLocked(), g.x, g.z, planReach)
		to := blockPos{int32(math.Floor(float64(gx))), from.Y, int32(math.Floor(float64(gz)))}
		tol := float64(g.tolerance)
		if dist > planReach {
			// 中間地点なので、そこにぴったり着く必要はない。
			tol = 1
		}
		g.path = s.world.findPath(from, to, tol, planMaxNodes, s.capsLocked())
	}

	// 次の通過点。着いたら捨てて次へ。
	var tx, tz float32
	var stepUp bool
	if len(g.path) > 0 {
		st := g.path[0]
		if horizontalDist(s.feetLocked(), float32(st.Pos.X)+0.5, float32(st.Pos.Z)+0.5) < 0.4 &&
			!g.waiting {
			g.path = g.path[1:]
			if len(g.path) == 0 {
				s.controls["forward"] = false
				return
			}
			st = g.path[0]
		}
		// 掘る/置くが要る歩は、それが済むまで前進しない。
		// 進みながらやると、まだ空いていない穴に突っ込んで弾かれる。
		if !s.prepareStepLocked(st) {
			g.waiting = true
			s.controls["forward"] = false
			s.controls["jump"] = false
			return
		}
		g.waiting = false
		tx, tz = float32(st.Pos.X)+0.5, float32(st.Pos.Z)+0.5
		stepUp = float32(st.Pos.Y) > s.feetLocked()[1]+0.5
	}
	if len(g.path) == 0 {
		tx, tz = g.x, g.z
	}

	// Minecraft の yaw は南(+Z)が0で、西(-X)へ向かって増える。
	dx, dz := tx-s.pos[0], tz-s.pos[2]
	s.yaw = float32(math.Atan2(float64(-dx), float64(dz)) * 180 / math.Pi)
	s.controls["forward"] = true

	// 進んでいなければ段差とみなして跳ぶ。壁なら跳んでも進まないので、
	// その場合は deadline で打ち切られる。
	if n%4 == 0 {
		moved := s.pos.Sub(g.lastPos).Len()
		if moved < 0.05 {
			g.stalledTicks++
		} else {
			g.stalledTicks = 0
		}
		g.lastPos = s.pos
	}
	s.controls["jump"] = stepUp || g.stalledTicks >= 2
}

func (s *session) finishGoalLocked(ok bool, errMsg string) {
	g := s.goal
	if g == nil {
		return
	}
	s.controls["forward"] = false
	s.controls["jump"] = false
	s.goal = nil
	d := map[string]any{"id": g.id, "ok": ok, "position": vec(s.feetLocked())}
	if errMsg != "" {
		d["error"] = errMsg
	}
	emit(event{Event: "result", Data: d})
}

const (
	// 一度の探索で見る節点の上限。tick ループの中で走るので低く抑える。
	planMaxNodes = 800
	// 引き直す間隔。
	planInterval = 2 * time.Second
	// 一度に狙う距離。読み込み済みの範囲(周囲3チャンク)に収まる値にする。
	planReach float32 = 32
)

// clampToward は遠すぎる目標を、その方向の手前の点に切り詰める。
// 読み込んでいない場所へは道を引けないので、探せる範囲に区切って進む。
func clampToward(from mgl32.Vec3, x, z, reach float32) (float32, float32) {
	dx, dz := x-from[0], z-from[2]
	d := float32(math.Hypot(float64(dx), float64(dz)))
	if d <= reach || d == 0 {
		return x, z
	}
	return from[0] + dx/d*reach, from[2] + dz/d*reach
}

func horizontalDist(p mgl32.Vec3, x, z float32) float32 {
	return float32(math.Hypot(float64(x-p[0]), float64(z-p[2])))
}

// --- コマンド ---

func (s *session) readCommands() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var c command
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			emit(event{Event: "error", Error: fmt.Sprintf("コマンドを解釈できない: %v", err)})
			continue
		}
		s.dispatch(c)
	}
	if err := sc.Err(); err != nil && err != io.EOF {
		emit(event{Event: "error", Error: fmt.Sprintf("標準入力の読み取りに失敗: %v", err)})
	}
	s.close("標準入力が閉じた")
}

func (s *session) reply(id int, ok bool, errMsg string, data map[string]any) {
	d := map[string]any{"id": id, "ok": ok}
	if errMsg != "" {
		d["error"] = errMsg
	}
	for k, v := range data {
		d[k] = v
	}
	emit(event{Event: "result", Data: d})
}

func (s *session) dispatch(c command) {
	switch c.Cmd {
	case "goto":
		timeout := c.Timeout
		if timeout <= 0 {
			timeout = 30000
		}
		tol := c.Range
		if tol <= 0 {
			tol = 1
		}
		s.mu.Lock()
		if s.goal != nil {
			// 先の目標は取り消す。呼び出し側は1つずつ出す前提。
			emit(event{Event: "result", Data: map[string]any{
				"id": s.goal.id, "ok": false, "error": "新しい目標で置き換えられた",
			}})
		}
		s.goal = &target{
			id: c.ID, x: c.X, z: c.Z, tolerance: tol,
			deadline: time.Now().Add(time.Duration(timeout) * time.Millisecond),
			lastPos:  s.pos,
		}
		s.mu.Unlock()
		// 結果は到達または時間切れのときに返す。

	case "stop":
		s.mu.Lock()
		if s.goal != nil {
			emit(event{Event: "result", Data: map[string]any{
				"id": s.goal.id, "ok": false, "error": "中断された",
			}})
			s.goal = nil
		}
		s.controls = map[string]bool{}
		s.mu.Unlock()
		s.reply(c.ID, true, "", nil)

	case "control":
		s.mu.Lock()
		s.goal = nil // 手動操作が入ったら自動移動はやめる
		s.controls[c.State] = c.Value
		s.mu.Unlock()
		s.reply(c.ID, true, "", nil)

	case "look":
		s.mu.Lock()
		s.yaw, s.pitch = c.Yaw, c.Pitch
		s.mu.Unlock()
		s.reply(c.ID, true, "", nil)

	case "lookAt":
		s.mu.Lock()
		s.lookAtLocked(c.X, c.Y, c.Z)
		s.mu.Unlock()
		s.reply(c.ID, true, "", nil)

	case "chat":
		err := s.conn.WritePacket(&packet.Text{
			TextType:   packet.TextTypeChat,
			SourceName: s.conn.IdentityData().DisplayName,
			Message:    c.Message,
			XUID:       s.conn.IdentityData().XUID,
		})
		if err != nil {
			s.reply(c.ID, false, fmt.Sprintf("発言の送信に失敗: %v", err), nil)
		} else {
			s.reply(c.ID, true, "", nil)
		}

	case "command":
		// 送ると接続が切れるので、既定では送らない。
		//
		// CommandRequest を公式スキーマ(protocol 2169)通りに組み直しても
		// サーバーは "Command exceeds maximum size of 512 characters." という
		// PacketViolationWarning を返して切断する。gophertunnel の実装は
		// Version を文字列、origin の Type を "player" という文字列で書いており
		// そこは直したが、それでも通らない。原因は未特定。
		//
		// 本番の Realm はチートOFFでコマンドが使えないため実害が無く、
		// 追う価値も低いと判断して保留にしている。検証でアイテムを配るなら
		// サーバーのコンソールから行う:
		//   docker exec onj-bedrock-dev send-command give <名前> dirt 8
		if os.Getenv("BEDROCK_ALLOW_COMMAND") != "1" {
			s.reply(c.ID, false,
				"コマンド送信は無効です（サーバーに拒否され接続が切れるため）。"+
					"試すなら BEDROCK_ALLOW_COMMAND=1 を立ててください", nil)
			return
		}
		err := s.conn.WritePacket(&commandRequest{
			CommandLine:    c.Message,
			OriginType:     commandOriginPlayer,
			UUID:           uuid.New(),
			PlayerUniqueID: s.game.EntityUniqueID,
			Version:        commandVersionLatest,
		})
		if err != nil {
			s.reply(c.ID, false, fmt.Sprintf("コマンドの送信に失敗: %v", err), nil)
		} else {
			s.reply(c.ID, true, "", nil)
		}

	case "state":
		s.mu.Lock()
		d := map[string]any{
			"username": s.conn.IdentityData().DisplayName,
			// 外に出すのは足元。ブロック座標と揃えないと skills/ が扱えない。
			"position": vec(s.feetLocked()),
			"yaw":      s.yaw,
			"pitch":    s.pitch,
			"onGround": s.onGround,
			"health":   s.health,
			"food":     s.food,
			// 移動が伸びない原因を切り分けるための診断値。
			"corrections": s.corrections,
			"driftTotal":  s.driftTotal,
			"ticksSent":   s.ticksSent,
			"pathLen": func() int {
				if s.goal == nil {
					return -1
				}
				return len(s.goal.path)
			}(),
			"waypoint": func() any {
				if s.goal == nil || len(s.goal.path) == 0 {
					return nil
				}
				w := s.goal.path[0]
				return map[string]any{
					"pos":    []int32{w.Pos.X, w.Pos.Y, w.Pos.Z},
					"action": stepName(w.Action),
				}
			}(),
			"histHits":   s.histHits,
			"histMisses": s.histMisses,
			"maxDrift":   s.maxDrift,
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", d)

	case "entities":
		s.mu.Lock()
		list := make([]map[string]any, 0, len(s.entities))
		for _, e := range s.entities {
			d := s.feetLocked().Sub(e.Pos).Len()
			if c.Range > 0 && d > c.Range {
				continue
			}
			list = append(list, map[string]any{
				"id":       e.RuntimeID,
				"name":     e.Name,
				"type":     e.Type,
				"isPlayer": e.IsPlayer,
				"isItem":   e.Type == "item",
				"position": vec(e.Pos),
				"distance": d,
			})
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"entities": list})

	case "inventory":
		s.mu.Lock()
		list := make([]map[string]any, 0, len(s.slots))
		for _, it := range s.slots {
			list = append(list, map[string]any{
				"slot": it.Slot, "name": it.Name, "count": it.Count,
			})
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"items": list})

	case "blockAt":
		s.mu.Lock()
		name, ok := s.world.blockAt(int32(math.Floor(float64(c.X))),
			int32(math.Floor(float64(c.Y))), int32(math.Floor(float64(c.Z))))
		s.mu.Unlock()
		if !ok {
			// 未取得の領域を「空気」と答えると、skills/ が空中に足場を作ろうとする。
			// 分からないことは分からないと返す。
			s.reply(c.ID, false, "その座標はまだ読み込まれていません", nil)
			return
		}
		s.reply(c.ID, true, "", map[string]any{"name": name})

	case "findBlock":
		s.mu.Lock()
		found := s.findBlocksLocked(c.Names, c.Range, max(1, c.Count))
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"blocks": found})

	case "dig":
		bx := int32(math.Floor(float64(c.X)))
		by := int32(math.Floor(float64(c.Y)))
		bz := int32(math.Floor(float64(c.Z)))

		s.mu.Lock()
		name, known := s.world.blockAt(bx, by, bz)
		if !known {
			s.mu.Unlock()
			s.reply(c.ID, false, "その座標はまだ読み込まれていません", nil)
			return
		}
		if name == "air" {
			s.mu.Unlock()
			s.reply(c.ID, true, "", map[string]any{"name": name, "alreadyAir": true})
			return
		}
		if s.digging != nil {
			emit(event{Event: "result", Data: map[string]any{
				"id": s.digging.id, "ok": false, "error": "新しい採掘で置き換えられた",
			}})
		}
		timeout := c.Timeout
		if timeout <= 0 {
			timeout = 20000
		}
		// 掘る面はプレイヤー側を向いた面にする。裏側を指定すると届かない。
		s.digging = &digTask{
			id:       c.ID,
			pos:      protocol.BlockPos{bx, by, bz},
			face:     faceToward(s.pos, bx, by, bz),
			deadline: time.Now().Add(time.Duration(timeout) * time.Millisecond),
		}
		// 見ていない方向は掘れないサーバーがあるので視点も向ける。
		s.lookAtLocked(float32(bx)+0.5, float32(by)+0.5, float32(bz)+0.5)
		s.mu.Unlock()
		// 結果は壊れたときか時間切れのときに返す。

	case "hold":
		// ホットバーの選択スロットを変える。設置や採掘は手に持っているもので決まる。
		slot := int32(c.Count)
		if slot < 0 || slot > 8 {
			s.reply(c.ID, false, "ホットバーは 0..8 です", nil)
			return
		}
		s.mu.Lock()
		item := s.rawSlots[int(slot)]
		s.heldSlot = slot
		s.mu.Unlock()
		if err := s.conn.WritePacket(&packet.MobEquipment{
			EntityRuntimeID: s.game.EntityRuntimeID,
			NewItem:         item,
			InventorySlot:   byte(slot),
			HotBarSlot:      byte(slot),
		}); err != nil {
			s.reply(c.ID, false, fmt.Sprintf("持ち替えに失敗: %v", err), nil)
			return
		}
		s.reply(c.ID, true, "", nil)

	case "place":
		bx := int32(math.Floor(float64(c.X)))
		by := int32(math.Floor(float64(c.Y)))
		bz := int32(math.Floor(float64(c.Z)))
		s.mu.Lock()
		held, ok := s.rawSlots[int(s.heldSlot)]
		if !ok || held.Stack.Count == 0 {
			s.mu.Unlock()
			s.reply(c.ID, false, "手に何も持っていません", nil)
			return
		}
		// 面を指定されていなければ、プレイヤー側の面に置く。
		face := c.Face
		if face < 0 {
			face = faceToward(s.pos, bx, by, bz)
		}
		s.lookAtLocked(float32(bx)+0.5, float32(by)+0.5, float32(bz)+0.5)
		// クリック先のブロックIDを渡さないとサーバーが設置を捨てる。
		clicked, _ := s.world.runtimeIDAt(bx, by, bz)
		s.pendingPlace = &protocol.UseItemTransactionData{
			ActionType:       protocol.UseItemActionClickBlock,
			TriggerType:      protocol.TriggerTypePlayerInput,
			BlockPosition:    protocol.BlockPos{bx, by, bz},
			BlockFace:        face,
			HotBarSlot:       s.heldSlot,
			HeldItem:         held,
			Position:         s.pos,
			ClickedPosition:  clickOffset(face),
			BlockRuntimeID:   uint32(clicked),
			ClientPrediction: protocol.ClientPredictionSuccess,
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", nil)

	case "craft":
		want := ""
		if len(c.Names) > 0 {
			want = trimNamespace(c.Names[0])
		}
		if want == "" {
			s.reply(c.ID, false, "作る物を指定してください", nil)
			return
		}
		s.mu.Lock()
		list := s.recipes[want]
		if len(list) == 0 {
			s.mu.Unlock()
			s.reply(c.ID, false, fmt.Sprintf("%s のレシピが見つかりません", want), nil)
			return
		}
		// 作業台が無いなら 2x2 で作れるものだけ。
		var chosen *craftRecipe
		var lastErr error
		var req *protocol.ItemStackRequest
		for i := range list {
			if list[i].NeedsTable && !c.Value {
				lastErr = fmt.Errorf("%s は作業台が要ります", want)
				continue
			}
			// クライアントが出すリクエストIDは負の奇数を順に減らしていく。
			// 正の値を出すと "expected a valid ItemStackRequestId" で弾かれる。
			s.craftReqID -= 2
			r, err := s.craftRequestLocked(list[i], s.craftReqID)
			if err != nil {
				lastErr = err
				continue
			}
			chosen = &list[i]
			req = r
			break
		}
		if chosen == nil {
			s.mu.Unlock()
			msg := "作れません"
			if lastErr != nil {
				msg = lastErr.Error()
			}
			s.reply(c.ID, false, msg, nil)
			return
		}
		s.craftWaiter[req.RequestID] = c.ID
		s.mu.Unlock()

		if err := s.conn.WritePacket(&packet.ItemStackRequest{
			Requests: []protocol.ItemStackRequest{*req},
		}); err != nil {
			s.mu.Lock()
			delete(s.craftWaiter, req.RequestID)
			s.mu.Unlock()
			s.reply(c.ID, false, fmt.Sprintf("クラフトの送信に失敗: %v", err), nil)
		}
		// 成功の返事は ItemStackResponse で返す。

	case "recipeFor":
		// そのアイテムが作れるかを調べる。skills/ の canCraft 用。
		want := ""
		if len(c.Names) > 0 {
			want = trimNamespace(c.Names[0])
		}
		s.mu.Lock()
		list := s.recipes[want]
		found := make([]map[string]any, 0, len(list))
		for _, r := range list {
			inputs := make([]map[string]any, 0, len(r.Inputs))
			for _, in := range r.Inputs {
				inputs = append(inputs, map[string]any{"name": in.Name, "count": in.Count})
			}
			found = append(found, map[string]any{
				"outputCount": r.OutputCount,
				"needsTable":  r.NeedsTable,
				"inputs":      inputs,
			})
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"recipes": found})

	case "attack":
		// 攻撃は InventoryTransaction に載せる。手に持っている物で威力が変わる。
		rid := uint64(c.Count)
		s.mu.Lock()
		e, ok := s.entities[rid]
		if !ok {
			s.mu.Unlock()
			s.reply(c.ID, false, "その相手が見当たりません", nil)
			return
		}
		// 届かない距離から殴ってもサーバーに無視される。
		dist := s.feetLocked().Sub(e.Pos).Len()
		if dist > attackReach {
			s.mu.Unlock()
			s.reply(c.ID, false, fmt.Sprintf("遠すぎます（%.1f ブロック）", dist), nil)
			return
		}
		// 目線が外れていると当たらない判定のサーバーがある。
		s.lookAtLocked(e.Pos[0], e.Pos[1]+1, e.Pos[2])
		held := s.rawSlots[int(s.heldSlot)]
		slot := s.heldSlot
		pos := s.pos
		s.mu.Unlock()

		err := s.conn.WritePacket(&packet.InventoryTransaction{
			TransactionData: &protocol.UseItemOnEntityTransactionData{
				TargetEntityRuntimeID: rid,
				ActionType:            protocol.UseItemOnEntityActionAttack,
				HotBarSlot:            slot,
				HeldItem:              held,
				Position:              pos,
				// 相手の中心あたりを叩く。
				ClickedPosition: mgl32.Vec3{0, 1, 0},
			},
		})
		if err != nil {
			s.reply(c.ID, false, fmt.Sprintf("攻撃の送信に失敗: %v", err), nil)
			return
		}
		s.reply(c.ID, true, "", map[string]any{"distance": dist})

	case "snapshot":
		// TypeScript 側の world.* は同期APIなので、都度問い合わせるわけにいかない。
		// 周辺のブロックをまとめて渡し、向こうで展開して答えてもらう。
		// パレット＋添字にすることで、33^3 でも 70KB 程度に収まる。
		r := int32(c.Range)
		if r <= 0 {
			r = 16
		}
		if r > 32 {
			r = 32
		}
		s.mu.Lock()
		snap := s.snapshotLocked(r)
		s.mu.Unlock()
		s.reply(c.ID, true, "", snap)

	case "quit":
		s.reply(c.ID, true, "", nil)
		s.close("終了を指示された")

	default:
		s.reply(c.ID, false, fmt.Sprintf("未対応のコマンド: %s", c.Cmd), nil)
	}
}

// requestLoop は自分の周りの列を継続して要求する。
// 要求モードのサーバーはこれを出さないとブロックを一切送ってこない。
// 移動すると必要な列も高さも変わるので、定期的に見直す。
func (s *session) requestLoop() {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		s.requestNearby()
	}
}

// requestRadius は要求する水平方向の広さ(チャンク単位)。
// 広げるほど探索範囲は伸びるが、要求と保持のコストも増える。
const requestRadius = 3

func (s *session) requestNearby() {
	s.mu.Lock()
	if s.pos[1] > 1000 {
		// まだ仮座標。要求しても存在しない高さを取りに行くだけ。
		s.mu.Unlock()
		return
	}
	feet := s.feetLocked()
	px := floorDiv16(int32(math.Floor(float64(feet[0]))))
	pz := floorDiv16(int32(math.Floor(float64(feet[2]))))
	center := floorDiv16(int32(math.Floor(float64(feet[1]))))

	type req struct {
		cx, cz, dim int32
	}
	var todo []req
	for cx := px - requestRadius; cx <= px+requestRadius; cx++ {
		for cz := pz - requestRadius; cz <= pz+requestRadius; cz++ {
			dim, ok := s.known[[2]int32{cx, cz}]
			if !ok {
				continue
			}
			key := [3]int32{cx, cz, center}
			if s.requested[key] {
				continue
			}
			s.requested[key] = true
			todo = append(todo, req{cx, cz, dim})
		}
	}
	s.mu.Unlock()

	// 足元と頭上が分かれば移動には足りる。上下2区画ぶん。
	offsets := make([]protocol.SubChunkOffset, 0, 5)
	for dy := int8(-2); dy <= 2; dy++ {
		offsets = append(offsets, protocol.SubChunkOffset{0, dy, 0})
	}
	for _, r := range todo {
		if err := s.conn.WritePacket(&packet.SubChunkRequest{
			Dimension: r.dim,
			Position:  protocol.SubChunkPos{r.cx, center, r.cz},
			Offsets:   offsets,
		}); err != nil {
			emit(event{Event: "error", Error: fmt.Sprintf("サブチャンクの要求に失敗: %v", err)})
			return
		}
	}
}

// storeChunk は届いたサブチャンクを解いて保持する。
// 最初の1つだけ、何が届いたかを報告する（毎チャンク出すと読めないため）。
func (s *session) storeChunk(cx, cz int32, count int, payload []byte) {
	subs, err := decodeSubChunks(payload, count)
	if err != nil {
		emit(event{Event: "error", Error: fmt.Sprintf("チャンクの解析に失敗(%d,%d): %v", cx, cz, err)})
	}

	s.mu.Lock()
	for _, sc := range subs {
		s.world.put(cx, cz, sc)
	}
	first := !s.chunkReported && len(subs) > 0
	if first {
		s.chunkReported = true
	}
	loaded := s.world.loadedColumns()
	s.mu.Unlock()

	if !first {
		return
	}
	st := subs[0].Storages
	d := map[string]any{
		"chunk":   []int32{cx, cz},
		"index":   subs[0].Index,
		"columns": loaded,
	}
	if len(st) > 0 {
		d["bitsPerBlock"] = st[0].BitsPerBlock
		d["isRuntime"] = st[0].IsRuntime
		d["paletteSize"] = len(st[0].Palette) + len(st[0].PaletteNames)
		// 名前に戻せているかを一目で分かるようにする。
		names := make([]string, 0, 5)
		for _, id := range st[0].Palette {
			if n, ok := blockNameFor(id); ok {
				names = append(names, n)
			} else {
				names = append(names, fmt.Sprintf("不明(%d)", id))
			}
			if len(names) == 5 {
				break
			}
		}
		names = append(names, st[0].PaletteNames...)
		d["palette"] = names
	}
	emit(event{Event: "chunk_info", Data: d})
}

// findBlocksLocked は自分を中心に、名前が一致するブロックを近い順に探す。
// 呼び出し側が mu を持つこと。
//
// 走査は「Y を外側、水平を内側」ではなく距離順の立方体シェルで回す。単純な
// 全走査だと半径32でも26万マスあり、tick を止めてしまう。
func (s *session) findBlocksLocked(names []string, radius float32, count int) []map[string]any {
	if radius <= 0 {
		radius = 16
	}
	want := make(map[string]bool, len(names))
	for _, n := range names {
		want[trimNamespace(n)] = true
	}

	feet := s.feetLocked()
	ox := int32(math.Floor(float64(feet[0])))
	oy := int32(math.Floor(float64(feet[1])))
	oz := int32(math.Floor(float64(feet[2])))
	r := int32(radius)

	out := make([]map[string]any, 0, count)
	for d := int32(0); d <= r; d++ {
		for dx := -d; dx <= d; dx++ {
			for dy := -d; dy <= d; dy++ {
				for dz := -d; dz <= d; dz++ {
					// シェルの表面だけを見る。内側は前の d で見終わっている。
					if maxAbs(dx, dy, dz) != d {
						continue
					}
					x, y, z := ox+dx, oy+dy, oz+dz
					name, ok := s.world.blockAt(x, y, z)
					if !ok || !want[name] {
						continue
					}
					out = append(out, map[string]any{
						"name":     name,
						"position": []int32{x, y, z},
					})
					if len(out) >= count {
						return out
					}
				}
			}
		}
	}
	return out
}

func maxAbs(a, b, c int32) int32 {
	return max(abs32(a), max(abs32(b), abs32(c)))
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// snapshotLocked は自分を中心とした立方体のブロックをパレット形式で書き出す。
// 呼び出し側が mu を持つこと。
//
// 未取得のマスは名前を空文字にする。「空気」と答えると、向こう側が
// 「そこには何も無い」と誤解して空中に足場を作ろうとする。
func (s *session) snapshotLocked(r int32) map[string]any {
	feet := s.feetLocked()
	ox := int32(math.Floor(float64(feet[0]))) - r
	oy := int32(math.Floor(float64(feet[1]))) - r
	oz := int32(math.Floor(float64(feet[2]))) - r
	size := int(r*2 + 1)

	palette := []string{""}
	index := map[string]uint16{"": 0}
	data := make([]byte, 0, size*size*size*2)

	var buf [2]byte
	for dx := 0; dx < size; dx++ {
		for dy := 0; dy < size; dy++ {
			for dz := 0; dz < size; dz++ {
				name, ok := s.world.blockAt(ox+int32(dx), oy+int32(dy), oz+int32(dz))
				if !ok {
					name = ""
				}
				id, seen := index[name]
				if !seen {
					id = uint16(len(palette))
					palette = append(palette, name)
					index[name] = id
				}
				binary.LittleEndian.PutUint16(buf[:], id)
				data = append(data, buf[0], buf[1])
			}
		}
	}

	return map[string]any{
		"origin":  []int32{ox, oy, oz},
		"size":    size,
		"palette": palette,
		// 並びは x を外、次に y、最後に z。向こう側の展開もこの順で行う。
		"data": base64.StdEncoding.EncodeToString(data),
	}
}

// lookAtLocked は指定座標へ視点を向ける。呼び出し側が mu を持つこと。
// 目線の高さは足元から 1.62 上。
func (s *session) lookAtLocked(x, y, z float32) {
	// s.pos[1] は既に目線の高さなので足さない。
	dx, dy, dz := x-s.pos[0], y-s.pos[1], z-s.pos[2]
	flat := math.Hypot(float64(dx), float64(dz))
	s.yaw = float32(math.Atan2(float64(-dx), float64(dz)) * 180 / math.Pi)
	s.pitch = float32(-math.Atan2(float64(dy), flat) * 180 / math.Pi)
}

// faceToward はプレイヤーから見て手前になる面を返す。
// 0=下 1=上 2=北(-Z) 3=南(+Z) 4=西(-X) 5=東(+X)
func faceToward(from mgl32.Vec3, bx, by, bz int32) int32 {
	dx := from[0] - (float32(bx) + 0.5)
	dy := from[1] - (float32(by) + 0.5)
	dz := from[2] - (float32(bz) + 0.5)
	ax, ay, az := absf(dx), absf(dy), absf(dz)
	switch {
	case ay >= ax && ay >= az:
		if dy > 0 {
			return 1
		}
		return 0
	case ax >= az:
		if dx > 0 {
			return 5
		}
		return 4
	default:
		if dz > 0 {
			return 3
		}
		return 2
	}
}

func absf(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// checkDig は採掘が終わったかを見る。tick ごとに呼ぶ。
// 完了の判定はサーバーの UpdateBlock で空気になったかどうか。自前で
// 破壊時間を数えると、道具や効果の違いで簡単にずれる。
func (s *session) checkDig() {
	s.mu.Lock()
	d := s.digging
	if d == nil {
		s.mu.Unlock()
		return
	}
	name, known := s.world.blockAt(d.pos[0], d.pos[1], d.pos[2])
	done := known && name == "air"
	expired := time.Now().After(d.deadline)
	if done || expired {
		s.digging = nil
	}
	s.mu.Unlock()

	// id 0 は移動のための内部的な採掘。返す相手がいないので黙って終える。
	if d.id == 0 {
		return
	}
	if done {
		emit(event{Event: "result", Data: map[string]any{"id": d.id, "ok": true}})
	} else if expired {
		emit(event{Event: "result", Data: map[string]any{
			"id": d.id, "ok": false,
			"error": fmt.Sprintf("掘り切れなかった（%s のまま）", name),
		}})
	}
}

// clickOffset は面の中心を指すブロック内の相対座標を返す。
// 面の外側を指すとサーバーが設置先を別のブロックだと解釈する。
func clickOffset(face int32) mgl32.Vec3 {
	switch face {
	case 0: // 下
		return mgl32.Vec3{0.5, 0, 0.5}
	case 1: // 上
		return mgl32.Vec3{0.5, 1, 0.5}
	case 2: // 北(-Z)
		return mgl32.Vec3{0.5, 0.5, 0}
	case 3: // 南(+Z)
		return mgl32.Vec3{0.5, 0.5, 1}
	case 4: // 西(-X)
		return mgl32.Vec3{0, 0.5, 0.5}
	default: // 東(+X)
		return mgl32.Vec3{1, 0.5, 0.5}
	}
}

// capsLocked は今できることを返す。手持ちで経路の選択肢が変わる。
// 呼び出し側が mu を持つこと。
func (s *session) capsLocked() caps {
	blocks := 0
	for _, it := range s.slots {
		// 置ける「ブロック」かどうかを名前だけで厳密に判定はできない。
		// ホットバーにあるものを候補として数え、実際に置けるかは
		// 置いてみて判断する。置けなければ経路を引き直すことになる。
		if it.Slot >= 0 && it.Slot <= 8 && isPlaceableName(it.Name) {
			blocks += it.Count
		}
	}
	return caps{CanDig: true, Blocks: blocks}
}

// isPlaceableName は足場に使えそうな名前か。道具や食べ物を除くための粗い判定。
func isPlaceableName(name string) bool {
	for _, suffix := range []string{
		"_pickaxe", "_axe", "_shovel", "_hoe", "_sword", "_helmet", "_chestplate",
		"_leggings", "_boots", "bucket", "_seeds", "_ingot", "_nugget", "coal",
		"stick", "string", "bone", "gunpowder", "arrow", "bread", "apple",
	} {
		if strings.HasSuffix(name, suffix) || name == suffix {
			return false
		}
	}
	return true
}

// prepareStepLocked はその歩に必要な下ごしらえを進める。
// 済んでいれば true。まだなら false を返し、掘る/置くを仕掛ける。
// 呼び出し側が mu を持つこと。
func (s *session) prepareStepLocked(st step) bool {
	switch st.Action {
	case stepDig:
		for _, b := range st.Dig {
			if s.world.passable(b) {
				continue
			}
			// 既に掘っている最中ならそのまま待つ。
			if s.digging != nil && s.digging.pos == (protocol.BlockPos{b.X, b.Y, b.Z}) {
				return false
			}
			if s.digging != nil {
				return false
			}
			s.digging = &digTask{
				// id 0 は移動のための内部的な採掘。結果を返す相手がいない。
				id:       0,
				pos:      protocol.BlockPos{b.X, b.Y, b.Z},
				face:     faceToward(s.pos, b.X, b.Y, b.Z),
				deadline: time.Now().Add(15 * time.Second),
			}
			s.lookAtLocked(float32(b.X)+0.5, float32(b.Y)+0.5, float32(b.Z)+0.5)
			return false
		}
		return true

	case stepBridge:
		if s.world.solidFloor(st.Fill) {
			return true
		}
		if s.pendingPlace != nil {
			return false
		}
		// 置く先に接している既存のブロックを支えにする。
		ref, face, ok := s.supportForLocked(st.Fill)
		if !ok {
			// 支えが無ければ置けない。経路を引き直させる。
			s.goal.path = nil
			return false
		}
		held, ok := s.rawSlots[int(s.heldSlot)]
		if !ok || held.Stack.Count == 0 {
			if !s.holdPlaceableLocked() {
				s.goal.path = nil
				return false
			}
			return false
		}
		clicked, _ := s.world.runtimeIDAt(ref.X, ref.Y, ref.Z)
		s.lookAtLocked(float32(st.Fill.X)+0.5, float32(st.Fill.Y)+0.5, float32(st.Fill.Z)+0.5)
		s.pendingPlace = &protocol.UseItemTransactionData{
			ActionType:       protocol.UseItemActionClickBlock,
			TriggerType:      protocol.TriggerTypePlayerInput,
			BlockPosition:    protocol.BlockPos{ref.X, ref.Y, ref.Z},
			BlockFace:        face,
			HotBarSlot:       s.heldSlot,
			HeldItem:         held,
			Position:         s.pos,
			ClickedPosition:  clickOffset(face),
			BlockRuntimeID:   uint32(clicked),
			ClientPrediction: protocol.ClientPredictionSuccess,
		}
		return false

	default:
		return true
	}
}

// supportForLocked は fill の位置にブロックを置くための、接している既存ブロックと
// その面を返す。統合版の設置は「既にあるブロックの面をクリックする」形なので、
// 何も接していない空中には置けない。
func (s *session) supportForLocked(fill blockPos) (blockPos, int32, bool) {
	// 面番号: 0=下 1=上 2=北(-Z) 3=南(+Z) 4=西(-X) 5=東(+X)
	cands := []struct {
		off  blockPos
		face int32
	}{
		{blockPos{fill.X, fill.Y - 1, fill.Z}, 1},
		{blockPos{fill.X, fill.Y + 1, fill.Z}, 0},
		{blockPos{fill.X, fill.Y, fill.Z - 1}, 3},
		{blockPos{fill.X, fill.Y, fill.Z + 1}, 2},
		{blockPos{fill.X - 1, fill.Y, fill.Z}, 5},
		{blockPos{fill.X + 1, fill.Y, fill.Z}, 4},
	}
	for _, c := range cands {
		if s.world.solidFloor(c.off) {
			return c.off, c.face, true
		}
	}
	return blockPos{}, 0, false
}

// holdPlaceableLocked は置けそうなものをホットバーから選んで持つ。
// 持ち替えを仕掛けたら true。候補が無ければ false。
func (s *session) holdPlaceableLocked() bool {
	for _, it := range s.slots {
		if it.Slot < 0 || it.Slot > 8 || !isPlaceableName(it.Name) {
			continue
		}
		item := s.rawSlots[it.Slot]
		s.heldSlot = int32(it.Slot)
		go func(slot int32, i protocol.ItemInstance) {
			_ = s.conn.WritePacket(&packet.MobEquipment{
				EntityRuntimeID: s.game.EntityRuntimeID,
				NewItem:         i,
				InventorySlot:   byte(slot),
				HotBarSlot:      byte(slot),
			})
		}(int32(it.Slot), item)
		return true
	}
	return false
}
