package main

// 接続後のセッション。標準入力から改行区切りJSONでコマンドを受け、
// 状態の変化と結果を標準出力へ流す。TypeScript 側の BedrockDriver が
// この向こう側にいる。
//
// 統合版はサーバー権限型なので、位置を自前で進めてはいけない。
// 入力を送り、サーバーが返す補正を正として取り込む。

import (
	"bufio"
	"context"
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
}

type entityInfo struct {
	RuntimeID uint64
	UniqueID  int64
	Name      string
	Type      string
	IsPlayer  bool
	Pos       mgl32.Vec3
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
}

type session struct {
	conn *minecraft.Conn
	game minecraft.GameData

	mu       sync.Mutex
	pos      mgl32.Vec3
	yaw      float32
	pitch    float32
	onGround bool
	health   float32
	food     float32
	controls map[string]bool
	entities map[uint64]*entityInfo
	unique   map[int64]uint64 // RemoveActor は unique ID で来る
	goal     *target

	// インベントリ。パケットは network ID しか持たないので、StartGame の
	// アイテム表で名前に戻す。
	itemNames map[int32]string
	slots     []invSlot

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
		itemNames: names,
		conn:      conn,
		game:      game,
		pos:       mgl32.Vec3{game.PlayerPosition[0], game.PlayerPosition[1], game.PlayerPosition[2]},
		yaw:       game.Yaw,
		pitch:     game.Pitch,
		health:    20,
		food:      20,
		controls:  map[string]bool{},
		entities:  map[uint64]*entityInfo{},
		unique:    map[int64]uint64{},
		done:      make(chan struct{}),
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

	emit(event{Event: "ready_to_act", Data: map[string]any{
		"entityRuntimeID": s.game.EntityRuntimeID,
		"position":        vec(s.pos),
	}})

	select {
	case <-ctx.Done():
		s.close("コンテキストの終了")
	case <-s.done:
	}
}

func vec(v mgl32.Vec3) []float32 { return []float32{v[0], v[1], v[2]} }

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
		s.pos = mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]}
		s.onGround = v.OnGround
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
			Pos:       mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]},
		}
		s.unique[v.AbilityData.EntityUniqueID] = v.EntityRuntimeID
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
		emit(event{Event: "chat", Data: map[string]any{
			"type":    v.TextType,
			"source":  strings.ReplaceAll(v.SourceName, "§r", ""),
			"message": v.Message,
			"xuid":    v.XUID,
			"self":    v.XUID == s.conn.IdentityData().XUID,
		}})

	case *packet.InventoryContent:
		// WindowID 0 がプレイヤー自身の持ち物。
		if v.WindowID != 0 {
			return
		}
		s.mu.Lock()
		s.slots = s.slots[:0]
		for i, item := range v.Content {
			if it, ok := s.itemLocked(item); ok {
				it.Slot = i
				s.slots = append(s.slots, it)
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
		if it, ok := s.itemLocked(v.NewItem); ok {
			it.Slot = slot
			s.slots = append(s.slots, it)
		}
		s.mu.Unlock()

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
	flags := protocol.NewInputFlags(packet.InputFlagCount)
	move := mgl32.Vec2{}

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

	return &packet.PlayerAuthInput{
		Pitch:            s.pitch,
		Yaw:              s.yaw,
		HeadYaw:          s.yaw,
		Position:         s.pos,
		MoveVector:       move,
		InputData:        flags,
		InputMode:        packet.InputModeMouse,
		PlayMode:         packet.PlayModeNormal,
		InteractionModel: packet.InteractionModelCrosshair,
		Tick:             n,
	}
}

// steerLocked は目標があれば向きと前進を設定する。呼び出し側が mu を持つこと。
func (s *session) steerLocked(n uint64) {
	g := s.goal
	if g == nil {
		return
	}

	dx := g.x - s.pos[0]
	dz := g.z - s.pos[2]
	dist := float32(math.Hypot(float64(dx), float64(dz)))

	if dist <= g.tolerance {
		s.controls["forward"] = false
		s.controls["jump"] = false
		s.goal = nil
		emit(event{Event: "result", Data: map[string]any{
			"id": g.id, "ok": true, "position": vec(s.pos),
		}})
		return
	}
	if time.Now().After(g.deadline) {
		s.controls["forward"] = false
		s.controls["jump"] = false
		s.goal = nil
		emit(event{Event: "result", Data: map[string]any{
			"id": g.id, "ok": false,
			"error":    fmt.Sprintf("目標に届かなかった（残り %.1f ブロック）", dist),
			"position": vec(s.pos),
		}})
		return
	}

	// Minecraft の yaw は南(+Z)が0で、西(-X)へ向かって増える。
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
	s.controls["jump"] = g.stalledTicks >= 2
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
		dx, dy, dz := c.X-s.pos[0], c.Y-(s.pos[1]+1.62), c.Z-s.pos[2]
		flat := math.Hypot(float64(dx), float64(dz))
		s.yaw = float32(math.Atan2(float64(-dx), float64(dz)) * 180 / math.Pi)
		s.pitch = float32(-math.Atan2(float64(dy), flat) * 180 / math.Pi)
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
		err := s.conn.WritePacket(&packet.CommandRequest{
			CommandLine: c.Message,
			CommandOrigin: protocol.CommandOrigin{
				Origin:         protocol.CommandOriginPlayer,
				UUID:           uuid.New(),
				PlayerUniqueID: s.game.EntityUniqueID,
			},
			Version: "52",
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
			"position": vec(s.pos),
			"yaw":      s.yaw,
			"pitch":    s.pitch,
			"onGround": s.onGround,
			"health":   s.health,
			"food":     s.food,
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", d)

	case "entities":
		s.mu.Lock()
		list := make([]map[string]any, 0, len(s.entities))
		for _, e := range s.entities {
			d := s.pos.Sub(e.Pos).Len()
			if c.Range > 0 && d > c.Range {
				continue
			}
			list = append(list, map[string]any{
				"id":       e.RuntimeID,
				"name":     e.Name,
				"type":     e.Type,
				"isPlayer": e.IsPlayer,
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

	case "quit":
		s.reply(c.ID, true, "", nil)
		s.close("終了を指示された")

	default:
		s.reply(c.ID, false, fmt.Sprintf("未対応のコマンド: %s", c.Cmd), nil)
	}
}
