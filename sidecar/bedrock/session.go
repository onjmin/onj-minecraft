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
	"strconv"
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
	// goto: 高さを厳密(±0.5)に合わせる。穴の底の物を縁から「着いた」と言わせない。
	Strict bool `json:"strict"`
}

// 統合版のプレイヤー座標は「足元 + 目線の高さ」で送られてくる。
// ブロックを引くときは必ず引き算すること。これを忘れると足場判定が2ブロック
// ずれ、経路探索も採掘対象も全部おかしくなる。
const eyeHeight = float32(1.62)

// 攻撃が届く距離。バニラのプレイヤーは3ブロックほど。
const attackReach = float32(3.5)

// 食べ終わるまでの時間。バニラの食事は32tick(1.6秒)なので、少し余裕を持たせる。
// これより早く「食べ終わった」を送るとサーバーに捨てられ、満腹度が戻らない。
const eatDuration = 1900 * time.Millisecond

// 敵に先制攻撃・反応し始める距離。
// 射線が通っている敵には自らダッシュで間合いを詰めて先制攻撃を仕掛ける。
const (
	defendRangeNearby  = float32(9)  // 近接モブ(ゾンビ・クモ等)への先制急襲距離
	defendRangeRanged  = float32(14) // 遠距離モブ(スケルトン等)への急襲距離(射撃前に接近)
	defendRangeCreeper = float32(8)  // クリーパーへの警戒・回避距離
)

// 殴られてから、遠くの敵にも反応し続ける時間。
const hurtMemory = 4 * time.Second

// 殴られている間の反応距離。撃ってくる相手を含める。
const hurtDefendRange = float32(16)

// 一度に逃げ続ける上限(tick)。これを過ぎたら本来の行動へ戻す。
// 戻ってまだ危なければまた逃げる。走りっぱなしにしないための区切り。
//
// ただし敵が fleeGiveUpRange より近いままなら、この上限・下のクールダウンは
// 無視してでも逃げ続ける。タイマーで機械的に切り上げると、敵がまだ隣にいる
// のに数秒間まるごと無防備な通常行動へ戻ってしまい、その間に殴られ続けて
// 死ぬ（死因の実測で mob 起因の死亡が多いのはこれが主因だった）。
const fleeMaxTicks = uint64(60)

// 逃げたあと、次に逃げるまで置く間隔(tick)。敵が離れて安全になった場合のみ効く。
const fleeCooldownTicks = uint64(60)

// この距離より敵が近い間は、fleeMaxTicks/fleeCooldownTicks を無視して
// 逃げ続ける。攻撃が届く間合いのすぐ外まで見ておく。
const fleeGiveUpRange = float32(6)

// これを下回ったら戦わずに逃げる。
const defendFleeHealth = float32(10)

// 殴られた瞬間、この距離にいるプレイヤーを犯人と見なす。
const playerThreatRange = float32(6)

// 殴ってきたプレイヤーから逃げ続ける時間。
const playerThreatDuration = 20 * time.Second

// 殴ってきたプレイヤーがこの距離まで近いなら逃げる。
const playerFleeRange = float32(16)

// 攻撃の間隔(tick)。統合版(Bedrock)は武器クールダウンがないため、6tick(約0.3秒)で
// 連打してノックバックを与え、敵を寄せ付けずに倒す。
const attackIntervalTicks = uint64(6)

// 採掘が届く距離。サバイバルは概ね5ブロック。少し余裕を持たせる。
const digReach = float32(6)

// 1tick あたりの移動量。バニラの歩行 4.317 ブロック/秒、走行 5.612 ブロック/秒。
const (
	walkSpeed   = float32(0.2159)
	sprintSpeed = float32(0.2806)
)

// openContainer は今開いているコンテナ。ContainerOpen で埋まり、
// ContainerClose で消える。中身は InventoryContent が同じ WindowID で届く。
type openContainer struct {
	WindowID byte
	Type     byte
	Pos      protocol.BlockPos
	// 中身。スロット番号をそのまま添字にする。
	Slots map[int]protocol.ItemInstance
	// 中身が一度でも届いたか。開いた直後は空と区別が付かない。
	Filled bool
}

type entityInfo struct {
	RuntimeID uint64
	UniqueID  int64
	Name      string
	Type      string
	IsPlayer  bool
	Pos       mgl32.Vec3
	// Item は落ちているアイテムの中身。拾ったときに持ち物へ足すのに要る。
	// 統合版のサーバーは拾得で持ち物の更新を送ってこない。実クライアントが
	// 自前で予測する作りなので、こちらも同じことをする必要がある。
	Item protocol.ItemInstance
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
	id   int
	x, z float32
	// y は高さも合わせたいときの目標。hasY が false なら高さは見ない。
	//
	// 水平だけで判定すると、掘った穴の真上に立った時点で「着いた」ことに
	// なる。落ちているアイテムを拾いに行くときにこれで詰まり、距離2の
	// ままいくら待っても拾えなかった。
	y    float32
	hasY bool
	// strictY なら高さの許容は ±0.5。既定(false)は1段(±1.5)。
	strictY bool
	// noDig なら掘って進む手を使わない。落ちている物を拾いに行くだけの
	// ために地形を掘るのは無駄で、他人の世界も壊す。
	// mineflayer-pathfinder の回収も canDig=false で引いている。
	noDig     bool
	tolerance float32
	deadline  time.Time
	// 進んでいないことを検出して自動ジャンプするための記録
	lastPos      mgl32.Vec3
	stalledTicks int
	// 経路。空なら真っ直ぐ向かう(近距離や、道が見つからなかったとき)。
	path []step
	// 今の1歩で待っている下ごしらえ(掘る/置く)。終わるまで前進しない。
	waiting bool
	// 待ち始めた時刻と、待っている歩の位置。
	//
	// 待ちに期限が無いと、終わらない下ごしらえ(壊せないブロック、通らない
	// 設置)の前で立ち止まったまま、目標の制限時間を丸ごと使い切る。実測
	// 2026-09-17 17:43〜17:45、16〜19ブロック先の羊へ3回続けて30秒ずつ
	// 歩き、一度も攻撃に入れていない。経路は21手引けていたのに距離が
	// 縮んでいないので、動いていたのではなく止まっていた。
	waitStart time.Time
	waitStep  blockPos
	// 下ごしらえを諦めて経路を引き直した回数。繰り返すなら別の手が要る。
	abandoned int
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
	// ワールドの総経過tick。SetTime はゲーム内時刻ではなく累計を送ってくるので、
	// 昼夜の判定に使うには 24000 で割った余りを取る必要がある。
	worldTick int32
	// doDaylightCycle が切られているか。切られている世界では時刻が進まない。
	dayCycleStopped bool
	// LLM が決めた構え。"" か "auto" なら従来の判断(武器の有無・体力・
	// クリーパー)。"flee" なら武器があっても逃げる。"fight" なら素手でも
	// 殴り合う(体力が defendFleeHealth 以下のときだけは逃げる)。
	//
	// 逃げるか殴るかを毎tick決めるのはここでよい(LLM を待てない)。だが
	// その方針まで定数で固定すると、LLM は自分が丸腰で逃げ回っている理由も、
	// それを変える手段も持たない。mindcraft の cowardice / self_defense の
	// オンオフに相当する経路。
	stance string
	// 最後に殴った tick。連打を防ぐ。0 なら戦っていない。
	fighting uint64
	// 逃げ始めた tick と、逃げ終えた tick。走りっぱなしを防ぐ。
	fleeSince uint64
	fleeUntil uint64
	// 防衛・逃走時の移動スタック検知用。段差で詰まったら跳ぶ。
	defendLastPos      mgl32.Vec3
	defendStalledTicks int
	// 今サーバーにいる人。UUID -> 表示名。人数制限の判断に使う。
	online map[string]string
	// 最後に damage を受けた時刻。撃たれているときは遠くの敵にも反応する。
	lastHurt time.Time
	// 頭まで水に沈み始めた時刻。ゼロなら沈んでいない。息の反射に使う。
	submergedSince time.Time
	// 空気を探して見つからなかったことを、沈んでいる間に一度だけ記録する。
	noAirLogged bool
	// 最後に空気へ向かう目標を立てた時刻。連発しないため。
	lastEscapeAt time.Time
	// 最後に頭が水に入っていなかった位置と時刻。溺れかけたら戻る先。
	lastAirPos mgl32.Vec3
	lastAirAt  time.Time
	// 死んでから体力が戻るまで true。体力の 0→正 を復帰の合図にするため。
	dead bool
	// 殴ってきたプレイヤー。相手にせず逃げるためだけに覚える。
	// 殴り返すと事が大きくなるだけで、こちらに得が無い。
	playerThreat      uint64
	playerThreatUntil time.Time
	// 今開いているコンテナ。開いていなければ nil。
	// チェストもかまども、開いてからでないと中身が届かず操作もできない。
	container *openContainer
	controls  map[string]bool
	entities  map[uint64]*entityInfo
	unique    map[int64]uint64 // RemoveActor は unique ID で来る
	goal      *target

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
	// slotsPredicted は、拾った物をこちらで足して持ち物を書いたことを示す。
	//
	// 統合版は拾っても持ち物の更新を送ってこないので、TakeItemActor を見て
	// 自分で足している。個数は合うが、スタックの識別子(StackNetworkID)は
	// サーバー側の値と違う。その識別子のままクラフトの素材に指すと
	// FailedToValidateSrcSlot(49) で拒否される。実測 2026-09-17 00:36、
	// 地面から拾った spruce_log 4本で spruce_planks を作ろうとして、
	// 毎回これで弾かれていた。ItemStackRequest を組む前に取り直す。
	slotsPredicted bool
	heldSlot       int32

	// チャンクの中身は最初の1回だけ報告する。毎チャンク出すと読めない。
	chunkReported bool
	// サーバーから存在を知らされた列と、その次元。
	known map[[2]int32]int32
	// 列ごとに、最後に要求したときの高さ区画。
	//
	// 元は (列, 高さ区画) の組を集合で持ち、高さ区画が1つ変わるだけで
	// 全部の列を取り直していた。要求範囲が3チャンク(49列)なら実害は
	// 小さかったが、8チャンク(289列)に広げると、掘り上がりで Y が16変わる
	// たびに289列×11区画=3000件を要求し直すことになる。
	// 上下に requestVertical ぶん取ってあるので、中心が少し動いたくらいでは
	// 取り直す必要がない。どこまで動いたら取り直すかは requestRestep で見る。
	requested map[[2]int32]int32
	// 受け取ったブロック。ワールド読み取りの土台。
	world *world
	// 進行中の採掘。tick ループが毎回 BlockActions を積む。
	digging *digTask
	// digStop は採掘が終わった位置。次の tick で StopBreak を一度だけ送る。
	//
	// 壊れたあとに「やめた」を送らないと、サーバー側の破壊状態がその位置に
	// 残ることがある。そこへ作業台を置くと、置いた瞬間に壊れて拾い直す
	// (実測 2026-09-19 12:53、土を掘って置いた作業台が3秒後に item として
	// 拾われ、開けずに終わった)。
	digStop *protocol.BlockPos
	// 既知の安全地帯(村・ベッド・拠点)。逃走時に defendLocked が参照する。
	safeSpots []safeSpot
	// 次の tick で送る設置。統合版の設置は player_auth_input に載せる。
	pendingPlace *protocol.UseItemTransactionData
	// pendingAttack は次の tick で送る攻撃。
	//
	// 設置と同じく、入力と同じ tick の流れに載せる。コマンドの goroutine から
	// 直接 WritePacket していたときは、サーバーが受け取っても何も起きなかった。
	pendingAttack *protocol.UseItemOnEntityTransactionData

	// レシピ。サーバーが接続時に全部送ってくる。出来上がる物の名前で引く。
	recipes map[string][]craftRecipe
	// 進行中のクラフト。応答は ItemStackResponse で返ってくる。
	// リクエストIDは -1, -3, -5 ... と負の奇数を減らしていく決まり。
	craftReqID  int32
	craftWaiter map[int32]int
	// クラフトの結果は ItemStackResponse で返り、InventorySlot では来ない。
	// 何を作って何を消したかを覚えておき、成功したら持ち物の写しに反映する。
	craftEffect map[int32]craftOutcome
	// スロット移動の結果も ItemStackResponse でしか返らない。成功したら
	// 写しの from/to を入れ替える。ContainerInfo は識別子と個数しか
	// 持たず、どの物がどこへ動いたかは載っていない。
	moveEffect map[int32][2]int
	// 戦闘の持ち替えで、奥の武器をホットバーへ移す要求を出した時刻。
	// 応答が来る前に毎 tick 重ねて出さないための間隔に使う。
	weaponMoveAt time.Time

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
		requested:   map[[2]int32]int32{},
		rawSlots:    map[int]protocol.ItemInstance{},
		world:       newWorld(),
		unique:      map[int64]uint64{},
		recipes:     map[string][]craftRecipe{},
		online:      map[string]string{},
		craftReqID:  1, // 最初の -2 で -1 になる
		craftWaiter: map[int32]int{},
		craftEffect: map[int32]craftOutcome{},
		moveEffect:  map[int32][2]int{},
		done:        make(chan struct{}),
	}
}

func (s *session) close(reason string) {
	s.once.Do(func() {
		emit(event{Event: "end", Data: map[string]any{"reason": reason}})
		close(s.done)
	})
}

// initWorldTime は接続直後の仮の時刻を置く。
//
// 時刻はクライアントが自分で進めるもので、SetTime は同期のためにたまに
// 来るだけ(gophertunnel の説明にも「クライアントが自分で進める」とある)。
// 実測、この Realm では SetTime は接続後に一度も来ず、受け取った値を入れる
// だけの実装では時計が 0(夜明け)で止まったままだった。そのため「夜」を
// 一度も検知できず、夜にこもる反射が全ログを通して発火0件だった。
//
// ここで置く StartGame.Time は当てにならない。実測 19821(夜)で始まったが、
// 直後に来た SyncWorldClocks は 1190(朝)だった。正は SyncWorldClocks で、
// そちらが届いた時点で上書きされる。ここは届くまでの繋ぎでしかない。
//
// doDaylightCycle が切られている世界では時刻そのものが止まる。進めると
// 昼のまま夜だと誤認するので、その場合は固定時刻を使い、進めない。
func (s *session) initWorldTime() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.worldTick = int32(((s.game.Time % 24000) + 24000) % 24000)
	for _, r := range s.game.GameRules {
		if !strings.EqualFold(r.Name, "dodaylightcycle") {
			continue
		}
		if on, ok := r.Value.(bool); ok && !on {
			s.dayCycleStopped = true
			s.worldTick = ((s.game.DayCycleLockTime % 24000) + 24000) % 24000
		}
	}
	fmt.Fprintf(os.Stderr, "[sidecar] ワールド時刻 %d から開始（昼夜の進行: %v）\n",
		s.worldTick, !s.dayCycleStopped)
}

// serve は接続が切れるか標準入力が閉じるまで動き続ける。
func (s *session) serve(ctx context.Context) {
	s.initWorldTime()
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

	case *packet.SetTime:
		// 届いたときだけ合わせ直す。ふだんは tick() が自前で進めている。
		s.mu.Lock()
		s.worldTick = v.Time
		s.mu.Unlock()

	case *packet.SyncWorldClocks:
		// 26.x の時刻同期。SetTime の後継で、こちらは実際に飛んでくる。
		// 自前で進める時計はサーバーの実TPSより速くなりがち(Realm は 20TPS
		// 出ていない)。実測、夜だと判断してベッドを叩いても tile.bed.noSleep
		// が返る程度には先行していた。届いたら必ず合わせ直す。
		if v.PayloadType == protocol.ClockPayloadTypeSyncState && len(v.SyncStates) > 0 {
			st := v.SyncStates[0]
			s.mu.Lock()
			before := s.worldTick
			s.worldTick = int32(((int64(st.Time) % 24000) + 24000) % 24000)
			s.dayCycleStopped = st.Paused
			after := s.worldTick
			s.mu.Unlock()
			if d := after - before; d > 200 || d < -200 {
				fmt.Fprintf(os.Stderr, "[sidecar] 時刻を合わせ直した %d -> %d（停止: %v）\n",
					before, after, st.Paused)
			}
		}

	case *packet.DeathInfo:
		// 死んだ。持ち物は全部その場に落ちる。黙って再開すると、集めた物が
		// 消えた理由が分からないまま検証結果だけが揺れる。実際、土50個も
		// ツルハシも失っていたのに気付けなかった。
		emit(event{Event: "death", Data: map[string]any{"cause": v.Cause}})
		s.mu.Lock()
		s.dead = true
		s.submergedSince = time.Time{}
		s.mu.Unlock()
		// 復帰を要求し続ける。サーバーが Respawn を送ってくる順番は当てに
		// できず、1回投げただけでは死んだままになることがある。体力が
		// 戻るまで数回繰り返す。
		go s.requestRespawn()

	case *packet.Respawn:
		if v.EntityRuntimeID != s.game.EntityRuntimeID {
			return
		}
		// 統合版は死んでも勝手には戻らない。実クライアントは死亡画面で
		// 「リスポーン」を押し、そこで初めて要求が飛ぶ。こちらから送らないと
		// 死んだまま動き続け、以降の行動が全部無意味になる。
		if v.State == packet.RespawnStateSearchingForSpawn {
			_ = s.conn.WritePacket(&packet.PlayerAction{
				EntityRuntimeID: s.game.EntityRuntimeID,
				ActionType:      protocol.PlayerActionRespawn,
			})
			_ = s.conn.WritePacket(&packet.Respawn{
				EntityRuntimeID: s.game.EntityRuntimeID,
				State:           packet.RespawnStateClientReadyToSpawn,
				Position:        v.Position,
			})
			return
		}
		if v.State == packet.RespawnStateReadyToSpawn {
			s.mu.Lock()
			s.pos = v.Position
			// ここで知らせるので、体力の戻りでもう一度知らせない。
			s.dead = false
			s.submergedSince = time.Time{}
			s.mu.Unlock()
			emit(event{Event: "respawn", Data: map[string]any{
				"position": []float32{v.Position[0], v.Position[1], v.Position[2]},
			}})
		}

	case *packet.SetHealth:
		s.mu.Lock()
		if float32(v.Health) < s.health {
			s.notePlayerAttackLocked()
			// 息の反射は「削られた」を lastHurt で見る。こちらの経路でも立てる。
			s.lastHurt = time.Now()
			if s.headInWaterLocked() {
				fmt.Fprintf(os.Stderr, "[sidecar] 水中で削られた(SetHealth) 体力 %.0f→%d 沈んで %.0fs\n",
					s.health, v.Health, time.Since(s.submergedSince).Seconds())
			}
		}
		s.health = float32(v.Health)
		revived := s.noteRevivedLocked()
		s.mu.Unlock()
		if revived {
			s.emitRespawn()
		}

	case *packet.UpdateAttributes:
		if v.EntityRuntimeID != s.game.EntityRuntimeID {
			return
		}
		s.mu.Lock()
		for _, a := range v.Attributes {
			switch a.Name {
			case "minecraft:health":
				// 体力はこちらで動く。SetHealth ではない。実測で殴られても
				// 攻撃検出が一度も発火しなかったのはこの取り違えが原因。
				if a.Value < s.health {
					s.notePlayerAttackLocked()
					s.lastHurt = time.Now()
					// 水中で削られたときだけ残す。息の反射が動かずに溺死した
					// 事例(2026-09-20 20:25)で、削られたことをこちらが見ていたか
					// どうかが分からなかった。
					if s.headInWaterLocked() {
						fmt.Fprintf(os.Stderr, "[sidecar] 水中で削られた 体力 %.0f→%.0f 沈んで %.0fs\n",
							s.health, a.Value, time.Since(s.submergedSince).Seconds())
					}
				}
				s.health = a.Value
			case "minecraft:player.hunger":
				s.food = a.Value
			}
		}
		revived := s.noteRevivedLocked()
		s.mu.Unlock()
		if revived {
			s.emitRespawn()
		}

	case *packet.PlayerList:
		// 誰が今いるかの一覧。Realms は10人までなので、混んできたら
		// ボットは自分から抜ける必要がある。近くのエンティティを数えても
		// 離れた人は見えないので、この一覧でないと人数が分からない。
		// 追加か削除かはエントリごとに付いている。
		s.mu.Lock()
		for _, e := range v.Entries {
			if e.ActionType == protocol.PlayerListActionAdd {
				if e.Username != "" {
					s.online[e.UUID.String()] = e.Username
				}
				continue
			}
			delete(s.online, e.UUID.String())
		}
		names := make([]string, 0, len(s.online))
		for _, n := range s.online {
			names = append(names, n)
		}
		s.mu.Unlock()
		emit(event{Event: "players", Data: map[string]any{
			"count": len(names),
			"names": names,
		}})

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
			Item:      v.Item,
		}
		s.unique[v.EntityUniqueID] = v.EntityRuntimeID
		s.mu.Unlock()

	case *packet.AddActor:
		name := strings.TrimPrefix(v.EntityType, "minecraft:")
		pos := mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]}
		s.mu.Lock()
		s.entities[v.EntityRuntimeID] = &entityInfo{
			RuntimeID: v.EntityRuntimeID,
			UniqueID:  v.EntityUniqueID,
			Name:      name,
			Type:      name,
			Pos:       pos,
		}
		s.unique[v.EntityUniqueID] = v.EntityRuntimeID
		// 村人がいる=村がある可能性が高い。逃げ込む先の候補として覚える。
		s.villagerSafeSpotLocked(name, pos)
		s.mu.Unlock()

	case *packet.TakeItemActor:
		// 拾った。統合版は持ち物の更新を送ってこないので、自分で足す。
		// これをしないと、掘って拾えているのに持ち物が再接続まで古いままで、
		// 採集スキルが「壊したのに何も得ていない」と報告し続ける。
		if v.TakerEntityRuntimeID != s.game.EntityRuntimeID {
			return
		}
		s.mu.Lock()
		if e, ok := s.entities[v.ItemEntityRuntimeID]; ok && e.Type == "item" {
			if os.Getenv("BEDROCK_TRACE_INV") == "1" {
				fmt.Fprintf(os.Stderr, "pickup %s x%d groundID=%d\n",
					e.Name, e.Item.Stack.Count, e.Item.StackNetworkID)
			}
			s.addItemLocked(e.Item)
			delete(s.entities, v.ItemEntityRuntimeID)
			delete(s.unique, e.UniqueID)
		}
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

	case *packet.MoveActorDelta:
		// mob の移動はほぼ全部こちらで来る。MoveActorAbsolute はテレポートや
		// 乗り物など限られた場面にしか使われない。
		//
		// これを読んでいなかったので、羊や牛の位置は湧いた瞬間のまま止まって
		// いた。こちらは「届く距離にいる」と判定して攻撃を送るが、サーバー側の
		// 本当の位置は離れているので取引は黙って捨てられる。実測 2026-09-19、
		// 本番 Realm で羊を20秒に57回殴って一度も減らない、が28回続いた。
		// 持ち物は空で識別子の問題ではなく、ローカルで真隣に湧かせた牛は
		// 倒せていた(動かないので位置がずれない)。名前に反して中身は差分では
		// なく絶対座標で、送られてこない軸は前の値のまま。
		s.mu.Lock()
		if e, ok := s.entities[v.EntityRuntimeID]; ok {
			if x, ok := v.PositionX.Value(); ok {
				e.Pos[0] = x
			}
			if y, ok := v.PositionY.Value(); ok {
				e.Pos[1] = y
			}
			if z, ok := v.PositionZ.Value(); ok {
				e.Pos[2] = z
			}
		}
		s.mu.Unlock()

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
			// キルログや死亡ログは翻訳キー(death.attack.player など)と
			// 差し込み語で来る。語が無いと誰が誰にやられたか分からない。
			"parameters": v.Parameters,
		}})

	case *packet.LevelChunk:
		// この版のサーバーはチャンク本体を勝手に送らない。SubChunkCount が 0 なら
		// 「要求モード」で、こちらが SubChunkRequest を出して初めて中身が届く。
		if v.SubChunkCount == 0 {
			// 座標が確定する前に要求すると、存在しない高さを取りに行くことになる。
			// 列を覚えておいて、要求は別のループに任せる。
			//
			// 既に取った列について LevelChunk が再び届いたら、その列が書き
			// 換わった(まとめて置き換えられた)合図と見て、要求済みの記録を消す。
			// 消さないと requestNearby は「高さが動くまで取り直さない」ので、
			// 写しが古いまま残る。実測 2026-09-19、/fill で建てた石室が写しに
			// 無く、壁の中を歩き抜けて「地表にいる」と読んでいた。
			key := [2]int32{v.Position.X(), v.Position.Z()}
			s.mu.Lock()
			s.known[key] = v.Dimension
			delete(s.requested, key)
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

	case *packet.UpdateSubChunkBlocks:
		// まとめて書き換わったブロック(/fill、爆発、他人の大きな建築)はこちらで
		// 届く。UpdateBlock しか見ていなかったので、こうした変化は自分が上下に
		// 動いてサブチャンクを取り直すまで写しに反映されなかった。実測
		// 2026-09-19、ローカルの採点で /fill した20マスの石の天井が写しに無く、
		// 「地表は2マス上」と読んで籠り続けた。レイヤー0(Blocks)だけ見る。
		// Extra は第2層(水没など)なので、通常ブロックの判定には使わない。
		s.mu.Lock()
		for _, e := range v.Blocks {
			name, ok := blockNameFor(int32(e.BlockRuntimeID))
			if !ok {
				continue
			}
			s.world.setBlock(int32(e.BlockPos[0]), int32(e.BlockPos[1]), int32(e.BlockPos[2]), name)
		}
		s.mu.Unlock()

	case *packet.ContainerOpen:
		s.mu.Lock()
		s.container = &openContainer{
			WindowID: byte(v.WindowID),
			Type:     byte(v.ContainerType),
			Pos:      v.ContainerPosition,
			Slots:    map[int]protocol.ItemInstance{},
		}
		s.mu.Unlock()
		emit(event{Event: "container_open", Data: map[string]any{
			"windowId": v.WindowID,
			"type":     v.ContainerType,
			"position": []int32{v.ContainerPosition.X(), v.ContainerPosition.Y(), v.ContainerPosition.Z()},
		}})

	case *packet.ContainerClose:
		s.mu.Lock()
		if s.container != nil && s.container.WindowID == byte(v.WindowID) {
			s.container = nil
		}
		s.mu.Unlock()
		emit(event{Event: "container_close", Data: map[string]any{"windowId": v.WindowID}})

	case *packet.InventoryContent:
		if os.Getenv("BEDROCK_TRACE_INV") == "1" {
			fmt.Fprintf(os.Stderr, "invContent win=%d n=%d\n", v.WindowID, len(v.Content))
		}
		// WindowID 0 がプレイヤー自身の持ち物。
		// それ以外は開いているコンテナの中身。
		if v.WindowID != 0 {
			s.mu.Lock()
			if s.container != nil && s.container.WindowID == byte(v.WindowID) {
				clear(s.container.Slots)
				for i, item := range v.Content {
					if item.Stack.Count > 0 {
						s.container.Slots[i] = item
					}
				}
				s.container.Filled = true
			}
			s.mu.Unlock()
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
		// サーバーが全スロットを正しい識別子で送り直した。予測は解消。
		s.slotsPredicted = false
		s.mu.Unlock()

	case *packet.InventorySlot:
		if os.Getenv("BEDROCK_TRACE_INV") == "1" {
			cid := int32(-1)
			if c, ok := v.Container.Value(); ok {
				cid = int32(c.ContainerID)
			}
			fmt.Fprintf(os.Stderr, "invSlot win=%d slot=%d container=%d count=%d\n",
				v.WindowID, v.Slot, cid, v.NewItem.Stack.Count)
		}
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
				s.mu.Lock()
				if eff, ok := s.craftEffect[r.RequestID]; ok {
					s.applyCraftLocked(eff)
					delete(s.craftEffect, r.RequestID)
				}
				if mv, ok := s.moveEffect[r.RequestID]; ok {
					// 写しの上で from と to を入れ替える。空の枠へ置いた場合も
					// この形で書ける(空側は削除になる)。
					from, to := mv[0], mv[1]
					a, okA := s.rawSlots[from]
					b, okB := s.rawSlots[to]
					delete(s.rawSlots, from)
					delete(s.rawSlots, to)
					if okA && a.Stack.Count > 0 {
						s.rawSlots[to] = a
						s.syncSlotLocked(to, a)
					} else {
						s.syncSlotLocked(to, protocol.ItemInstance{})
					}
					if okB && b.Stack.Count > 0 {
						s.rawSlots[from] = b
						s.syncSlotLocked(from, b)
					} else {
						s.syncSlotLocked(from, protocol.ItemInstance{})
					}
					delete(s.moveEffect, r.RequestID)
				}
				s.mu.Unlock()
				// 応答には変わったスロットの新しい識別子が入っている。これを
				// 取り込まないと、次の要求で古い StackNetworkID を送ることになり
				// FailedToValidateSrcSlot(49) で拒否される。作業台を置いたあと
				// 3x3 のクラフトが通らなかったのがこれ。
				s.mu.Lock()
				if os.Getenv("BEDROCK_TRACE_CRAFT") == "1" {
					fmt.Fprintf(os.Stderr, "craft reqID=%d ok containers=%d\n", r.RequestID, len(r.ContainerInfo))
					for _, info := range r.ContainerInfo {
						for _, si := range info.SlotInfo {
							fmt.Fprintf(os.Stderr, "  c=%d slot=%d id=%d n=%d\n",
								info.Container.ContainerID, si.Slot, si.StackNetworkID, si.Count)
						}
					}
				}
				touched := 0
				for _, info := range r.ContainerInfo {
					if info.Container.ContainerID != protocol.ContainerCombinedHotBarAndInventory &&
						info.Container.ContainerID != protocol.ContainerInventory &&
						info.Container.ContainerID != protocol.ContainerHotBar {
						continue
					}
					for _, si := range info.SlotInfo {
						touched++
						slot := int(si.Slot)
						it, ok := s.rawSlots[slot]
						if !ok {
							continue
						}
						it.StackNetworkID = si.StackNetworkID
						it.Stack.Count = uint16(si.Count)
						if si.Count == 0 {
							delete(s.rawSlots, slot)
							continue
						}
						s.rawSlots[slot] = it
					}
				}
				s.mu.Unlock()

				// 作った物の識別子はこちらでは分からない。0 のまま次の素材に
				// 使うと FailedToValidateSrcSlot(49) で弾かれる。応答の
				// ContainerInfo にも載ってこない。
				//
				// ContainerClose{0} で一覧を送り直させるつもりだったが、本番
				// Realm では何も返ってこない(実測 2026-09-19)。素材を取った枠の
				// 識別子も変わっているので、成功後の写しは信用しない。予測扱いに
				// して、次の要求の前に resyncSlotsIfPredicted で取り直す。
				// 実測 11:34、ツルハシを作った直後の板材クラフトが、出来上がりを
				// 重ねる先(枠6)の食い違いで CannotPlaceItem(55) を7回続けていた。
				//
				// ただし応答の ContainerInfo に持ち物の枠が載っていれば(2x2 の
				// クラフトでは素材の枠と出来上がりの枠の両方が載る。実測
				// 12:49)、上の取り込みで写しは正しくなっている。予測扱いに
				// するのは載っていなかったときだけ。
				s.mu.Lock()
				if touched == 0 {
					s.slotsPredicted = true
				}
				s.mu.Unlock()
				s.closeOpenScreen()
				s.reply(id, true, "", nil)
			} else {
				// moveSlot・wear もこの待ち行列に相乗りしているので、
				// 「クラフトが」に固定すると持ち替え・装備の失敗までクラフト
				// 用語で誤報することになる。汎用の言い回しにする。
				//
				// status の意味は実測ログの数字を見て当てずっぽうで書かないこと。
				// gophertunnel の ItemStackResponseStatus 定義と数値がずれていた
				// ことがあり(49 を DstContainerAndSlotEqualToSrcContainerAndSlot
				// だと思い込んでいたが、実際は 48。49 は FailedToValidateSrcSlot)、
				// 起きている現象と原因の対応を取り違えたまま放置していた。
				// 識別子のずれが原因なら、黙って諦めない。
				//
				// FailedToValidateSrcSlot(49) は「送ってきた StackNetworkID が
				// 今の中身と合わない」という意味で、こちらの持ち物の写しが
				// 古いときに出る。拾った物は TakeItemActor を見て手元で
				// 予測して足しているので、サーバーが振り直した識別子を
				// こちらは知らないまま使うことになる。
				//
				// 成功時と同じように一覧を送り直させれば、次の要求は正しい
				// 識別子で送れる。これが無いと、一度ずれたあとは何度やっても
				// 同じ理由で弾かれ続ける。実測 2026-09-15 の crafting.weapon は
				// spruce_log を4本持ったまま792回これを繰り返し、
				// 2026-09-17 12:37 にも1分で11回繰り返していた。板材が作れない
				// ので棒も剣も作れず、生存の鎖がここで切れていた。
				if r.Status == protocol.ItemStackResponseStatusFailedToValidateSrcSlot {
					_ = s.conn.WritePacket(&packet.ContainerClose{WindowID: 0})
				}
				s.mu.Lock()
				delete(s.moveEffect, r.RequestID)
				s.mu.Unlock()
				if os.Getenv("BEDROCK_TRACE_CRAFT") == "1" {
					s.mu.Lock()
					fmt.Fprintf(os.Stderr, "craft reqID=%d rejected status=%d predicted=%v containers=%d\n",
						r.RequestID, r.Status, s.slotsPredicted, len(r.ContainerInfo))
					for slot, it := range s.rawSlots {
						fmt.Fprintf(os.Stderr, "  slot=%d net=%d id=%d n=%d\n",
							slot, it.Stack.ItemType.NetworkID, it.StackNetworkID, it.Stack.Count)
					}
					s.mu.Unlock()
				}
				s.closeOpenScreen()
				s.reply(id, false, fmt.Sprintf("操作が拒否されました(status=%d)", r.Status), nil)
			}
		}

	case *packet.ActorEvent:
		// 負傷・死亡などの合図。攻撃が当たっているかの、いちばん直接の証拠。
		if os.Getenv("ONJ_TRACE_HIT") != "" {
			fmt.Fprintf(os.Stderr, "[sidecar] ActorEvent 相手=%d 種類=%d\n",
				v.EntityRuntimeID, v.EventType)
		}

	case *packet.UpdateAbilities:
		// サーバーが配る「してよいこと」。攻撃が黙って効かないときに、
		// ここで mob への攻撃が落ちていることがある。読めるようにしておく。
		for _, layer := range v.AbilityData.Layers {
			fmt.Fprintf(os.Stderr,
				"[sidecar] 権限 type=%d (攻撃mob=%v 攻撃player=%v 建築=%v 採掘=%v)\n",
				layer.Type,
				layer.Values&protocol.AbilityAttackMobs != 0,
				layer.Values&protocol.AbilityAttackPlayers != 0,
				layer.Values&protocol.AbilityBuild != 0,
				layer.Values&protocol.AbilityMine != 0)
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
		// 時刻は自前で進める。
		//
		// 統合版の SetTime は接続時と、時刻が飛んだとき(就寝・/time set)に
		// しか来ない。受け取ったきりの値を使うと時刻が止まったままになり、
		// 夜がいつまでも来ない。実測、接続から15分たっても sunrise のまま
		// で、「夜で丸腰」の反射は残っている全ログを通して一度も発火して
		// いなかった。夜にこもれなかった本当の理由はこれ。
		// クライアントは本来こうして自前で進める。SetTime が届いたら
		// そちらへ合わせ直す(上の handlePacket)。
		s.mu.Lock()
		if !s.dayCycleStopped {
			s.worldTick++
		}
		s.mu.Unlock()
		s.checkDig()
		if err := s.conn.WritePacket(s.buildInput(n)); err != nil {
			s.close(fmt.Sprintf("入力の送信に失敗: %v", err))
			return
		}
		// 攻撃はこの tick の入力の直後に送る。順番に意味がある。
		s.mu.Lock()
		atk := s.pendingAttack
		s.pendingAttack = nil
		s.mu.Unlock()
		if atk != nil {
			// 本物のクライアントは殴るたびに腕を振る。
			_ = s.conn.WritePacket(&packet.Animate{
				ActionType:      packet.AnimateActionSwingArm,
				EntityRuntimeID: s.game.EntityRuntimeID,
				SwingSource:     packet.AnimateSwingSourceAttack,
			})
			_ = s.conn.WritePacket(&packet.InventoryTransaction{TransactionData: atk})
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

	// 危険への反応は目標より先。逃げるか殴るかは毎tick決める。
	// スキルの合間に見るのでは間に合わない。Java版が mineflayer-pvp に
	// 任せていたのと同じ層をここに置く。
	if !s.defendLocked(n) {
		s.steerLocked(n)
	}

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
	// 水に浸かっている間は跳び続ける。実プレイヤーは水中でジャンプを押し
	// っぱなしにして水面に浮き、呼吸を確保している。ボットはそれをしないので
	// 沈んだまま溺れる。実測で死因の筆頭が death.attack.drown だった。
	//
	// スキルの合間に見るのでは遅い。息が続くのは十数秒で、その間に何度も
	// 判断が挟まる保証が無い。毎tickここで見る。
	swimming := s.inLiquidLocked()
	// 息。跳び続けても水面に出られない場所(天井のある水路、水没した縦穴)
	// がある。頭まで沈んだまま数秒たったら、目標より命を優先する。
	s.breatheLocked()
	if s.controls["jump"] || swimming {
		flags.Set(packet.InputFlagJumping)
		flags.Set(packet.InputFlagStartJumping)
	}
	if swimming {
		// 水に入った瞬間、直前の落下速度(airborne/vy)が残っていると、
		// 下の跳躍計算(s.airborne)がそのマイナス vy を毎tick足し続け、
		// ここで足す浮上分を数tickぶん打ち消して沈み続ける。着水は
		// 着地と同じ扱いにして、まず落下状態を断ち切る。
		s.airborne = false
		s.vy = 0
		// 水中は地面を蹴らないので上の跳躍計算に乗らない。浮き上がるぶんを
		// ここで足す。バニラの水中上昇はおよそ 0.04/tick。
		s.pos[1] += 0.04
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
	// 頭上が塞がっていれば跳ばない。跳ぶと予測位置の頭が天井に入り、
	// サーバーがそれを受けると窒息ダメージになる(death.attack.inWall、全ログで
	// 8件)。階段掘りの途中の 2 マス高の通路で「進めないので跳ぶ」が出るとこれ。
	if s.controls["jump"] && s.onGround && !s.airborne && !s.ceilingAboveLocked() {
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
			// 進む先が固いブロックなら予測を進めない。補正に任せると、引き戻される
			// までの数tick、予測位置が壁の中にあり、サーバーがそのまま受けると
			// 窒息になる。壁の中へは自分から入らない。
			if !s.wallAheadLocked(delta) {
				s.pos[0] += delta[0]
				s.pos[2] += delta[2]
			} else {
				delta = mgl32.Vec3{}
			}
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
	} else if p := s.digStop; p != nil {
		// 終わった採掘の「やめた」を一度だけ送る。
		flags.Set(packet.InputFlagPerformBlockActions)
		pk.BlockActions = protocol.Option([]protocol.PlayerBlockAction{{
			Action:   protocol.PlayerActionStopBreak,
			BlockPos: *p,
		}})
		s.digStop = nil
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
	// 高さを指定されているなら、そこも合わせる。1段ぶんは許す。
	heightOK := true
	if g.hasY {
		limit := 1.5
		if g.strictY {
			limit = 0.5
		}
		heightOK = math.Abs(float64(s.feetLocked()[1]-g.y)) <= limit
	}
	if dist <= g.tolerance && heightOK {
		s.finishGoalLocked(true, "")
		return
	}
	if time.Now().After(g.deadline) {
		// 水平距離だけでは何が起きたのか分からない。高さの差と、
		// 柱を積める足場の数を添える。実測、地下27メートルで
		// 「残り 0.0 ブロック」とだけ出て、上がれない理由が読めなかった。
		gap := float64(0)
		if g.hasY {
			gap = float64(g.y - s.feetLocked()[1])
		}
		s.finishGoalLocked(false, fmt.Sprintf(
			"目標に届かなかった（残り %.1f ブロック / 高さ差 %.1f / 足場 %d / 経路 %d手）",
			dist, gap, s.capsLocked().Blocks, len(g.path)))
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
		goalY := from.Y
		if g.hasY {
			goalY = int32(math.Floor(float64(g.y)))
		}
		to := blockPos{int32(math.Floor(float64(gx))), goalY, int32(math.Floor(float64(gz)))}
		tol := float64(g.tolerance)
		// 高さも合わせるのは、最終目標をそのまま狙えるときだけ。
		// 遠くて中間地点に切り詰めたときは、その手前の地点で最終的な高さに
		// 合わせる意味が無い(たいてい届かず、経路が引けなくなる)。
		matchY := g.hasY
		if dist > planReach {
			// 中間地点なので、そこにぴったり着く必要はない。
			tol = 1
			matchY = false
		}
		caps := s.capsLocked()
		if g.noDig {
			caps.CanDig = false
		}
		g.path = s.world.findPath(from, to, tol, matchY, planMaxNodes, caps)

		// 水を使った経路は珍しいので記録する。掘る・積むに次ぐ3本目の
		// 上がり方として、実際に使えているかを後から確かめられるように。
		swims := 0
		for _, st := range g.path {
			if st.Action == stepSwim || st.Action == stepSwimUp {
				swims++
			}
		}
		if swims > 0 {
			fmt.Fprintf(os.Stderr, "[sidecar] 水を使う経路を引いた（%d手中 %d手が泳ぎ）\n",
				len(g.path), swims)
		}
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
		// 下ごしらえの前に一旦倒す。順番が要る。
		//
		// 以前はここが prepareStepLocked の**後**にあり、柱積み(stepTower)や
		// 浮上(stepSwimUp)が「跳ぶ」ために立てた jump を、その場で打ち消して
		// いた。跳ばないので空中に行けず、空中に行けないので足元に置けず、
		// 置けないので永久に終わらない。実測 2026-09-18 10:08〜10:11、
		// 動作5(柱積み)だけが繰り返し諦められ、地表まで14〜22マスの穴から
		// 一度も上がれなかった。
		s.controls["forward"] = false
		s.controls["jump"] = false
		if !s.prepareStepLocked(st) {
			if !g.waiting || g.waitStep != st.Pos {
				g.waiting = true
				g.waitStep = st.Pos
				g.waitStart = time.Now()
			} else if time.Since(g.waitStart) > stepWaitLimit {
				// この歩は終わらない。経路ごと捨てて引き直す。
				s.abandonStepLocked(g, st)
				return
			}
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

	// 経路が引けていないときは、深い落差にも踏み込まない。
	//
	// 経路があるときの落下は stepFall(maxDrop)までに限られる。無いときは
	// 目標へ真っ直ぐ歩くので、線上に崖や洞窟の口があっても止まらない。
	// 実測 2026-09-16、Y=38 まで登った直後に goto.coords が経路無しで歩き、
	// 1分で Y=17 まで落ちた。別の場面でも Y=54→38。階段掘りで登るのは
	// 1分3マス、落ちるのは1分12マス。登る側を速くするより、落ちる側を
	// 止める方が効く。
	if len(g.path) == 0 && s.bigDropAheadLocked() {
		s.controls["forward"] = false
		s.controls["jump"] = false
		return
	}

	// 踏み出す先が火や溶岩なら踏み込まない。
	//
	// 経路が引けなかったとき、ここは目標へ真っ直ぐ歩く。その線上に何が
	// あっても止まらない。実測 2026-09-13 15:06、goto.coords で拠点の
	// チェストへ向かう途中、火の中へ歩いて入って焼け死んだ。経路の有無に
	// 関わらず、足を出す先だけは必ず見る。止まれば目標は時間切れになるが、
	// 死ぬよりは良い。
	if s.hazardAheadLocked() {
		s.controls["forward"] = false
		s.controls["jump"] = false
		// 同じ方向へ出し続けても仕方がない。引き直させる。
		g.path = nil
		return
	}
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

// bigDropAheadLocked は、今向いている方向のすぐ先が深い落差か。
//
// 経路探索が落ちてよいと認める段差(maxDrop)を超えて、着地点が見つからない
// ときだけ真を返す。水は落ちても死なないので通す。未取得のマスは「分からない」
// として通す。分からないものを全部塞ぐと、チャンクの境目で足が止まる。
// この関数は経路が引けていないときにしか呼ばない(計画された落下は妨げない)。
func (s *session) bigDropAheadLocked() bool {
	feet := s.feetLocked()
	fy := int32(math.Floor(float64(feet[1])))

	rad := float64(s.yaw) * math.Pi / 180
	dx := float32(-math.Sin(rad))
	dz := float32(math.Cos(rad))
	for _, reach := range []float32{0.6, 1.2} {
		x := int32(math.Floor(float64(feet[0] + dx*reach)))
		z := int32(math.Floor(float64(feet[2] + dz*reach)))
		// 踏み出す先に床があるなら崖ではない。
		if s.world.solidFloor(blockPos{x, fy - 1, z}) {
			continue
		}
		landed := false
		for dy := int32(1); dy <= maxDrop+1; dy++ {
			p := blockPos{x, fy - dy, z}
			if _, ok := s.world.blockAt(p.X, p.Y, p.Z); !ok {
				// 読めていない。決めつけない。
				landed = true
				break
			}
			if s.world.inWater(p) || s.world.solidFloor(p) {
				landed = true
				break
			}
		}
		if !landed {
			return true
		}
	}
	return false
}

// hazardAheadLocked は、今向いている方向のすぐ先が踏んではいけない場所か。
//
// 足元・足の高さ・頭の高さの3段を見る。溶岩は落ちれば即死、火は歩いて
// 抜けても燃え続ける。1歩ぶん(0.6)と2歩ぶん(1.2)の先を見て、どちらかが
// 危ないなら踏み込まない。
//
// 既に危険の中にいるときは止めない。止めたらそこで焼かれ続けるだけで、
// 出るにはどこかへ歩くしかない。
// 呼び出し側が mu を持つこと。
func (s *session) hazardAheadLocked() bool {
	feet := s.feetLocked()
	fx := int32(math.Floor(float64(feet[0])))
	fy := int32(math.Floor(float64(feet[1])))
	fz := int32(math.Floor(float64(feet[2])))
	if name, ok := s.world.blockAt(fx, fy, fz); ok && hazardBlocks[name] {
		return false
	}

	rad := float64(s.yaw) * math.Pi / 180
	dx := float32(-math.Sin(rad))
	dz := float32(math.Cos(rad))
	for _, reach := range []float32{0.6, 1.2} {
		x := int32(math.Floor(float64(feet[0] + dx*reach)))
		z := int32(math.Floor(float64(feet[2] + dz*reach)))
		for _, dy := range []int32{-1, 0, 1} {
			if name, ok := s.world.blockAt(x, fy+dy, z); ok && hazardBlocks[name] {
				return true
			}
		}
	}
	return false
}

// enclosedLocked は、その場が本当に囲まれた隠れ場所か。
//
// 頭上だけを見ると、洞窟の天井や木の下でも「隠れている」ことになる。
// 自分で掘って蓋をした穴は、四方と頭上が塞がっている。そこまで求める。
// 未取得のマスは塞がっていないものとして扱う(分からないなら逃げる側に倒す)。
// 呼び出し側が mu を持つこと。
func (s *session) enclosedLocked(feet mgl32.Vec3) bool {
	fx := int32(math.Floor(float64(feet[0])))
	fy := int32(math.Floor(float64(feet[1])))
	fz := int32(math.Floor(float64(feet[2])))
	if name, ok := s.world.blockAt(fx, fy+2, fz); !ok || name == "air" {
		return false
	}
	for _, d := range [4][2]int32{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
		// 足の高さと頭の高さ、どちらかが開いていれば出入りできる。
		for _, dy := range []int32{0, 1} {
			name, ok := s.world.blockAt(fx+d[0], fy+dy, fz+d[1])
			if !ok || passableBlocks[name] {
				return false
			}
		}
	}
	return true
}

// defendLocked は敵が近いときの反応。処理したなら true を返し、
// その tick は通常の移動を行わない。
//
// 逃げるか殴るかはここで決める。判断を上位へ投げると、スキルの切れ目まで
// 何も起きない。息継ぎと同じで、間に合わなければ意味が無い。
// 呼び出し側が mu を持つこと。
func (s *session) defendLocked(n uint64) bool {
	feet := s.feetLocked()

	// 殴ってきたプレイヤーからは、何をおいても離れる。殴り返すと事が
	// 大きくなるだけで、こちらに得が無い。
	if time.Now().Before(s.playerThreatUntil) {
		if e, ok := s.entities[s.playerThreat]; ok {
			d := e.Pos.Sub(feet).Len()
			if d < playerFleeRange {
				dx := e.Pos[0] - s.pos[0]
				dz := e.Pos[2] - s.pos[2]
				s.yaw = float32(math.Atan2(float64(dx), float64(-dz)) * 180 / math.Pi)
				// 逃げた先が火や溶岩では意味が無い。殴られる方がまし。
				if s.hazardAheadLocked() {
					s.controls["forward"] = false
					s.controls["sprint"] = false
					return true
				}
				s.controls["forward"] = true
				s.controls["sprint"] = true
				if n%4 == 0 {
					moved := s.pos.Sub(s.defendLastPos).Len()
					if moved < 0.05 {
						s.defendStalledTicks++
					} else {
						s.defendStalledTicks = 0
					}
					s.defendLastPos = s.pos
				}
				s.controls["jump"] = s.defendStalledTicks >= 2
				s.fighting = 0
				return true
			}
		}
	}

	// 敵への先制攻撃・反応。
	// 武器を持っている場合は、遠距離モブは14ブロックから先制ダッシュで詰め、
	// ゾンビなどは9ブロックから能動的に急襲して先手を取る。
	// 丸腰(素手)の場合は、ダメージ効率が悪いため遠くの敵には突っ込まず、
	// 接近してきた敵(6ブロック、スケルトンは12ブロック)から確実に逃げる。
	isHurtRecently := time.Since(s.lastHurt) < hurtMemory
	isArmed := s.hasWeaponLocked()

	var target *entityInfo
	var best float32 = 999.0
	for _, e := range s.entities {
		if !hostileName(e.Name) {
			continue
		}
		d := e.Pos.Sub(feet).Len()

		maxDist := defendRangeNearby
		if !isArmed {
			maxDist = float32(6)
		}
		if strings.Contains(e.Name, "skeleton") || strings.Contains(e.Name, "stray") || strings.Contains(e.Name, "pillager") {
			if isArmed {
				maxDist = defendRangeRanged
			} else {
				maxDist = float32(12)
			}
		} else if strings.Contains(e.Name, "creeper") {
			maxDist = defendRangeCreeper
		}
		if isHurtRecently {
			maxDist = hurtDefendRange
		}

		if d > maxDist || d >= best {
			continue
		}
		// 壁の向こうの敵には反応しない。見えていない相手から逃げ続けると、
		// 安全な場所にいるのに動き回って別の危険に当たる。
		// mindcraft も self_defense / cowardice の両方で isClearPath を見ている。
		if !s.clearPathLocked(feet, e.Pos) {
			continue
		}
		best = d
		target = e
	}
	if target == nil {
		s.fighting = 0
		s.fleeSince = 0
		s.defendStalledTicks = 0
		return false
	}

	// 逃げる条件：
	// 1. 武器が無い(!s.hasWeaponLocked())。素手は1打点(ハート0.5個)とダメージ効率が極めて悪く、
	//    敵を倒す前に削り殺されるため、武器を持つまでは戦わずに確実に逃げる。
	// 2. 体力が減っている(s.health <= defendFleeHealth)。
	// 3. 相手がクリーパー(自爆の危険)。
	flee := !s.hasWeaponLocked() ||
		s.health <= defendFleeHealth ||
		strings.Contains(target.Name, "creeper")
	// LLM の構えが優先。fight は瀕死のときだけ従来判断に戻す(死ぬのは早い)。
	switch s.stance {
	case "flee":
		flee = true
	case "fight":
		flee = s.health <= defendFleeHealth
	}

	dx := target.Pos[0] - s.pos[0]
	dz := target.Pos[2] - s.pos[2]
	isHurtNow := time.Since(s.lastHurt) < hurtMemory
	if flee {
		// 既に潜って蓋をしているなら、走り出さない。せっかくの隠れ場所から
		// 出ていくことになる。
		//
		// ただし「頭上が空気でない」だけで隠れ場所と見なしてはいけない。
		// 洞窟の天井・木の下・建物の中・岩の張り出し、どれもこの条件を
		// 満たす。ボットは大半の時間を地下で過ごすので、事実上いつでも
		// 「隠れている」ことになり、殴られている最中でも逃げずに突っ立つ。
		// 実測 2026-09-17 00:53〜00:57、ゾンビに3回殺される間ずっと
		// その場に立っていた。四方が塞がっているかまで見る。
		//
		// さらに、今まさに殴られているなら隠れ場所として機能していない。
		// 囲まれていようと、そこに留まる理由にはならない。
		if !isHurtNow && s.enclosedLocked(feet) {
			s.fighting = 0
			return false
		}
		// 逃げるのは一定時間まで。過ぎたら本来の行動へ戻し、まだ危なければ
		// 間隔を置いてまた逃げる。走りっぱなしだと何も進まない。
		//
		// ただし敵がすぐ近く(fleeGiveUpRange未満)にいる間は、このタイマーを
		// 無視して逃げ続ける。ここで機械的に切り上げると、敵が隣にいるのに
		// 無防備な通常行動へ戻り、殴られ続けて死ぬ。
		nearby := best < fleeGiveUpRange
		if s.fleeSince == 0 {
			if n < s.fleeUntil+fleeCooldownTicks && !nearby {
				return false
			}
			s.fleeSince = n
		}
		if n-s.fleeSince > fleeMaxTicks && !nearby {
			s.fleeSince = 0
			s.fleeUntil = n
			s.controls["sprint"] = false
			return false
		}
		// 背を向けて走るだけでは、逃げた先でまた別の敵に出くわすだけになる。
		// 村・ベッド・拠点として覚えている場所が近くにあれば、そこを目指す。
		// 敵をはさんで反対側にあるような場所へは行かせない(away と大まかに
		// 同じ向きのときだけ採用する)。
		away := mgl32.Vec2{-dx, -dz}
		if sp, ok := s.nearestSafeSpotLocked(feet, safeSpotSeekRange); ok &&
			safeSpotDirectionHelps(feet, sp.Pos, away) {
			d := sp.Pos.Sub(feet).Len()
			if d <= safeSpotArriveRange && !isHurtNow {
				// もう着いている。ここでじっとして様子を見た方がよい。
				// 殴られている間は別で、じっとしていると削り殺される。
				s.controls["forward"] = false
				s.controls["sprint"] = false
				s.fighting = 0
				return true
			}
			sx, sz := sp.Pos[0]-s.pos[0], sp.Pos[2]-s.pos[2]
			s.yaw = float32(math.Atan2(float64(-sx), float64(sz)) * 180 / math.Pi)
			s.controls["forward"] = true
			s.controls["sprint"] = true
			s.controls["jump"] = false
			s.fighting = 0
			return true
		}

		// 覚えている安全地帯が無い・使えないときは、従来どおり背を向けて走る。
		s.yaw = float32(math.Atan2(float64(dx), float64(-dz)) * 180 / math.Pi)
		s.controls["forward"] = true
		s.controls["sprint"] = true

		// 移動が詰まっていれば段差とみなして跳ぶ。平地の1マス段差で引っかかって追いつかれるのを防ぐ。
		if n%4 == 0 {
			moved := s.pos.Sub(s.defendLastPos).Len()
			if moved < 0.05 {
				s.defendStalledTicks++
			} else {
				s.defendStalledTicks = 0
			}
			s.defendLastPos = s.pos
		}
		s.controls["jump"] = s.defendStalledTicks >= 2
		s.fighting = 0
		return true
	}
	s.fleeSince = 0

	// 殴る前に一番強い武器へ持ち替える。手に持っている物のまま殴ると、
	// 剣を持っていてもツルハシで殴ることになる。
	s.holdBestWeaponLocked()
	// 殴る。相手の胸〜頭部(足元 + 1.2)を狙う。足元を向いていると視線が地面を指して空振りする。
	s.lookAtLocked(target.Pos[0], target.Pos[1]+1.2, target.Pos[2])

	// スタック検知
	if n%4 == 0 {
		moved := s.pos.Sub(s.defendLastPos).Len()
		if moved < 0.05 {
			s.defendStalledTicks++
		} else {
			s.defendStalledTicks = 0
		}
		s.defendLastPos = s.pos
	}

	// 間合い管理 (Preemptive Sprint Attack & Kiting)
	// 1. 間合いの外(> attackReach)なら常にスプリントダッシュで一気に詰めて急襲する。
	//    走って殴る(スプリントアタック)ことで強ノックバックが発生し、敵を大きく弾き飛ばす。
	// 2. 至近距離(< 2.0)に密着されたら後退して間合いを保つ(Kiting)。
	// 3. 適正間合い(2.0 〜 3.5)なら前進スプリントを効かせて強打を維持する。
	if best > attackReach {
		s.controls["forward"] = true
		s.controls["back"] = false
		s.controls["sprint"] = true
		s.controls["jump"] = s.defendStalledTicks >= 2
		return true
	} else if best < 2.0 && !strings.Contains(target.Name, "skeleton") {
		// 近接モブに密着されたら後退して間合いを取り被弾を避ける
		s.controls["forward"] = false
		s.controls["back"] = true
		s.controls["sprint"] = false
		s.controls["jump"] = s.defendStalledTicks >= 2
	} else {
		// 適正間合いでもスプリント前進を入れてノックバックを最大化
		s.controls["forward"] = true
		s.controls["back"] = false
		s.controls["sprint"] = true
		s.controls["jump"] = false
	}

	// 振る間隔。統合版に適したレート(約0.3秒)で叩き、ノックバックで敵を近づかせない。
	if n-s.fighting >= attackIntervalTicks || s.fighting == 0 {
		s.fighting = n
		_ = s.conn.WritePacket(&packet.InventoryTransaction{
			TransactionData: &protocol.UseItemOnEntityTransactionData{
				TargetEntityRuntimeID: target.RuntimeID,
				ActionType:            protocol.UseItemOnEntityActionAttack,
				HotBarSlot:            s.heldSlot,
				HeldItem:              s.rawSlots[int(s.heldSlot)],
				Position:              s.pos,
				ClickedPosition:       mgl32.Vec3{0, 1, 0},
			},
		})
	}
	return true
}

// clearPathLocked は from から to まで、固いブロックに遮られていないか。
// 目線の高さから相手の胴あたりへ、粗く辿って見る。
// 呼び出し側が mu を持つこと。
func (s *session) clearPathLocked(from, to mgl32.Vec3) bool {
	eye := mgl32.Vec3{from[0], from[1] + eyeHeight, from[2]}
	aim := mgl32.Vec3{to[0], to[1] + 1, to[2]}
	d := aim.Sub(eye)
	dist := d.Len()
	if dist < 0.5 {
		return true
	}
	steps := int(dist * 2)
	for i := 1; i < steps; i++ {
		t := float32(i) / float32(steps)
		p := eye.Add(d.Mul(t))
		name, ok := s.world.blockAt(
			int32(math.Floor(float64(p[0]))),
			int32(math.Floor(float64(p[1]))),
			int32(math.Floor(float64(p[2]))),
		)
		if !ok {
			continue
		}
		if !passableBlocks[name] {
			return false
		}
	}
	return true
}

// holdBestWeaponLocked はホットバーで一番強い武器を手に持つ。
// 呼び出し側が mu を持つこと。
func (s *session) holdBestWeaponLocked() {
	rank := []string{"netherite", "diamond", "iron", "stone", "golden", "wooden"}
	bestSlot := -1
	bestRank := len(rank)
	// ホットバー(0..8)の外も見る。
	//
	// 拾った物や作った物がどのスロットに入るかはこちらで決められない。
	// ホットバーだけを見ていたので、作った木の剣が9番以降に入ると
	// 永久に握られず、素手で殴り続けることになっていた。素手の攻撃力は1、
	// 木の剣は4。牛(体力10)を倒すのに10発と3発の差になる。
	// 置ける物を握る側(holdPlaceableLocked)は既に奥から移して握っている。
	for _, it := range s.slots {
		if it.Slot < 0 || it.Slot > 35 {
			continue
		}
		if !strings.HasSuffix(it.Name, "_sword") && !strings.HasSuffix(it.Name, "_axe") {
			continue
		}
		r := len(rank)
		for i, m := range rank {
			if strings.HasPrefix(it.Name, m) {
				r = i
				break
			}
		}
		// 同じ素材なら剣を優先する。
		if strings.HasSuffix(it.Name, "_axe") {
			r++
		}
		if r < bestRank {
			bestRank = r
			bestSlot = it.Slot
		}
	}
	if bestSlot < 0 || int32(bestSlot) == s.heldSlot {
		return
	}
	// ホットバーの外にあるなら、先に手前の枠へ移す。握るのは移ってから。
	//
	// MobEquipment は選ぶだけで物を動かさない。HotBarSlot に 9 以上を
	// 入れても枠が無いし、InventorySlot だけ奥を指しても、サーバーは
	// 「主張が違う」と持ち物一式を送り返してくるだけで剣は奥のまま
	// (実測 2026-09-19 11:15、13秒間の攻撃中に InventoryContent が20回)。
	// 移すのは ItemStackRequest(moveSlot と同じ)で、応答が来るまで
	// 同じ要求を重ねない。
	if bestSlot > 8 {
		if time.Since(s.weaponMoveAt) < 3*time.Second {
			return
		}
		s.weaponMoveAt = time.Now()
		src := s.rawSlots[bestSlot]
		inv := protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory}
		dst := -1
		for slot := 0; slot <= 8; slot++ {
			if item, ok := s.rawSlots[slot]; !ok || item.Stack.Count == 0 {
				dst = slot
				break
			}
		}
		var action protocol.StackRequestAction
		if dst < 0 {
			// ホットバーが満杯なら末尾と入れ替える。
			dst = 8
			swap := &protocol.SwapStackRequestAction{}
			swap.Source = protocol.StackRequestSlotInfo{
				Container: inv, Slot: byte(bestSlot), StackNetworkID: src.StackNetworkID,
			}
			swap.Destination = protocol.StackRequestSlotInfo{
				Container: inv, Slot: byte(dst), StackNetworkID: s.rawSlots[dst].StackNetworkID,
			}
			action = swap
		} else {
			place := &protocol.PlaceStackRequestAction{}
			place.Count = byte(min(src.Stack.Count, 64))
			place.Source = protocol.StackRequestSlotInfo{
				Container: inv, Slot: byte(bestSlot), StackNetworkID: src.StackNetworkID,
			}
			place.Destination = protocol.StackRequestSlotInfo{
				Container: inv, Slot: byte(dst), StackNetworkID: 0,
			}
			action = place
		}
		s.craftReqID -= 2
		reqID := s.craftReqID
		// 応答は誰も待たない(id 0)。成功なら moveEffect で写しを入れ替える。
		s.craftWaiter[reqID] = 0
		s.moveEffect[reqID] = [2]int{bestSlot, dst}
		// 奥の枠を触る要求は、持ち物の画面を開いていないと拒否される(moveSlot 参照)。
		_ = s.conn.WritePacket(&packet.Interact{
			ActionType:            packet.InteractActionOpenInventory,
			TargetEntityRuntimeID: s.game.EntityRuntimeID,
		})
		_ = s.conn.WritePacket(&packet.ItemStackRequest{
			Requests: []protocol.ItemStackRequest{{RequestID: reqID, Actions: []protocol.StackRequestAction{action}}},
		})
		return
	}
	s.heldSlot = int32(bestSlot)
	_ = s.conn.WritePacket(&packet.MobEquipment{
		EntityRuntimeID: s.game.EntityRuntimeID,
		NewItem:         s.rawSlots[bestSlot],
		InventorySlot:   byte(bestSlot),
		HotBarSlot:      byte(bestSlot),
	})
}

// hasWeaponLocked は所持品（ホットバーまたはメインインベントリ）に殴れる物があるか。
func (s *session) hasWeaponLocked() bool {
	for slot := 0; slot <= 35; slot++ {
		it, ok := s.rawSlots[slot]
		if !ok || it.Stack.Count == 0 {
			continue
		}
		if name, ok := s.itemNames[it.Stack.ItemType.NetworkID]; ok {
			if strings.HasSuffix(name, "_sword") || strings.HasSuffix(name, "_axe") {
				return true
			}
		}
	}
	return false
}

// notePlayerAttackLocked は、体力が減った瞬間に近くにいたプレイヤーを
// 「殴ってきた相手」として覚える。
//
// 統合版は誰に殴られたかを直接は教えてくれない。間合いにいるプレイヤーが
// 犯人である可能性が高い、という当たりの付け方をする。外れても害は小さい。
// 逃げるだけで、殴り返しはしないため。
// 呼び出し側が mu を持つこと。
func (s *session) notePlayerAttackLocked() {
	feet := s.feetLocked()
	var nearest *entityInfo
	best := float32(playerThreatRange)
	for _, e := range s.entities {
		if !e.IsPlayer {
			continue
		}
		d := e.Pos.Sub(feet).Len()
		if d < best {
			best = d
			nearest = e
		}
	}
	if nearest == nil {
		return
	}
	s.playerThreat = nearest.RuntimeID
	s.playerThreatUntil = time.Now().Add(playerThreatDuration)
	emit(event{Event: "attacked_by_player", Data: map[string]any{
		"name":     nearest.Name,
		"distance": best,
	}})
}

// hostileName は襲ってくる相手か。名前で判断する。
func hostileName(name string) bool {
	for _, h := range []string{
		"zombie", "skeleton", "creeper", "spider", "enderman", "witch", "drowned",
		"husk", "stray", "phantom", "slime", "magma_cube", "pillager", "vindicator",
		"ravager", "evocation_illager", "blaze", "piglin", "hoglin", "wither",
		"guardian", "silverfish", "endermite", "vex",
	} {
		if strings.Contains(name, h) {
			return true
		}
	}
	return false
}

func (s *session) finishGoalLocked(ok bool, errMsg string) {
	g := s.goal
	if g == nil {
		return
	}
	s.controls["forward"] = false
	s.controls["jump"] = false
	s.goal = nil
	if g.id == escapeGoalID {
		// 脱出の結末は TS 側に受け手が無いので、ここで残す。「着いたのに頭が
		// 水」なら写しが間違っている。「着けない」なら流されているか進めない。
		// どちらか分からないと直せない(2026-09-20 17:19 の溺死はここが無くて
		// 切り分けられなかった)。補正回数と最大ずれは接続開始からの累計。
		feet := s.feetLocked()
		fmt.Fprintf(os.Stderr,
			"[sidecar] 脱出目標 終了 ok=%v %s 足元=(%.1f,%.1f,%.1f) 目標=(%.1f,%.1f,%.1f) 頭が水=%v 補正=%d 最大ずれ=%.2f\n",
			ok, errMsg, feet[0], feet[1], feet[2], g.x, g.y, g.z, s.headInWaterLocked(), s.corrections, s.maxDrift)
	}
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
	// 1歩の下ごしらえ(掘る/置く)を待ってよい時間。
	//
	// 素手の採掘は遅い。統合版で石は約7.5秒、深層岩なら倍近くかかる。
	// 8秒にしていたら、階段を刻む歩(stepDigUp)が毎回わずかに間に合わず、
	// 同じ場所で3回諦めて目標ごと失敗していた(実測 2026-09-18 10:00、
	// (-8,65,61) で動作8を3回)。掘り切れる長さは要る。
	// ただし目標の制限時間(30秒)を1歩で食い潰さない長さに抑える。
	stepWaitLimit = 12 * time.Second
	// 下ごしらえを諦めた回数の上限。これを超えたら目標ごと失敗にする。
	stepAbandonLimit = 3
)

// abandonStepLocked は、終わらない下ごしらえを諦めて経路を引き直させる。
//
// 同じ経路を引き直せば同じ歩でまた止まるので、回数を数えて、続くようなら
// 目標そのものを失敗にする。立ち止まったまま制限時間を使い切るより、
// 早く失敗を返した方がよい。呼び出し側(スキル)はそれを見て別の手を選べるが、
// 何も返ってこない30秒からは何も学べない。
func (s *session) abandonStepLocked(g *target, st step) {
	g.abandoned++
	g.path = nil
	g.waiting = false
	// 進まない採掘を抱えたままだと、次の経路でも同じところで待つ。
	// 移動のための採掘(id 0)だけを捨てる。命令された採掘は触らない。
	if s.digging != nil && s.digging.id == 0 {
		s.digging = nil
	}
	// すぐ引き直させる。
	g.lastPlan = time.Time{}
	fmt.Fprintf(os.Stderr,
		"[sidecar] 下ごしらえが終わらない歩を諦めた（%d回目 / 動作%d / (%d,%d,%d)）\n",
		g.abandoned, int(st.Action), st.Pos.X, st.Pos.Y, st.Pos.Z)
	if g.abandoned >= stepAbandonLimit {
		s.finishGoalLocked(false, fmt.Sprintf(
			"進めない歩で%d回止まった（掘れないか、置けない）", g.abandoned))
	}
}

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
		// 息の反射が空気へ向かっている間は、新しい移動を受けない。受けると
		// 反射が次のtickでそれを「息が続かない」で潰し、スキルがまた出す、の
		// 往復になる。実測 2026-09-20 16:12、34秒で394回往復して溺死した。
		if s.escapingWaterLocked() {
			s.mu.Unlock()
			s.reply(c.ID, false, "息が続かないので空気のある場所へ向かっている。着くまで移動は受けない", nil)
			return
		}
		if s.goal != nil {
			// 先の目標は取り消す。呼び出し側は1つずつ出す前提。
			emit(event{Event: "result", Data: map[string]any{
				"id": s.goal.id, "ok": false, "error": "新しい目標で置き換えられた",
			}})
		}
		s.goal = &target{
			id: c.ID, x: c.X, z: c.Z, tolerance: tol,
			y: c.Y, hasY: c.Value, noDig: c.Face == 1, strictY: c.Strict,
			deadline: time.Now().Add(time.Duration(timeout) * time.Millisecond),
			lastPos:  s.pos,
		}
		s.mu.Unlock()
		// 結果は到達または時間切れのときに返す。

	case "safe_spot_add":
		// スキル側が「訪問して安全だと確認した場所」を明示的に覚えさせる口。
		// 自動検知(ベッド・村人)が拾えない、他プレイヤーの拠点などのために使う。
		source := c.Message
		if source == "" {
			source = "manual"
		}
		s.mu.Lock()
		s.addSafeSpotLocked(mgl32.Vec3{c.X, c.Y, c.Z}, source)
		n := len(s.safeSpots)
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"count": n})

	case "safe_spot_list":
		s.mu.Lock()
		list := make([]map[string]any, 0, len(s.safeSpots))
		for _, sp := range s.safeSpots {
			list = append(list, map[string]any{
				"position": vec(sp.Pos),
				"source":   sp.Source,
			})
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"spots": list})

	case "stop":
		s.mu.Lock()
		// 空気へ向かう途中は止めない。スキルの中断は移動の主導権を返すだけで、
		// 息の方は待ってくれない。
		if s.goal != nil && !s.escapingWaterLocked() {
			emit(event{Event: "result", Data: map[string]any{
				"id": s.goal.id, "ok": false, "error": "中断された",
			}})
			s.goal = nil
			s.controls = map[string]bool{}
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", nil)

	case "control":
		s.mu.Lock()
		if !s.escapingWaterLocked() {
			s.goal = nil // 手動操作が入ったら自動移動はやめる
			s.controls[c.State] = c.Value
		}
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

	case "stance":
		// LLM が決めた構え(auto / flee / fight)。毎tickの防衛判断が読む。
		switch c.State {
		case "auto", "flee", "fight", "":
			s.mu.Lock()
			s.stance = c.State
			s.mu.Unlock()
			s.reply(c.ID, true, "", map[string]any{"stance": c.State})
		default:
			s.reply(c.ID, false, "stance は auto / flee / fight のどれか", nil)
		}

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
			// 0〜23999 のゲーム内時刻。SetTime は累計tickなので余りを取る。
			// 負になることがあるので折り返す。
			"timeOfDay": ((s.worldTick % 24000) + 24000) % 24000,
			// その場の明るさ(0〜15)。読み込めていなければ null。
			//
			// 統合版のサーバーは明るさを送ってこないので、こちらで持っている
			// チャンクから推定する。長いあいだ 15 固定を返していて、
			// 暗い所にいることが上流へ一度も伝わっていなかった。
			"light": func() any {
				feet := s.feetLocked()
				p := blockPos{
					int32(math.Floor(float64(feet[0]))),
					int32(math.Floor(float64(feet[1]))),
					int32(math.Floor(float64(feet[2]))),
				}
				if v, ok := s.world.lightAt(p, s.worldTick); ok {
					return v
				}
				return nil
			}(),
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

	case "surfaceScan":
		// 周りの列の「地表の高さ」をまとめて返す。
		//
		// TypeScript 側の地形走査は BlockView(半径16の立方体)しか見られない。
		// 48ブロック掘り抜かれた穴の底に落ちると、本物の地表が丸ごと範囲外に
		// なり、穴の途中の棚を地表と誤認して抜け出せなくなる。列を上へ辿る
		// だけの計算なので、チャンクを持っているこちら側でやる方が安い。
		s.mu.Lock()
		cols := s.surfaceScanLocked(c.Range)
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"columns": cols})

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
		// 届かない距離を掘ろうとしても、サーバーは黙って無視する。
		// 待つだけ無駄なので先に弾く。
		reach := s.pos.Sub(mgl32.Vec3{float32(bx) + 0.5, float32(by) + 0.5, float32(bz) + 0.5}).Len()
		if reach > digReach {
			s.mu.Unlock()
			s.reply(c.ID, false, fmt.Sprintf("遠すぎて掘れません（%.1f ブロック）", reach), nil)
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

	case "eat":
		// 手に持っている食べ物を食べる。何を持つかは呼び出し側("hold")の責任。
		//
		// 統合版の消費は2段構え。食べ始めを PlayerAuthInput の ItemInteraction に
		// 載せ(設置と同じ経路)、食べ終わりを ReleaseItem トランザクションで送る。
		// 片方だけでは満腹度は戻らない。食べ始めだけでは「口を付けた」状態で
		// 終わり、食べ終わりだけでは何を食べたのか成立しない。
		{
			s.mu.Lock()
			held, ok := s.rawSlots[int(s.heldSlot)]
			if !ok || held.Stack.Count == 0 {
				s.mu.Unlock()
				s.reply(c.ID, false, "手に何も持っていません", nil)
				return
			}
			slot := s.heldSlot
			// 空を右クリックする形。食べ物はブロックを指す必要がない。
			s.pendingPlace = &protocol.UseItemTransactionData{
				ActionType:       protocol.UseItemActionClickAir,
				TriggerType:      protocol.TriggerTypePlayerInput,
				HotBarSlot:       slot,
				HeldItem:         held,
				Position:         s.pos,
				ClientPrediction: protocol.ClientPredictionSuccess,
			}
			s.mu.Unlock()

			// 食べ終わるまで待つ。この間も毎tickの入力は送られ続ける。
			time.Sleep(eatDuration)

			s.mu.Lock()
			// 持ち物は食べている間に変わりうるので、送る直前のものを載せる。
			after := s.rawSlots[int(slot)]
			// s.pos は既に目線の高さ。ここでは足元へ直す必要はない。
			head := s.pos
			s.mu.Unlock()

			if err := s.conn.WritePacket(&packet.InventoryTransaction{
				TransactionData: &protocol.ReleaseItemTransactionData{
					ActionType:   protocol.ReleaseItemActionConsume,
					HotBarSlot:   slot,
					HeldItem:     after,
					HeadPosition: head,
				},
			}); err != nil {
				s.reply(c.ID, false, fmt.Sprintf("食事の完了を送れない: %v", err), nil)
				return
			}
			s.reply(c.ID, true, "", nil)
		}

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

	case "moveSlot":
		// 持ち物の中でスロットを入れ替える。道具をホットバーへ持ってくるのに要る。
		// 手に持てるのはホットバー(0..8)だけなので、奥に入った道具は
		// 移してこないと使えない。移さないまま素手で掘り、石も鉱石も
		// 落とさないまま「掘れた」ことになる。
		{
			if len(c.Names) == 0 {
				s.reply(c.ID, false, "移動元のスロットを指定してください", nil)
				return
			}
			from, err := strconv.Atoi(c.Names[0])
			to := int(c.Count)
			if err != nil || from < 0 || from > 35 || to < 0 || to > 35 {
				s.reply(c.ID, false, "スロットは 0..35 です", nil)
				return
			}
			s.mu.Lock()
			src, ok := s.rawSlots[from]
			if !ok || src.Stack.Count == 0 {
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("スロット %d は空です", from), nil)
				return
			}
			dst, dstOccupied := s.rawSlots[to]
			s.craftReqID -= 2
			reqID := s.craftReqID
			inv := protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory}
			var action protocol.StackRequestAction
			if dstOccupied && dst.Stack.Count > 0 {
				// 行き先が埋まっているなら入れ替える。
				swap := &protocol.SwapStackRequestAction{}
				swap.Source = protocol.StackRequestSlotInfo{
					Container: inv, Slot: byte(from), StackNetworkID: src.StackNetworkID,
				}
				swap.Destination = protocol.StackRequestSlotInfo{
					Container: inv, Slot: byte(to), StackNetworkID: dst.StackNetworkID,
				}
				action = swap
			} else {
				// 形は Place(c=12→c=12)でよい。2026-09-19 に Take・別コンテナ番号・
				// 識別子0 も試したが、拒否の原因は形ではなく「持ち物の画面を
				// 開いていない」ことだった(下の Interact を参照)。
				place := &protocol.PlaceStackRequestAction{}
				place.Count = byte(min(src.Stack.Count, 64))
				place.Source = protocol.StackRequestSlotInfo{
					Container: inv, Slot: byte(from), StackNetworkID: src.StackNetworkID,
				}
				place.Destination = protocol.StackRequestSlotInfo{
					Container: inv, Slot: byte(to), StackNetworkID: 0,
				}
				action = place
				if os.Getenv("BEDROCK_TRACE_CRAFT") == "1" {
					fmt.Fprintf(os.Stderr, "moveSlot reqID=%d from=%d(id=%d) to=%d\n",
						reqID, from, src.StackNetworkID, to)
				}
			}
			// 送りっぱなしで即 true を返していた。サーバーがこの要求を
			// 拒否しても(例: 元の識別子が古くて FailedToValidateSrcSlot)
			// 呼び出し側には成功としか伝わらず、実際には動いていない物を
			// 「移した」前提で次の操作(装備・クラフト)へ進んでいた。
			// クラフトと同じ待ち行列に載せ、本当の応答を返す。
			// 成功時は ItemStackResponse.ContainerInfo から from/to 両方の
			// 新しい識別子を rawSlots に取り込める。次の要求がこの場で
			// 直した値を使えるので、moveSlot 直後のクラフトが古い識別子で
			// 弾かれることも減る。
			s.craftWaiter[reqID] = c.ID
			s.moveEffect[reqID] = [2]int{from, to}
			s.mu.Unlock()

			// 先に持ち物の画面を開く。クラフトと同じ。
			//
			// 開いていないと、奥の枠(9..35)を元にした要求が
			// FailedToValidateSrcSlot(49) で拒否される。識別子を正しくしても、
			// 形を Take/別コンテナ/識別子0 に変えても同じだった(実測 2026-09-19
			// 12:29、4通り×2周すべて 49)。クラフトの直後だけ通っていたのは、
			// その画面がまだ開いていたから。
			_ = s.conn.WritePacket(&packet.Interact{
				ActionType:            packet.InteractActionOpenInventory,
				TargetEntityRuntimeID: s.game.EntityRuntimeID,
			})
			if err := s.conn.WritePacket(&packet.ItemStackRequest{
				Requests: []protocol.ItemStackRequest{{RequestID: reqID, Actions: []protocol.StackRequestAction{action}}},
			}); err != nil {
				s.mu.Lock()
				delete(s.craftWaiter, reqID)
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("スロット移動に失敗: %v", err), nil)
				return
			}
			// 応答は ItemStackResponse ハンドラが返す。
		}

	case "drop":
		// 持ち物のアイテムを地面に落とす。
		//
		// プレイヤー同士で直接手渡すパケットは存在しない。バニラで人に物を
		// 渡す唯一の方法は、相手のそばで落として自動拾得を待つこと。
		// 呼び出し側(BedrockDriver.dropItem)が事前に相手の近くまで寄せてから
		// これを呼ぶ前提。
		//
		// DropStackRequestAction は「持ち物の画面を開いている間に落とす」
		// 想定のアクションで、Q キー相当(InventoryTransaction)とは別物だが、
		// moveSlot・wear と同じくクラフト用の Interact(OpenInventory) は
		// 常に開いている体で送っているので、同じ枠組みで通る。
		{
			if len(c.Names) == 0 {
				s.reply(c.ID, false, "落とす物の名前を指定してください", nil)
				return
			}
			want := trimNamespace(c.Names[0])
			wantCount := int(c.Count)
			if wantCount <= 0 {
				wantCount = 1
			}

			s.mu.Lock()
			remaining := wantCount
			var actions []protocol.StackRequestAction
			// 1山で足りなければ複数のスタックにまたがって集める。丸石を
			// 2山に分けて持っているだけで「1個も渡せない」にはしない。
			for slot, item := range s.rawSlots {
				if remaining <= 0 {
					break
				}
				name, ok := s.itemNames[item.Stack.ItemType.NetworkID]
				if !ok || name != want {
					continue
				}
				use := remaining
				if have := int(item.Stack.Count); use > have {
					use = have
				}
				if use <= 0 {
					continue
				}
				actions = append(actions, &protocol.DropStackRequestAction{
					Count: byte(use),
					Source: protocol.StackRequestSlotInfo{
						Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory},
						Slot:           byte(slot),
						StackNetworkID: item.StackNetworkID,
					},
				})
				remaining -= use
			}
			if len(actions) == 0 {
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("%s を持っていません", want), nil)
				return
			}
			s.craftReqID -= 2
			reqID := s.craftReqID
			// 複数アクションでも RequestID は1つ。クラフトの複数枠消費と同じ扱い。
			s.craftWaiter[reqID] = c.ID
			s.mu.Unlock()

			if err := s.conn.WritePacket(&packet.ItemStackRequest{
				Requests: []protocol.ItemStackRequest{{RequestID: reqID, Actions: actions}},
			}); err != nil {
				s.mu.Lock()
				delete(s.craftWaiter, reqID)
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("アイテムを落とすのに失敗: %v", err), nil)
				return
			}
			// 応答は ItemStackResponse ハンドラが返す。
		}

	case "wear":
		// 防具を着る。手に持つのと違い、選択スロットを変えるだけでは着られない。
		// 防具コンテナの該当スロットへ ItemStackRequest で移す必要がある。
		// コンテナを開く操作は要らない。自分の防具は常に触れる。
		//
		// Names[0] に移したい持ち物のスロット番号、Count に防具スロット
		// (0=頭 1=胴 2=脚 3=足) を入れて呼ぶ。
		{
			if len(c.Names) == 0 {
				s.reply(c.ID, false, "移す持ち物のスロットを指定してください", nil)
				return
			}
			fromSlot, err := strconv.Atoi(c.Names[0])
			if err != nil || fromSlot < 0 {
				s.reply(c.ID, false, fmt.Sprintf("持ち物のスロットが不正です: %s", c.Names[0]), nil)
				return
			}
			armorSlot := c.Count
			if armorSlot < 0 || armorSlot > 3 {
				s.reply(c.ID, false, "防具スロットは 0..3 です", nil)
				return
			}
			s.mu.Lock()
			item, ok := s.rawSlots[fromSlot]
			if !ok || item.Stack.Count == 0 {
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("スロット %d は空です", fromSlot), nil)
				return
			}
			// クラフトと同じく、リクエストIDは負の奇数を順に減らす。
			s.craftReqID -= 2
			reqID := s.craftReqID
			move := &protocol.PlaceStackRequestAction{}
			// 防具は1つずつしか着けない。スタック数がbyteに収まらないことも無い。
			move.Count = byte(min(item.Stack.Count, 1))
			move.Source = protocol.StackRequestSlotInfo{
				Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory},
				Slot:           byte(fromSlot),
				StackNetworkID: item.StackNetworkID,
			}
			move.Destination = protocol.StackRequestSlotInfo{
				Container:      protocol.FullContainerName{ContainerID: protocol.ContainerArmor},
				Slot:           byte(armorSlot),
				StackNetworkID: 0,
			}
			// moveSlot と同じ理由。送りっぱなしで true を返すと、サーバーに
			// 拒否されても呼び出し側は「着られた」ことにして先へ進む。
			s.craftWaiter[reqID] = c.ID
			s.mu.Unlock()

			if err := s.conn.WritePacket(&packet.ItemStackRequest{
				Requests: []protocol.ItemStackRequest{{
					RequestID: reqID,
					Actions:   []protocol.StackRequestAction{move},
				}},
			}); err != nil {
				s.mu.Lock()
				delete(s.craftWaiter, reqID)
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("装備の送信に失敗: %v", err), nil)
				return
			}
			// 応答は ItemStackResponse ハンドラが返す。
		}

	case "smelt":
		// かまどに素材と燃料を入れる。焼き上がりは待たない。
		//
		// 枠は「素材」「燃料」「出来上がり」の3つで、それぞれ別の ContainerID を
		// 使う。チェストのようにまとめて1つの ID では指せない。
		// Names[0] に素材名、Names[1] に燃料名、Count に素材の数、
		// Face に燃料の数を入れて呼ぶ。
		{
			if len(c.Names) < 2 {
				s.reply(c.ID, false, "素材と燃料を指定してください", nil)
				return
			}
			inputName := trimNamespace(c.Names[0])
			fuelName := trimNamespace(c.Names[1])
			inputCount := max(1, c.Count)
			fuelCount := max(1, int(c.Face))

			box, err := s.openContainerAt(c.X, c.Y, c.Z)
			if err != nil {
				s.reply(c.ID, false, err.Error(), nil)
				return
			}

			s.mu.Lock()
			var actions []protocol.StackRequestAction
			spent := map[int]int{}
			inv := protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory}
			s.craftReqID -= 2
			reqID := s.craftReqID

			put := func(name string, want int, dstContainer byte) int {
				moved := 0
				for slot, item := range s.rawSlots {
					if moved >= want {
						break
					}
					n, ok := s.itemNames[item.Stack.ItemType.NetworkID]
					if !ok || n != name {
						continue
					}
					avail := int(item.Stack.Count) - spent[slot]
					if avail <= 0 {
						continue
					}
					use := min(avail, want-moved)
					srcID := item.StackNetworkID
					if spent[slot] > 0 {
						srcID = reqID
					}
					place := &protocol.PlaceStackRequestAction{}
					place.Count = byte(use)
					place.Source = protocol.StackRequestSlotInfo{
						Container: inv, Slot: byte(slot), StackNetworkID: srcID,
					}
					place.Destination = protocol.StackRequestSlotInfo{
						Container:      protocol.FullContainerName{ContainerID: dstContainer},
						Slot:           0,
						StackNetworkID: 0,
					}
					actions = append(actions, place)
					spent[slot] += use
					moved += use
				}
				return moved
			}

			gotInput := put(inputName, inputCount, protocol.ContainerFurnaceIngredient)
			gotFuel := put(fuelName, fuelCount, protocol.ContainerFurnaceFuel)
			windowID := box.WindowID
			s.mu.Unlock()

			if gotInput == 0 || gotFuel == 0 {
				_ = s.conn.WritePacket(&packet.ContainerClose{WindowID: windowID})
				s.mu.Lock()
				s.container = nil
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("投入できませんでした（素材 %d / 燃料 %d）", gotInput, gotFuel), nil)
				return
			}

			if err := s.conn.WritePacket(&packet.ItemStackRequest{
				Requests: []protocol.ItemStackRequest{{RequestID: reqID, Actions: actions}},
			}); err != nil {
				s.reply(c.ID, false, fmt.Sprintf("投入に失敗: %v", err), nil)
				return
			}
			time.Sleep(500 * time.Millisecond)

			// 開けっ放しにすると次の操作が通らない。焼き上がりは後で
			// takeAll で取りに来る。
			_ = s.conn.WritePacket(&packet.ContainerClose{WindowID: windowID})
			s.mu.Lock()
			s.container = nil
			s.mu.Unlock()
			s.reply(c.ID, true, "", map[string]any{"input": gotInput, "fuel": gotFuel})
		}

	case "takeAll":
		// コンテナを開いて中身を持ち物へ移し、閉じる。
		//
		// 開くところまでは activate と同じ ClickBlock。そこから先はサーバーが
		// ContainerOpen を返し、続いて InventoryContent で中身が届く。
		// 中身が届く前に動かそうとしても、こちらは何があるか知らない。
		{
			bx := int32(math.Floor(float64(c.X)))
			by := int32(math.Floor(float64(c.Y)))
			bz := int32(math.Floor(float64(c.Z)))
			s.mu.Lock()
			reach := s.pos.Sub(mgl32.Vec3{float32(bx) + 0.5, float32(by) + 0.5, float32(bz) + 0.5}).Len()
			if reach > digReach {
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("遠すぎて届きません（%.1f ブロック）", reach), nil)
				return
			}
			face := faceToward(s.pos, bx, by, bz)
			clicked, _ := s.world.runtimeIDAt(bx, by, bz)
			held := s.rawSlots[int(s.heldSlot)]
			s.container = nil
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
			s.lookAtLocked(float32(bx)+0.5, float32(by)+0.5, float32(bz)+0.5)
			s.mu.Unlock()

			// 中身が届くまで待つ。開くのは次のtickに載るので余裕を見る。
			deadline := time.Now().Add(5 * time.Second)
			var box *openContainer
			for time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
				s.mu.Lock()
				if s.container != nil && s.container.Filled {
					box = s.container
					s.mu.Unlock()
					break
				}
				s.mu.Unlock()
			}
			if box == nil {
				s.reply(c.ID, false, "コンテナが開きませんでした", nil)
				return
			}

			s.mu.Lock()
			var actions []protocol.StackRequestAction
			moved := 0
			used := map[int]bool{}
			for slot, item := range box.Slots {
				dst := firstFreeSlotLocked(s, used)
				if dst < 0 {
					// 持ち物が満杯。入る分だけ移す。
					break
				}
				used[dst] = true
				take := &protocol.TakeStackRequestAction{}
				take.Count = byte(min(item.Stack.Count, 64))
				take.Source = protocol.StackRequestSlotInfo{
					Container:      protocol.FullContainerName{ContainerID: containerIDFor(box.Type)},
					Slot:           byte(slot),
					StackNetworkID: item.StackNetworkID,
				}
				take.Destination = protocol.StackRequestSlotInfo{
					Container:      protocol.FullContainerName{ContainerID: protocol.ContainerCombinedHotBarAndInventory},
					Slot:           byte(dst),
					StackNetworkID: 0,
				}
				actions = append(actions, take)
				moved++
			}
			s.craftReqID -= 2
			reqID := s.craftReqID
			windowID := box.WindowID
			s.mu.Unlock()

			if len(actions) > 0 {
				if err := s.conn.WritePacket(&packet.ItemStackRequest{
					Requests: []protocol.ItemStackRequest{{RequestID: reqID, Actions: actions}},
				}); err != nil {
					s.reply(c.ID, false, fmt.Sprintf("移送に失敗: %v", err), nil)
					return
				}
				time.Sleep(500 * time.Millisecond)
			}

			// 開けっ放しにすると次の操作が通らない。必ず閉じる。
			_ = s.conn.WritePacket(&packet.ContainerClose{WindowID: windowID})
			s.mu.Lock()
			s.container = nil
			s.mu.Unlock()
			s.reply(c.ID, true, "", map[string]any{"moved": moved})
		}

	case "pillar":
		// 柱を積んで登る。跳んで、浮いている間に足元へブロックを置く。
		//
		// 頭上を掘るだけでは登れない。縦穴が伸びるだけでボットは底に残る。
		// 実測で100回掘り上がって高さが1も変わらなかった。実プレイヤーは
		// この置き方で上がっている。
		{
			want := max(1, c.Count)
			placed := 0
			for i := 0; i < want; i++ {
				s.mu.Lock()
				// 置ける物を手に持つ。無ければそこで終わり。
				if !s.holdPlaceableLocked() {
					s.mu.Unlock()
					break
				}
				feet := s.feetLocked()
				fx := int32(math.Floor(float64(feet[0])))
				fy := int32(math.Floor(float64(feet[1])))
				fz := int32(math.Floor(float64(feet[2])))
				// 頭上が塞がっていたら跳べない。先に掘ってもらう必要がある。
				if name, ok := s.world.blockAt(fx, fy+2, fz); ok && name != "air" {
					s.mu.Unlock()
					s.reply(c.ID, false, fmt.Sprintf("頭上が塞がっています(%s)", name), nil)
					return
				}
				// 跳ぶ。縦速度は buildInput の予測に乗る。
				s.controls["jump"] = true
				s.mu.Unlock()

				// 頂点あたりまで待つ。0.42/tick で上がり 0.08 ずつ減速するので
				// 5tick ほどで一番高くなる。
				time.Sleep(250 * time.Millisecond)

				s.mu.Lock()
				s.controls["jump"] = false
				// 足元の1つ下を支えにして、自分がいたマスへ置く。
				ref := protocol.BlockPos{fx, fy - 1, fz}
				clicked, _ := s.world.runtimeIDAt(ref[0], ref[1], ref[2])
				held := s.rawSlots[int(s.heldSlot)]
				s.pendingPlace = &protocol.UseItemTransactionData{
					ActionType:       protocol.UseItemActionClickBlock,
					TriggerType:      protocol.TriggerTypePlayerInput,
					BlockPosition:    ref,
					BlockFace:        1, // 上面
					HotBarSlot:       s.heldSlot,
					HeldItem:         held,
					Position:         s.pos,
					ClickedPosition:  clickOffset(1),
					BlockRuntimeID:   uint32(clicked),
					ClientPrediction: protocol.ClientPredictionSuccess,
				}
				s.mu.Unlock()

				// 置いた結果が返るのを待つ。
				time.Sleep(500 * time.Millisecond)
				s.mu.Lock()
				after := int32(math.Floor(float64(s.feetLocked()[1])))
				s.mu.Unlock()
				if after > fy {
					placed++
					continue
				}
				// 上がれていない。これ以上繰り返しても同じ。
				break
			}
			s.mu.Lock()
			s.controls["jump"] = false
			y := s.feetLocked()[1]
			s.mu.Unlock()
			if placed == 0 {
				s.reply(c.ID, false, "柱を積めませんでした（置ける物が無いか、上がれない）", nil)
				return
			}
			s.reply(c.ID, true, "", map[string]any{"placed": placed, "y": y})
		}

	case "activate":
		// ブロックを開く/使う（かまど・チェスト・ドア）。
		// 送るものは設置と同じ ClickBlock のトランザクションで、サーバーが
		// 対象ブロックを見て「開く」か「置く」かを決める。違うのは手ぶらを
		// 許す点だけ。設置は手に持っていないと成立しないが、ドアを開くのに
		// 持ち物は要らない。
		//
		// 手に置けるブロックを持ったまま使うと、サーバーがそちらを優先して
		// 設置してしまうことがある。呼び出し側が必要なら先に持ち替えること。
		{
			bx := int32(math.Floor(float64(c.X)))
			by := int32(math.Floor(float64(c.Y)))
			bz := int32(math.Floor(float64(c.Z)))
			s.mu.Lock()
			reach := s.pos.Sub(mgl32.Vec3{float32(bx) + 0.5, float32(by) + 0.5, float32(bz) + 0.5}).Len()
			if reach > digReach {
				s.mu.Unlock()
				s.reply(c.ID, false, fmt.Sprintf("遠すぎて届きません（%.1f ブロック）", reach), nil)
				return
			}
			face := c.Face
			if face < 0 {
				face = faceToward(s.pos, bx, by, bz)
			}
			s.lookAtLocked(float32(bx)+0.5, float32(by)+0.5, float32(bz)+0.5)
			clicked, _ := s.world.runtimeIDAt(bx, by, bz)
			// 手ぶらでも成立させる。空のスロットは空の ItemInstance で送る。
			held := s.rawSlots[int(s.heldSlot)]
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
		}

	case "craft":
		want := ""
		if len(c.Names) > 0 {
			want = trimNamespace(c.Names[0])
		}
		if want == "" {
			s.reply(c.ID, false, "作る物を指定してください", nil)
			return
		}
		// 拾った直後の持ち物は識別子が予測のままなので、先に取り直す。
		// これをしないと、掘って拾った木で板を作ろうとした瞬間に
		// FailedToValidateSrcSlot(49) で拒否される。
		s.resyncSlotsIfPredicted()
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
		var plan craftPlan
		for i := range list {
			if list[i].NeedsTable && !c.Value {
				lastErr = fmt.Errorf("%s は作業台が要ります", want)
				continue
			}
			// クライアントが出すリクエストIDは負の奇数を順に減らしていく。
			// 正の値を出すと "expected a valid ItemStackRequestId" で弾かれる。
			s.craftReqID -= 2
			r, p, err := s.craftRequestLocked(list[i], s.craftReqID)
			if err != nil {
				// 素材不足はレシピの亜種ごとに必ず出る(別の木のレシピなど)。
				// それで上書きすると、本当の失敗理由が最後の亜種の
				// 「◯◯が足りません」に隠れる。素材不足以外を優先して残す。
				if lastErr == nil || strings.Contains(lastErr.Error(), "足りません") {
					lastErr = err
				}
				continue
			}
			chosen = &list[i]
			// 取り出し元と行き先。応答が来たときの写しの更新はこれに従う。
			plan = p
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
		s.craftEffect[req.RequestID] = craftOutcome{
			Output:      chosen.Output,
			OutputCount: chosen.OutputCount,
			Inputs:      plan.Inputs,
			Spent:       plan.Spent,
			Dest:        plan.Dest,
		}
		s.mu.Unlock()

		// クラフト枠は画面を開いている状態でしか使えない。
		// 2x2 は持ち物の画面、3x3 は作業台の画面。開いている画面と枠が
		// 食い違うと、サーバーは置き先を不正と判断する。
		//
		// 両方を開かないこと。作業台のレシピなのに先に持ち物の画面を
		// 開くと、サーバーから見て手前の画面は持ち物(2x2)のままになる。
		// そこへ 3x3 の枠(32..40)へ置く要求を出すので CannotPlaceItem(55)
		// で弾かれる。実測 2026-09-13、木の剣がこれで作れなかった。
		// 実クライアントも、作業台を開くときに持ち物は開かない。
		if chosen.NeedsTable && c.Value {
			// 開いた確認を取ること。以前は500ミリ秒待つだけで、開いていなくても
			// 送っていた。サーバーは受理を返すのに何も作られない、という形で
			// 失敗する。実測で木の剣を17回試して1本もできなかった。
			//
			// 中身は待たない。作業台は中身を持たないので、待てば必ず落ちる。
			if _, err := s.openBlockAt(c.X, c.Y, c.Z, false); err != nil {
				s.reply(c.ID, false, fmt.Sprintf("作業台を開けません: %v", err), nil)
				return
			}
		} else if err := s.conn.WritePacket(&packet.Interact{
			ActionType:            packet.InteractActionOpenInventory,
			TargetEntityRuntimeID: s.game.EntityRuntimeID,
		}); err != nil {
			s.reply(c.ID, false, fmt.Sprintf("持ち物を開けません: %v", err), nil)
			return
		}

		if os.Getenv("BEDROCK_TRACE_CRAFT") == "1" {
			// 何を送ったのかが分からないと、拒否コードだけでは詰められない。
			fmt.Fprintf(os.Stderr, "craft %s reqID=%d needsTable=%v cells=%d\n",
				chosen.Output, req.RequestID, chosen.NeedsTable, len(chosen.Cells))
			for _, a := range req.Actions {
				switch t := a.(type) {
				case *protocol.PlaceStackRequestAction:
					fmt.Fprintf(os.Stderr, "  place n=%d src(c=%d slot=%d id=%d) dst(c=%d slot=%d id=%d)\n",
						t.Count, t.Source.Container.ContainerID, t.Source.Slot, t.Source.StackNetworkID,
						t.Destination.Container.ContainerID, t.Destination.Slot, t.Destination.StackNetworkID)
				case *protocol.ConsumeStackRequestAction:
					fmt.Fprintf(os.Stderr, "  consume n=%d src(c=%d slot=%d id=%d)\n",
						t.Count, t.Source.Container.ContainerID, t.Source.Slot, t.Source.StackNetworkID)
				case *protocol.CraftRecipeStackRequestAction:
					fmt.Fprintf(os.Stderr, "  recipe net=%d\n", t.RecipeNetworkID)
				case *protocol.TakeStackRequestAction:
					fmt.Fprintf(os.Stderr, "  take n=%d src(c=%d slot=%d id=%d) dst(c=%d slot=%d id=%d)\n",
						t.Count, t.Source.Container.ContainerID, t.Source.Slot, t.Source.StackNetworkID,
						t.Destination.Container.ContainerID, t.Destination.Slot, t.Destination.StackNetworkID)
				}
			}
		}

		if err := s.conn.WritePacket(&packet.ItemStackRequest{
			Requests: []protocol.ItemStackRequest{*req},
		}); err != nil {
			s.mu.Lock()
			delete(s.craftWaiter, req.RequestID)
			s.mu.Unlock()
			s.reply(c.ID, false, fmt.Sprintf("クラフトの送信に失敗: %v", err), nil)
		}
		// 成功の返事は ItemStackResponse で返す。

	case "recipeNames":
		// 作れる物の名前一覧。TypeScript 側の canCraft は同期APIなので、
		// 接続時に一度取って持っておく。
		s.mu.Lock()
		names := make([]string, 0, len(s.recipes))
		for name := range s.recipes {
			names = append(names, name)
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"names": names})

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
		//
		// 送る前に持ち物の識別子を取り直す。攻撃の取引にも HeldItem が載る
		// ので、拾った直後の予測値(サーバーと違う StackNetworkID)のまま
		// 送ると、取引ごと無視される。クラフトは 49 という返事が来るので
		// 気づけたが、攻撃は**何も返ってこない**。実測 2026-09-17 17:37、
		// 遮蔽なし・距離内で17回殴っても豚は減らず、ログには理由が
		// 一つも残らなかった。
		s.resyncSlotsIfPredicted()
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
		// 壁越しには当たらない。ただし、ここでは止めずに記録だけする。
		//
		// 届く距離にいても、間にブロックがあるとサーバーは黙って無視する。
		// 黙って無視されると、こちらは「殴った」と数え続ける。実測
		// 2026-09-17 17:21、豚を20秒で24回殴って一度も減らず、理由が
		// ログに何も残らなかった。
		//
		// 一度は「遮られていたら送らない」にしたが、ローカルで牛を隣に
		// 置いても 7回中7回「遮られている」と判定された。判定の方が
		// 間違っている可能性があるうちに攻撃を止めると、いま通っている
		// 経路まで塞ぐことになる。まず数字を出して、確かめてから決める。
		blocked := !s.clearPathLocked(s.feetLocked(), e.Pos)
		// 目線が外れていると当たらない判定のサーバーがある。
		s.lookAtLocked(e.Pos[0], e.Pos[1]+1, e.Pos[2])
		held := s.rawSlots[int(s.heldSlot)]
		slot := s.heldSlot
		// player_pos は足元。目線の高さではない。
		//
		// これが攻撃が一度も通らなかった原因。s.pos は目線の高さ(足元+1.62)で、
		// PlayerAuthInput はその形で送る。だが攻撃の取引に載せる player_pos は
		// 足元で、1.62 ずれた値を送るとサーバーは取引ごと黙って捨てる。
		// エラーも違反通知も返らないので、こちらからは「殴っているのに減らない」
		// としか見えない。実測 2026-09-18、真隣の牛に素手で93発当てても無傷。
		// 足元に直した途端、25発で倒れて beef と leather が入った。
		//
		// 統合版の座標が目線の高さなのは既知の罠で、他の箇所では引いていた。
		// ここだけ引き忘れていた。
		pos := s.feetLocked()
		s.mu.Unlock()

		// 次の tick で送る。ここから直接送らない。
		//
		// 設置・採掘・食事はすべて PlayerAuthInput と同じ tick の流れに
		// 載っていて、それらは動いている。攻撃だけがコマンドの goroutine から
		// 直接送られていて、そして一度も効いていなかった。実測
		// 2026-09-18 11:12、真隣の牛に素手で80発送って無傷。
		s.mu.Lock()
		s.pendingAttack = &protocol.UseItemOnEntityTransactionData{
			TargetEntityRuntimeID: rid,
			ActionType:            protocol.UseItemOnEntityActionAttack,
			HotBarSlot:            slot,
			HeldItem:              held,
			Position:              pos,
			// 相手の中心あたりを叩く。
			ClickedPosition: mgl32.Vec3{0, 1, 0},
		}
		s.mu.Unlock()
		s.reply(c.ID, true, "", map[string]any{"distance": dist, "blocked": blocked})

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
//
// 3 だった。サーバーは view distance ぶんのチャンクを LevelChunk で通知して
// くるので「そこにチャンクがある」ことは s.known に入っているのだが、中身を
// 取りに行くのが自分の周り3チャンク(±48ブロック)だけで、遠くは一度も開いて
// いなかった。人が地平線の建物を見つけられるのにボットが見つけられないのは
// これが理由で、地上に出ても向かう先が無く、その場をうろつくことしかできない。
//
// 広げてよいのは、探索側をパレット先読み(world.findWide)に替えて走査量が
// 桁で下がったのと、遠い列を捨てる(world.forget)ようにして保持が青天井に
// ならなくなったため。この2つが無い状態で半径だけ上げると tick が止まる。
// 8 から 12 へ(128 → 192ブロック)。8 のままだと、人が地平線に見つける
// ような離れた拠点はデータとして届かない。300ブロック先は 19 チャンクで、
// サーバーの view distance の上限を超えることが多いので狙わない。
// 列数は半径の2乗で増える(17×17=289 → 25×25=625)。走査はパレット先読みで
// 落ちるので、増えるのは主に保持と解析の分。
const requestRadius = 12

// keepRadius は保持しておく列の広さ(チャンク単位)。
// 要求範囲より少し広く取り、行ったり来たりで取り直しが続くのを避ける。
const keepRadius = requestRadius + 4

// requestVertical は要求する上下のサブチャンク数。
//
// 2(±32ブロック)だった。地下にいるとき地上の建物が丸ごと範囲外になる。
// 拠点は地表にあるので、地下から地上を見上げられる程度には要る。
const requestVertical = 5

// requestRestep は、同じ列を取り直すまでに動いてよい高さ区画の数。
// requestVertical より小さくしておくと、取り直す前に隙間ができない。
const requestRestep = 3

func absInt32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

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

	// 遠ざかった列を捨てる。取得した列を一度も捨てていなかったので、歩き
	// 回るほど際限なく積み上がっていた。要求範囲を広げるなら必須。
	// 捨てた列は requested からも消し、戻ってきたときに取り直せるようにする。
	for _, key := range s.world.forget(px, pz, keepRadius) {
		delete(s.requested, key)
	}

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
			key := [2]int32{cx, cz}
			// 一度取った列は、高さが requestRestep ぶん動くまで取り直さない。
			// 上下に requestVertical ぶん持っているので、その内側の移動なら
			// 既に手元にある。
			if last, ok := s.requested[key]; ok && absInt32(center-last) < requestRestep {
				continue
			}
			s.requested[key] = center
			todo = append(todo, req{cx, cz, dim})
		}
	}
	s.mu.Unlock()

	// 足元と頭上だけでは、地下から地上の建物が見えない。上下に広く取る。
	offsets := make([]protocol.SubChunkOffset, 0, requestVertical*2+1)
	for dy := int8(-requestVertical); dy <= requestVertical; dy++ {
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

// surfaceScanLocked は自分の周りの列ごとに「地表の高さ」を返す。
// 呼び出し側が mu を持つこと。
//
// 地表とは「空が見えている一番上の固いブロック」。上から下へ辿り、空気が
// 続いた後に最初に当たる固いブロックの Y を返す。読めていない列は返さない
// (未取得を「空」と答えると、向こう側が空中を目標にしてしまう)。
//
// 走査は列あたり高々 (上限-下限) 回。半径8で289列、1列200マスでも6万回
// 程度で、findBlocksLocked の立方体走査よりはるかに軽い。
func (s *session) surfaceScanLocked(radius float32) []map[string]any {
	if radius <= 0 {
		radius = 8
	}
	r := int32(radius)
	if r > 48 {
		r = 48
	}

	feet := s.feetLocked()
	ox := int32(math.Floor(float64(feet[0])))
	oz := int32(math.Floor(float64(feet[2])))

	// 走査する高さの範囲。要求している垂直の幅(requestVertical)より広く
	// 取っても、持っていない領域は ok=false で素通りするだけ。
	const scanTop = int32(320)
	const scanBottom = int32(-64)

	out := make([]map[string]any, 0, (2*r+1)*(2*r+1))
	for dx := -r; dx <= r; dx++ {
		for dz := -r; dz <= r; dz++ {
			x, z := ox+dx, oz+dz
			air := 0
			for y := scanTop; y >= scanBottom; y-- {
				name, ok := s.world.blockAt(x, y, z)
				if !ok {
					// この高さは持っていない。空気とは限らないので数えない。
					continue
				}
				if name == "air" {
					air++
					continue
				}
				// 空気の下に初めて出てきた固いもの。ただし上に空気を1つも
				// 読めていないなら、天井の下かもしれないので地表とは呼ばない。
				if air == 0 {
					break
				}
				out = append(out, map[string]any{
					"x":    x,
					"z":    z,
					"y":    y,
					"name": name,
					// 上にどれだけ空きがあったか。天井の下か空の下かの目安。
					"open": air,
				})
				break
			}
		}
	}
	return out
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
		// ベッドがあれば、そこは誰かの寝床=拠点である可能性が高い。
		// 逃げ込む先の候補として覚える。
		s.scanChunkForBedsLocked(cx, cz, sc)
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

	// パレット先読みで絞ってから中身を引く(world.findWide)。
	//
	// 元は距離順の立方体シェルを1マスずつ引いていた。見つかれば早いが、
	// 見つからないときは全走査になる。半径32で26万マス、半径128なら
	// 1600万マスで、その間 mu を握ったままになり tick が止まる。
	// サブチャンクのパレットは数個〜数十個しかないので、そこで落とせば
	// 「人工物のある一部のサブチャンク」しか中を見なくて済む。
	found := s.world.findWide(ox, oy, oz, want, float64(radius), count)

	out := make([]map[string]any, 0, len(found))
	for _, f := range found {
		out = append(out, map[string]any{
			"name":     f.Name,
			"position": []int32{f.X, f.Y, f.Z},
		})
	}
	return out
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
// requestRespawn は復帰を要求する。戻るまで数回繰り返す。
//
// 統合版は死んでも勝手には戻らない。実クライアントは死亡画面で
// 「リスポーン」を押し、そこで初めて要求が飛ぶ。送らないと死んだまま
// 入力を送り続け、以降の行動が全部無意味になる。
func (s *session) requestRespawn() {
	for i := 0; i < 10; i++ {
		s.mu.Lock()
		hp := s.health
		rid := s.game.EntityRuntimeID
		pos := s.pos
		s.mu.Unlock()
		if hp > 0 && i > 0 {
			return
		}
		_ = s.conn.WritePacket(&packet.PlayerAction{
			EntityRuntimeID: rid,
			ActionType:      protocol.PlayerActionRespawn,
		})
		_ = s.conn.WritePacket(&packet.Respawn{
			EntityRuntimeID: rid,
			State:           packet.RespawnStateClientReadyToSpawn,
			Position:        pos,
		})
		time.Sleep(1500 * time.Millisecond)
	}
}

// openContainerAt はその位置のコンテナを開き、中身が届くまで待つ。
// チェストやかまどのように、中に物が入っているものに使う。
func (s *session) openContainerAt(x, y, z float32) (*openContainer, error) {
	return s.openBlockAt(x, y, z, true)
}

// openBlockAt はその位置のブロックの画面を開く。
// 開くのは設置と同じ ClickBlock。サーバーが対象を見て開いてくれる。
//
// needContent が false なら ContainerOpen が来た時点で戻る。作業台には
// 「中身」が無く、サーバーは ContainerOpen は返すが InventoryContent は
// 返さない。中身を待つと必ず5秒で時間切れになり、クラフトが
// 「コンテナが開きませんでした」で落ちる。実測 2026-09-13、木の剣を
// 作る反射が1197回空振りしていた原因がこれ。材料も作業台も揃っていた。
func (s *session) openBlockAt(x, y, z float32, needContent bool) (*openContainer, error) {
	bx := int32(math.Floor(float64(x)))
	by := int32(math.Floor(float64(y)))
	bz := int32(math.Floor(float64(z)))
	s.mu.Lock()
	reach := s.pos.Sub(mgl32.Vec3{float32(bx) + 0.5, float32(by) + 0.5, float32(bz) + 0.5}).Len()
	if reach > digReach {
		s.mu.Unlock()
		return nil, fmt.Errorf("遠すぎて届きません（%.1f ブロック）", reach)
	}
	face := faceToward(s.pos, bx, by, bz)
	clicked, _ := s.world.runtimeIDAt(bx, by, bz)
	held := s.rawSlots[int(s.heldSlot)]
	s.container = nil
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
	s.lookAtLocked(float32(bx)+0.5, float32(by)+0.5, float32(bz)+0.5)
	s.mu.Unlock()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		s.mu.Lock()
		box := s.container
		s.mu.Unlock()
		if box == nil {
			continue
		}
		if !needContent || box.Filled {
			return box, nil
		}
	}
	return nil, fmt.Errorf("コンテナが開きませんでした")
}

// inLiquidLocked は水や溶岩に浸かっているか。頭の高さで見る。
// 呼び出し側が mu を持つこと。
func (s *session) inLiquidLocked() bool {
	feet := s.feetLocked()
	fx := int32(math.Floor(float64(feet[0])))
	fy := int32(math.Floor(float64(feet[1])))
	fz := int32(math.Floor(float64(feet[2])))
	for _, dy := range []int32{0, 1} {
		name, ok := s.world.blockAt(fx, fy+dy, fz)
		if !ok {
			continue
		}
		if name == "water" || name == "flowing_water" || name == "lava" || name == "flowing_lava" {
			return true
		}
	}
	return false
}

// 頭まで水に沈んでいてよい時間。統合版の息は約15秒で、切れると毎秒2ダメージ。
// 空気まで泳ぎ直す余裕を残して、その半分で手を打つ。
const breathLimit = 6 * time.Second

// 空気を探す半径。息が残っている間に泳げる距離。
const airSearchRadius = 6

// 息の反射が立てる目標の id。呼び出し側(TS)に対応する要求は無いので、
// 結果は無視される(pending に無い id は捨てられる)。
const escapeGoalID = -1

// 脱出の目標が終わったあと、次を立てるまでの間。
const escapeRetryGap = 3 * time.Second

// escapingWaterLocked は、息の反射が立てた目標がまだ生きているか。
// この間は goto / stop / control で目標を差し替えない。
func (s *session) escapingWaterLocked() bool {
	return s.goal != nil && s.goal.id == escapeGoalID && time.Now().Before(s.goal.deadline)
}

// ceilingAboveLocked は跳んだ先(足元+2)が固いブロックか。未取得は塞がっていない扱い。
func (s *session) ceilingAboveLocked() bool {
	feet := s.feetLocked()
	name, ok := s.world.blockAt(
		int32(math.Floor(float64(feet[0]))),
		int32(math.Floor(float64(feet[1])))+2,
		int32(math.Floor(float64(feet[2]))),
	)
	return ok && !passableBlocks[name]
}

// wallAheadLocked は、この tick の移動先の「頭の高さ」が固いブロックか。
// 半身(0.3)ぶん先まで見る。足元だけが固い(1段の段差)のは跳んで乗るので通す。
// 未取得のマスは通れる扱い(チャンク境目で止まらない)。
func (s *session) wallAheadLocked(delta mgl32.Vec3) bool {
	feet := s.feetLocked()
	l := float32(math.Hypot(float64(delta[0]), float64(delta[2])))
	if l == 0 {
		return false
	}
	nx := feet[0] + delta[0] + delta[0]/l*0.3
	nz := feet[2] + delta[2] + delta[2]/l*0.3
	bx := int32(math.Floor(float64(nx)))
	bz := int32(math.Floor(float64(nz)))
	fy := int32(math.Floor(float64(feet[1])))
	name, ok := s.world.blockAt(bx, fy+1, bz)
	return ok && !passableBlocks[name]
}

// headInWaterLocked は目の位置のブロックが水か。ゲームの溺れ判定も目の位置。
//
// 以前は「足元+1 のブロック」で見ていた。水面に浮いているとき、足は水面の
// ブロックの中にあり、その1つ上(=水面のブロック)は水だが、目(足元+1.62)は
// 水面より上で息ができている。実測 2026-09-20 18:31、水面で浮いたまま
// 「頭まで水中」と誤認して脱出目標を 3 秒ごとに立て続け、掘り上がりを潰した。
func (s *session) headInWaterLocked() bool {
	name, ok := s.world.blockAt(
		int32(math.Floor(float64(s.pos[0]))),
		int32(math.Floor(float64(s.pos[1]))),
		int32(math.Floor(float64(s.pos[2]))),
	)
	return ok && (name == "water" || name == "flowing_water")
}

// breatheLocked は毎tick呼ばれる。頭まで沈んだまま breathLimit を超えたら、
// いまの目標を「息が続かない」で失敗させ、いちばん近い空気のある場所へ
// 向かう目標に置き換える。
//
// 経路探索は水面しか泳がないように直したが、復帰先が水没した穴の底である
// ことがあり(実測 2026-09-20、6分に3回溺死)、そこでは経路の前提が崩れて
// いる。判断はしない。空気のある方へ動く、だけ。
func (s *session) breatheLocked() {
	if s.health <= 0 || !s.headInWaterLocked() {
		s.submergedSince = time.Time{}
		s.noAirLogged = false
		// ここでは息ができている。溺れかけたら、まずここへ戻る。
		if s.health > 0 {
			s.lastAirPos = s.pos
			s.lastAirAt = time.Now()
		}
		return
	}
	if s.submergedSince.IsZero() {
		s.submergedSince = time.Now()
		return
	}
	if time.Since(s.submergedSince) < breathLimit {
		return
	}
	// 実際に削られるまでは動かない。溺れ始めると毎秒 2 削られ、最初の1発で
	// 動けば空気まで 8 秒ある。削られる前に動くと、掘り上がりのように自分で
	// 空気を作っている途中のスキルの移動を潰す(実測 2026-09-20 18:31、水没した
	// 縦穴で掘り上がり中の移動を 3 秒ごとに奪い、そのまま溺死)。
	if time.Since(s.lastHurt) > 2*time.Second {
		return
	}
	if s.escapingWaterLocked() {
		return
	}
	// 直前の脱出が終わった(着いた・時間切れ)のにまだ沈んでいる。すぐ次を
	// 立てると毎tick目標を作り直してログと result を吐き続けるので、間を置く。
	if time.Since(s.lastEscapeAt) < escapeRetryGap {
		return
	}
	if s.goal != nil {
		s.finishGoalLocked(false, fmt.Sprintf(
			"息が続かない（頭まで水中で %d 秒）。この水路は通れない",
			int(breathLimit/time.Second)))
	}
	s.lastEscapeAt = time.Now()
	// まず、最後に息ができていた場所へ戻る。写しの上で「空気」に見える
	// マスは、流れ水の更新が届いていなくて実は水、ということがある。実測
	// 2026-09-20 17:19、写しが空気と言う (-18,34,40) に着いてそこで溺死した。
	// 自分が実際に呼吸していた場所は写しに依らない。
	if !s.lastAirAt.IsZero() && time.Since(s.lastAirAt) < 60*time.Second {
		d := s.pos.Sub(s.lastAirPos)
		if dist := math.Hypot(float64(d[0]), float64(d[2])); dist <= 10 && dist >= 0.5 {
			fmt.Fprintf(os.Stderr, "[sidecar] 息が続かない。最後に息ができた (%.0f,%.0f,%.0f) へ戻る\n",
				s.lastAirPos[0], s.lastAirPos[1]-eyeHeight, s.lastAirPos[2])
			s.goal = &target{
				id: escapeGoalID, x: s.lastAirPos[0], z: s.lastAirPos[2],
				y: s.lastAirPos[1] - eyeHeight, hasY: true, noDig: true, tolerance: 0.8,
				deadline: time.Now().Add(10 * time.Second),
				lastPos:  s.pos,
			}
			return
		}
	}
	air, ok := s.nearestAirLocked()
	if !ok {
		if !s.noAirLogged {
			fmt.Fprintf(os.Stderr, "[sidecar] 頭まで水中だが %d ブロック以内に空気が無い\n", airSearchRadius)
			s.noAirLogged = true
		}
		return
	}
	fmt.Fprintf(os.Stderr, "[sidecar] 息が続かない。空気のある (%d,%d,%d) へ泳ぐ\n", air.X, air.Y, air.Z)
	s.goal = &target{
		id: escapeGoalID, x: float32(air.X) + 0.5, z: float32(air.Z) + 0.5,
		y: float32(air.Y), hasY: true, noDig: true, tolerance: 0.8,
		deadline: time.Now().Add(10 * time.Second),
		lastPos:  s.pos,
	}
}

// nearestAirLocked は、水と空気だけを通って行ける範囲で、頭の位置に空気が
// ある一番近いマスを返す。足元は水でも床でもよい(浮けるか立てるか)。
func (s *session) nearestAirLocked() (blockPos, bool) {
	feet := s.feetLocked()
	start := blockPos{
		int32(math.Floor(float64(feet[0]))),
		int32(math.Floor(float64(feet[1]))),
		int32(math.Floor(float64(feet[2]))),
	}
	w := s.world
	type item struct {
		p blockPos
		d int
	}
	seen := map[blockPos]bool{start: true}
	queue := []item{{start, 0}}
	dirs := []blockPos{{1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {0, 1, 0}, {0, -1, 0}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		head := blockPos{cur.p.X, cur.p.Y + 1, cur.p.Z}
		if cur.d > 0 && w.passable(head) && !w.inWater(head) {
			// 足元が空気なら、その下に床か水が要る(空中には浮けない)。
			below := blockPos{cur.p.X, cur.p.Y - 1, cur.p.Z}
			if w.inWater(cur.p) || w.solidFloor(below) || w.inWater(below) {
				return cur.p, true
			}
		}
		if cur.d >= airSearchRadius {
			continue
		}
		for _, d := range dirs {
			next := blockPos{cur.p.X + d.X, cur.p.Y + d.Y, cur.p.Z + d.Z}
			if seen[next] || !w.passable(next) {
				continue
			}
			seen[next] = true
			queue = append(queue, item{next, cur.d + 1})
		}
	}
	return blockPos{}, false
}

// noteRevivedLocked は体力が戻ったかを見る。死んだあと初めて正になった
// ときだけ true。サーバーの Respawn(ReadyToSpawn) は届かないことがあり
// (実測 2026-09-20、7回死んで一度も来なかった)、それを復帰の合図にすると
// 呼び出し側は復帰を知れない。
func (s *session) noteRevivedLocked() bool {
	if !s.dead || s.health <= 0 {
		return false
	}
	s.dead = false
	s.submergedSince = time.Time{}
	return true
}

// emitRespawn は復帰を知らせる。位置は今いる所。
func (s *session) emitRespawn() {
	s.mu.Lock()
	pos := s.pos
	s.mu.Unlock()
	emit(event{Event: "respawn", Data: map[string]any{
		"position": []float32{pos[0], pos[1], pos[2]},
	}})
}

// containerIDFor はコンテナの種類から、スロットを指すときの ContainerID を返す。
// 種類ごとに枠の意味が違うので、どれも同じ ID で指すことはできない。
func containerIDFor(containerType byte) byte {
	switch containerType {
	case byte(protocol.ContainerTypeFurnace),
		byte(protocol.ContainerTypeBlastFurnace),
		byte(protocol.ContainerTypeSmoker):
		return protocol.ContainerFurnaceIngredient
	default:
		// チェスト・樽・シュルカーなど、素直な入れ物はこれで足りる。
		return protocol.ContainerLevelEntity
	}
}

// firstFreeSlotLocked は持ち物の空きスロットを1つ返す。無ければ -1。
// used には同じ要求の中で既に行き先にしたスロットを渡す。1回の
// ItemStackRequest では持ち物の写しが更新されないので、こちらで避ける。
// 呼び出し側が mu を持つこと。
func firstFreeSlotLocked(s *session, used map[int]bool) int {
	for slot := 0; slot < 36; slot++ {
		if used[slot] {
			continue
		}
		if it, ok := s.rawSlots[slot]; !ok || it.Stack.Count == 0 {
			return slot
		}
	}
	return -1
}

// addItemLocked は拾ったアイテムを持ち物の写しへ足す。
//
// 同じ物の山があればそこへ、無ければ空き枠へ。サーバーの割り当てと必ずしも
// 一致しないが、こちらが見たいのは「何をどれだけ持っているか」なので足りる。
// 実際の配置は次の InventoryContent で上書きされる。
// 呼び出し側が mu を持つこと。
// slotResyncWait は、持ち物の送り直しを待つ上限。
//
// 待たずに進むと結局古い識別子で送ることになる。届かなければ諦めて進む
// (待ち続けるより、拒否されて次の手に移る方がまだ動く)。
const slotResyncWait = 600 * time.Millisecond

// resyncSlotsIfPredicted は、予測で書いた持ち物があるならサーバーに
// 一覧を送り直させ、正しい識別子を取り直す。
//
// 持ち物の画面を閉じる(ContainerClose{WindowID: 0})と、サーバーは
// InventoryContent で全スロットを送り直す。クラフトの応答から識別子を
// 取り込むのと同じ手で、あちらは「作った物の識別子が分からない」ときに使う。
func (s *session) resyncSlotsIfPredicted() {
	// 拾った直後の写しは識別子が予測のまま。サーバーに一覧を送り直させる
	// 手は無い。ContainerClose{0}・Interact{OpenInventory}・主張違いの
	// MobEquipment・ClickAir(ItemInteraction / InventoryTransaction 直送)を
	// 本番 Realm で試したが、どれも何も返ってこなかった(実測 2026-09-19)。
	// 一覧が届くのは、設置・消費・耐久減りなど実際に持ち物が変わったあとだけ。
	//
	// なのでここでは、直前の変化で届きかけている一覧があれば少しだけ待つに
	// とどめる。届かなければ古い識別子で送って 49 で拒否され、呼び出し側
	// (skills/crafting/util.ts の tryCraft)がブロックを1個置いて変化を起こし、
	// 一覧を取り直してから作り直す。
	s.mu.Lock()
	need := s.slotsPredicted
	s.mu.Unlock()
	if !need {
		return
	}
	started := time.Now()
	deadline := started.Add(slotResyncWait)
	for time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		s.mu.Lock()
		done := !s.slotsPredicted
		s.mu.Unlock()
		if done {
			if os.Getenv("BEDROCK_TRACE_INV") == "1" {
				fmt.Fprintf(os.Stderr, "resync ok after %dms\n", time.Since(started).Milliseconds())
			}
			return
		}
	}
	if os.Getenv("BEDROCK_TRACE_INV") == "1" {
		fmt.Fprintf(os.Stderr, "resync timeout after %dms (InventoryContent 未着)\n",
			time.Since(started).Milliseconds())
	}
}

// closeOpenScreen は ItemStackRequest のために開いた画面を閉じる。
//
// クラフト・moveSlot は Interact{OpenInventory} か作業台の ClickBlock で
// 画面を開いてから要求を送る。閉じずに放置すると、サーバーから見て画面が
// 開いたままになり、次に作業台やかまどを ClickBlock しても ContainerOpen が
// 返ってこない(実測 2026-09-19 13:58、目の前の作業台に対して
// 「コンテナが開きませんでした」が続いた。成功後の ContainerClose{0} を
// 外した直後から)。応答が来たら、開いていた窓と持ち物の画面を閉じる。
func (s *session) closeOpenScreen() {
	s.mu.Lock()
	win := byte(0)
	if s.container != nil {
		win = s.container.WindowID
		s.container = nil
	}
	s.mu.Unlock()
	if win != 0 {
		_ = s.conn.WritePacket(&packet.ContainerClose{WindowID: win})
	}
	_ = s.conn.WritePacket(&packet.ContainerClose{WindowID: 0})
}

func (s *session) addItemLocked(item protocol.ItemInstance) {
	if item.Stack.Count == 0 {
		return
	}
	name, ok := s.itemNames[item.Stack.ItemType.NetworkID]
	if !ok {
		return
	}
	for slot := 0; slot < 36; slot++ {
		it, used := s.rawSlots[slot]
		if !used || it.Stack.Count == 0 {
			continue
		}
		if n, ok := s.itemNames[it.Stack.ItemType.NetworkID]; !ok || n != name {
			continue
		}
		if int(it.Stack.Count)+int(item.Stack.Count) > 64 {
			continue
		}
		it.Stack.Count += item.Stack.Count
		s.rawSlots[slot] = it
		s.syncSlotLocked(slot, it)
		// ここで書いた個数はこちらの予測で、そのスタックの識別子は
		// サーバー側で既に変わっている。後で取り直す印を立てる。
		s.slotsPredicted = true
		return
	}
	if slot, ok := s.freeSlotLocked(); ok {
		// 地面のアイテムの識別子は、持ち物のスタックの識別子ではない。
		// そのまま素材に指すと拒否されるので、ここも予測扱いにする。
		s.rawSlots[slot] = item
		s.syncSlotLocked(slot, item)
		s.slotsPredicted = true
	}
}

// syncSlotLocked は rawSlots の変更を、外へ出す一覧(slots)へ反映する。
// 呼び出し側が mu を持つこと。
func (s *session) syncSlotLocked(slot int, item protocol.ItemInstance) {
	kept := s.slots[:0]
	for _, x := range s.slots {
		if x.Slot != slot {
			kept = append(kept, x)
		}
	}
	s.slots = kept
	if it, ok := s.itemLocked(item); ok {
		it.Slot = slot
		s.slots = append(s.slots, it)
	}
}

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
		pos := d.pos
		s.digStop = &pos
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
		// 候補として数え、実際に置けるかは置いてみて判断する。
		//
		// ホットバー(0..8)に限らないこと。拾った物がどのスロットに入るかは
		// こちらで決められない。手持ちに原木が11個あっても、それが9番以降に
		// 入っているだけで「足場ゼロ」と数え、柱を積む手を経路探索から
		// 外していた。地下27メートルから上がれなかった一因。
		// 持ち替えは holdPlaceableLocked がやる。
		if isPlaceableName(it.Name) {
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
		// 置いても足場にならない物。clay_ball を 64 個「足場」に数え、柱を
		// 積むときにそれを握って何も置けずにいた(実測 2026-09-20、足場112で
		// 一度も上がれず)。素材・食べ物・苗・松明はここで外す。
		"ball", "flesh", "feather", "leather", "egg", "beef", "porkchop", "mutton",
		"chicken", "cod", "salmon", "rabbit", "sapling", "torch", "_dye", "bowl",
		"flint", "paper", "book", "wheat", "sugar", "kelp", "bamboo", "_berries",
		"carrot", "potato", "beetroot", "_slice", "_pearl", "_rod", "_tear",
		"shears", "compass", "clock", "bed", "shield", "_door", "_sign", "_boat",
		"rail", "_shulker_shell", "_horn", "_disc", "_bottle", "_powder", "_fragment",
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
	case stepSwimUp:
		// 浮上し切るまで次の歩へ進まない。
		//
		// 通過点の消化は水平距離だけで見ているので、真上への歩はその場で
		// 「着いた」ことになって消えてしまう。実際には1ミリも上がらない。
		// 柱積み(stepTower)と同じく、ここで待たせる。
		if s.feetLocked()[1] >= float32(st.Pos.Y)-0.2 {
			return true
		}
		s.controls["jump"] = true
		s.controls["forward"] = false
		return false

	case stepDig, stepDigUp:
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
				id:  0,
				pos: protocol.BlockPos{b.X, b.Y, b.Z},
				// 期限は1歩ぶんに合わせる。15秒だと、壊せないブロックを2回
				// 相手にしただけで目標の制限時間(30秒)を使い切る。
				face:     faceToward(s.pos, b.X, b.Y, b.Z),
				deadline: time.Now().Add(stepWaitLimit),
			}
			s.lookAtLocked(float32(b.X)+0.5, float32(b.Y)+0.5, float32(b.Z)+0.5)
			return false
		}
		return true

	case stepTower:
		// 足元に置いて1段上がる。跳んでいる間に置く必要があるので、
		// 跳躍を仕掛けてから置く。上がれたかは次のtickで位置を見る。
		if s.world.solidFloor(st.Fill) {
			return true
		}
		if s.pendingPlace != nil {
			return false
		}
		if !s.heldPlaceableLocked() {
			if !s.holdPlaceableLocked() {
				s.goal.path = nil
				return false
			}
			return false
		}
		if !s.airborne {
			// まだ地面にいる。跳んでから置く。
			s.controls["jump"] = true
			return false
		}
		{
			ref := protocol.BlockPos{st.Fill.X, st.Fill.Y - 1, st.Fill.Z}
			clicked, _ := s.world.runtimeIDAt(ref[0], ref[1], ref[2])
			s.pendingPlace = &protocol.UseItemTransactionData{
				ActionType:       protocol.UseItemActionClickBlock,
				TriggerType:      protocol.TriggerTypePlayerInput,
				BlockPosition:    ref,
				BlockFace:        1,
				HotBarSlot:       s.heldSlot,
				HeldItem:         s.rawSlots[int(s.heldSlot)],
				Position:         s.pos,
				ClickedPosition:  clickOffset(1),
				BlockRuntimeID:   uint32(clicked),
				ClientPrediction: protocol.ClientPredictionSuccess,
			}
		}
		return false

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
		if !s.heldPlaceableLocked() {
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
			HeldItem:         s.rawSlots[int(s.heldSlot)],
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
// heldPlaceableLocked は今握っている物が置けるブロックか。
//
// 「何か握っている」で済ませてはいけない。反射が剣を握らせるので、
// 柱を積む場面でも手には wooden_sword が入っている。剣で置こうとしても
// 何も起きず、足場が出来ないまま同じtickを繰り返して一生上がれない。
// 実測 2026-09-13、足場12個・経路ありで地下27メートルから上がれなかった。
// 呼び出し側が mu を持つこと。
func (s *session) heldPlaceableLocked() bool {
	item, ok := s.rawSlots[int(s.heldSlot)]
	if !ok || item.Stack.Count == 0 {
		return false
	}
	name, ok := s.itemNames[item.Stack.ItemType.NetworkID]
	if !ok {
		return false
	}
	return isPlaceableName(name)
}

func (s *session) holdPlaceableLocked() bool {
	// まずホットバーを見る。持ち替えるだけで済む。
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

	// ホットバーに無ければ、奥のスロットから手前へ移してから握る。
	// 拾った物がどこへ入るかはこちらで決められないので、ここを諦めると
	// 「持っているのに置けない」で詰まる。
	for _, it := range s.slots {
		if it.Slot <= 8 || !isPlaceableName(it.Name) {
			continue
		}
		src := int32(it.Slot)
		dst := int32(0)
		// 空いているホットバー枠を探す。無ければ0番と入れ替える。
		for slot := int32(0); slot <= 8; slot++ {
			if item, ok := s.rawSlots[int(slot)]; !ok || item.Stack.Count == 0 {
				dst = slot
				break
			}
		}
		item := s.rawSlots[int(src)]
		s.heldSlot = dst
		go func(from, to int32, i protocol.ItemInstance) {
			// ホットバーへ移す。実クライアントも数字キーでこれを送る。
			_ = s.conn.WritePacket(&packet.MobEquipment{
				EntityRuntimeID: s.game.EntityRuntimeID,
				NewItem:         i,
				InventorySlot:   byte(from),
				HotBarSlot:      byte(to),
			})
		}(src, dst, item)
		return true
	}
	return false
}

// craftOutcome はクラフト1回ぶんの結果。持ち物の写しを直すのに使う。
type craftOutcome struct {
	Output      string
	OutputCount int
	Inputs      []craftInput

	// 要求で指した取り出し元(枠→個数)と行き先の枠。
	Spent map[int]int
	Dest  int
}

// applyCraftLocked はクラフトの結果を持ち物の写しに反映する。
// サーバーは ItemStackResponse で伝えてくるが、そこにアイテムの種類は
// 入っていない。何を作ったかはこちらが知っているので自前で当てる。
// 呼び出し側が mu を持つこと。
func (s *session) applyCraftLocked(eff craftOutcome) {
	// 素材を減らす。要求で実際に指した枠から、指した数だけ引く。
	// 名前で「最初の山」から引いてはいけない。要求は rawSlots の走査順で
	// 取るので、同じ物が2山あるとき写しとサーバーで減る山が食い違う。
	for slot, n := range eff.Spent {
		raw, ok := s.rawSlots[slot]
		if !ok {
			continue
		}
		if int(raw.Stack.Count) <= n {
			delete(s.rawSlots, slot)
			s.syncSlotLocked(slot, protocol.ItemInstance{})
			continue
		}
		raw.Stack.Count -= uint16(n)
		s.rawSlots[slot] = raw
		s.syncSlotLocked(slot, raw)
	}

	// 出来上がりは要求で指した行き先へ。既にある山ならそこへ足し、空き枠なら
	// 新しく作る。同じ名前の別の山へ足すと、サーバー側で埋まった枠を写しが
	// 空きだと思い続け、次の出来上がりの行き先に選んで
	// FailedToValidateDstSlot(50) で拒否される。
	if raw, ok := s.rawSlots[eff.Dest]; ok && raw.Stack.Count > 0 {
		raw.Stack.Count += uint16(eff.OutputCount)
		s.rawSlots[eff.Dest] = raw
		s.syncSlotLocked(eff.Dest, raw)
		return
	}
	// 生の写しにも入れる。持ち替え・設置・次のクラフトは全てこちらを見る。
	// ここを書かないと、作った物を手に持てない。作業台を作った直後の設置が
	// 「手に何も持っていません」で失敗していた。
	if id, ok := s.networkIDForLocked(eff.Output); ok {
		item := protocol.ItemInstance{
			// サーバーが割り当てた識別子は分からない。0 のままにしておき、
			// 重ねる先には選ばない(outputSlotLocked が弾く)。応答の
			// ContainerInfo に載っていれば、呼び出し側がこのあと取り込む。
			StackNetworkID: 0,
			Stack: protocol.ItemStack{
				ItemType: protocol.ItemType{NetworkID: id},
				Count:    uint16(eff.OutputCount),
			},
		}
		s.rawSlots[eff.Dest] = item
		s.syncSlotLocked(eff.Dest, item)
	}
}

// networkIDForLocked は名前から実行時IDを引く。アイテム表は id→名前 しか
// 持っていないので線形に探す。呼ぶ頻度は低い。
// 呼び出し側が mu を持つこと。
func (s *session) networkIDForLocked(name string) (int32, bool) {
	for id, n := range s.itemNames {
		if n == name {
			return id, true
		}
	}
	return 0, false
}
