// 統合版(Bedrock)のプロトコル層だけを担当するサイドカー。
//
// JS 側のライブラリは player_auth_input の定義が実プロトコルと食い違っており
// (公式スキーマでは圧縮ビットセットなのに可変長配列として扱っている)、
// 送信系がほぼ全滅する。現行の統合版では player_auth_input は移動専用ではなく
// 採掘・設置・使用・インベントリ操作を全て運ぶ統合チャネルなので、
// これが壊れているとエージェントは何もできない。
//
// gophertunnel は Minecraft のリリースに追随しており protocol も一致するため、
// プロトコルの正しさをこちらに委譲する。
//
// TypeScript 側とは標準入出力で改行区切りJSONをやり取りする。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/df-mc/go-playfab/v2"
	"github.com/df-mc/go-xsapi/v2"
	"github.com/df-mc/go-xsapi/v2/xal/sisu"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/auth"
	"github.com/sandertv/gophertunnel/minecraft/p2p"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/sandertv/gophertunnel/minecraft/realms"
	"github.com/sandertv/gophertunnel/minecraft/service"
	"golang.org/x/oauth2"
)

// 標準出力に出す1行。TypeScript 側はこれを改行区切りで読む。
type event struct {
	Event string         `json:"event"`
	Data  map[string]any `json:"data,omitempty"`
	Error string         `json:"error,omitempty"`
}

func emit(e event) {
	b, err := json.Marshal(e)
	if err != nil {
		fmt.Fprintf(os.Stderr, "emit のシリアライズに失敗: %v\n", err)
		return
	}
	fmt.Println(string(b))
}

func fail(format string, args ...any) {
	emit(event{Event: "error", Error: fmt.Sprintf(format, args...)})
	os.Exit(1)
}

// MSA トークンをファイルにキャッシュする。毎回デバイスコード認証を要求しないため。
func liveToken(cachePath string) (*oauth2.Token, error) {
	if b, err := os.ReadFile(cachePath); err == nil {
		var tok oauth2.Token
		if err := json.Unmarshal(b, &tok); err == nil {
			return &tok, nil
		}
		// 壊れていたら取り直す
	}

	emit(event{Event: "auth_required", Data: map[string]any{
		"message": "ブラウザでサインインしてください（コードは標準エラー出力に出ます）",
	}})

	tok, err := auth.RequestLiveToken()
	if err != nil {
		return nil, fmt.Errorf("デバイスコード認証に失敗: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		return nil, fmt.Errorf("キャッシュ先を作成できない: %w", err)
	}
	b, err := json.Marshal(tok)
	if err != nil {
		return nil, fmt.Errorf("トークンをシリアライズできない: %w", err)
	}
	if err := os.WriteFile(cachePath, b, 0o600); err != nil {
		return nil, fmt.Errorf("トークンを保存できない: %w", err)
	}
	return tok, nil
}

func main() {
	invite := flag.String("invite", "", "Realm の招待コード（https://realms.gg/ は省略可）")
	cache := flag.String("token-cache", ".bedrock-auth/gophertunnel.json", "MSAトークンのキャッシュ先")
	hold := flag.Duration("hold", 60*time.Second, "接続を維持する時間")
	say := flag.String("say", "", "スポーン後に発言する内容（空なら発言しない）")
	cmd := flag.String("cmd", "", "スポーン後に実行するコマンド（例: say こんにちは）")
	flag.Parse()

	emit(event{Event: "ready", Data: map[string]any{
		"protocol": protocol.CurrentProtocol,
		"version":  protocol.CurrentVersion,
	}})

	if *invite == "" {
		fail("-invite を指定してください")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// --- 認証 ---
	tok, err := liveToken(*cache)
	if err != nil {
		fail("認証に失敗: %v", err)
	}
	msa := auth.AndroidConfig.TokenSource(ctx, tok)

	xbl, err := xsapi.ClientConfig{RTAMode: xsapi.RTALazy}.New(ctx, auth.AndroidConfig.New(msa, nil))
	if err != nil {
		var acct *sisu.AccountCreationRequiredError
		if errors.As(err, &acct) {
			fail("Xbox Live アカウントの作成が必要です: %s", acct.SignupURL)
		}
		fail("Xbox Live へのログインに失敗: %v", err)
	}
	defer xbl.Close()

	discovery, err := service.Default(ctx)
	if err != nil {
		fail("サービスディスカバリに失敗: %v", err)
	}
	env := new(service.AuthorizationEnvironment)
	if err := discovery.Environment(env); err != nil {
		fail("認証環境の解決に失敗: %v", err)
	}

	pf, err := playfab.LoginWithXbox(ctx, env.PlayFabTitleID, xbl, playfab.ClientConfig{CreateAccount: true})
	if err != nil {
		fail("PlayFab へのログインに失敗: %v", err)
	}
	defer pf.Close()

	src := env.TokenSource(pf, service.TokenConfig{})
	emit(event{Event: "authenticated"})

	// --- Realm の接続情報 ---
	rc := realms.NewClient(msa, nil)
	realm, err := rc.Realm(ctx, *invite)
	if err != nil {
		fail("Realm の取得に失敗: %v", err)
	}
	emit(event{Event: "realm", Data: map[string]any{
		"id": realm.ID, "name": realm.Name, "state": realm.State,
	}})

	addr, err := realm.Address(ctx)
	if err != nil {
		fail("接続先の取得に失敗: %v", err)
	}
	emit(event{Event: "address", Data: map[string]any{
		"address":         addr.Address,
		"networkProtocol": string(addr.NetworkProtocol),
		"region":          addr.SessionRegionData.RegionName,
	}})

	if addr.NetworkProtocol != realms.NetworkProtocolNetherNetJSONRPC {
		fail("未対応の接続方式です: %s", addr.NetworkProtocol)
	}

	// --- シグナリングと接続 ---
	// フレンドのワールドと違いセッションが無いので、接続種別を直接指定する。
	sig, err := p2p.DialClientSignaling(ctx, p2p.ConnectionTypeSignalingOverJSONRPC, src, p2p.ClientSignalingOptions{})
	if err != nil {
		fail("シグナリングの接続に失敗: %v", err)
	}
	defer func() { _ = sig.Close() }()
	emit(event{Event: "signaling_connected"})

	minecraft.RegisterNetwork("nethernet", func(l *slog.Logger) minecraft.Network {
		return minecraft.NetherNet{Signaling: sig, Log: l}
	})

	dialer := minecraft.Dialer{
		XBLClient:     xbl,
		PlayFabClient: pf,
		ClientData:    login.ClientData{},
	}
	// Dial は既定タイムアウトが短く、Realm の応答が間に合わないことがあるため
	// 明示的にコンテキストを渡す。
	dialCtx, dialCancel := context.WithTimeout(ctx, 90*time.Second)
	defer dialCancel()
	conn, err := dialer.DialContext(dialCtx, "nethernet", addr.Address)
	if err != nil {
		fail("Realm への接続に失敗: %v", err)
	}
	defer conn.Close()
	emit(event{Event: "connected"})

	if err := conn.DoSpawn(); err != nil {
		fail("スポーンに失敗: %v", err)
	}

	id := conn.GameData()
	// ChatRestrictionLevel が Dropped(1) なら、サーバーは発言を他プレイヤーにだけ
	// 落とし、送信者には返す。能力フラグの Muted も同様に発言だけを消す。
	// どちらも「エコーは返るのに誰にも届かない」症状を説明する。
	emit(event{Event: "spawn", Data: map[string]any{
		"entityRuntimeID":      id.EntityRuntimeID,
		"position":             []float32{id.PlayerPosition[0], id.PlayerPosition[1], id.PlayerPosition[2]},
		"dimension":            id.Dimension,
		"gameMode":             id.PlayerGameMode,
		"playerPermissions":    id.PlayerPermissions,
		"chatRestrictionLevel": id.ChatRestrictionLevel,
	}})

	// 他プレイヤーの発言を拾う。自分の発言もサーバーから返ってくる。
	// サーバーは受け入れられない移動を補正して返す。これを取り込まないと
	// 位置がずれ続け、以降の移動もすべて弾かれる。
	var posMu sync.Mutex
	pos := mgl32.Vec3{id.PlayerPosition[0], id.PlayerPosition[1], id.PlayerPosition[2]}
	corrections := 0
	readPos := func() mgl32.Vec3 {
		posMu.Lock()
		defer posMu.Unlock()
		return pos
	}

	// サーバーがこちらの位置を追跡しているかは、送られてくるチャンクの
	// 座標で分かる。位置が無視されていればスポーン周辺から動かない。
	var chunkMu sync.Mutex
	chunkSeen := map[[2]int32]bool{}
	chunkAt := func() (int32, int32, int32, int32, int) {
		chunkMu.Lock()
		defer chunkMu.Unlock()
		if len(chunkSeen) == 0 {
			return 0, 0, 0, 0, 0
		}
		var minX, maxX, minZ, maxZ int32
		first := true
		for c := range chunkSeen {
			if first {
				minX, maxX, minZ, maxZ, first = c[0], c[0], c[1], c[1], false
				continue
			}
			if c[0] < minX {
				minX = c[0]
			}
			if c[0] > maxX {
				maxX = c[0]
			}
			if c[1] < minZ {
				minZ = c[1]
			}
			if c[1] > maxZ {
				maxZ = c[1]
			}
		}
		return minX, maxX, minZ, maxZ, len(chunkSeen)
	}

	go func() {
		for {
			pk, err := conn.ReadPacket()
			if err != nil {
				return
			}
			switch v := pk.(type) {
			case *packet.LevelChunk:
				chunkMu.Lock()
				chunkSeen[[2]int32{v.Position.X(), v.Position.Z()}] = true
				chunkMu.Unlock()
			case *packet.UpdateAbilities:
				// Muted が立っていれば発言はサーバーで落とされる。
				for _, l := range v.AbilityData.Layers {
					emit(event{Event: "abilities", Data: map[string]any{
						"layer":     l.Type,
						"muted":     l.Values&(protocol.AbilityMuted) != 0,
						"mutedSet":  l.Abilities&(protocol.AbilityMuted) != 0,
						"values":    l.Values,
						"abilities": l.Abilities,
					}})
				}
			case *packet.MovePlayer:
				// コマンドが実際に実行されたかは、/tp で自分が飛ばされるかで分かる。
				// CommandOutput は返らないことがあるが、これは効果そのものを見る。
				if v.EntityRuntimeID == id.EntityRuntimeID {
					posMu.Lock()
					pos = mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]}
					posMu.Unlock()
					emit(event{Event: "moved_by_server", Data: map[string]any{
						"position": []float32{v.Position[0], v.Position[1], v.Position[2]},
						"mode":     v.Mode,
					}})
				}
			case *packet.CorrectPlayerMovePrediction:
				posMu.Lock()
				pos = mgl32.Vec3{v.Position[0], v.Position[1], v.Position[2]}
				corrections++
				n := corrections
				posMu.Unlock()
				// 毎tick出ると読めないので最初の数回だけ報せる
				if n <= 3 {
					emit(event{Event: "move_correction", Data: map[string]any{
						"position": []float32{v.Position[0], v.Position[1], v.Position[2]},
						"onGround": v.OnGround,
						"tick":     v.Tick,
					}})
				}
			case *packet.CommandOutput:
				emit(event{Event: "command_output", Data: map[string]any{
					"success": v.SuccessCount,
					"count":   len(v.OutputMessages),
				}})
			}
			if t, ok := pk.(*packet.Text); ok {
				// 実クライアントが何を埋めているかを見るため全フィールドを出す。
				// こちらの送信との差分がチャットが表示されない原因の手掛かりになる。
				emit(event{Event: "text", Data: map[string]any{
					"type":             t.TextType,
					"source":           t.SourceName,
					"message":          t.Message,
					"xuid":             t.XUID,
					"needsTranslation": t.NeedsTranslation,
					"parameters":       t.Parameters,
					"platformChatID":   t.PlatformChatID,
					"filteredMessage":  optString(t.FilteredMessage),
				}})
			}
		}
	}()

	// サーバー権限型なので、クライアントは毎tick player_auth_input を送って
	// 「稼働中のプレイヤー」であり続ける必要がある。これを送らないと
	// 接続はあってもチャットが中継されず、コマンドも黙殺される。
	go func() {
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		var tick uint64
		for range t.C {
			tick++
			// 入力フラグは「ゼロ値 = 未送信」であり、空の集合とは別物である。
			// NewInputFlags を通さないとフィールドごと送られず、サーバーは
			// この player_auth_input を入力として扱わない。
			flags := protocol.NewInputFlags(packet.InputFlagCount)
			move := mgl32.Vec2{}
			delta := mgl32.Vec3{}
			yaw := id.Yaw

			// 5秒待ってから東(+X)へ歩き続ける。走行速度は約4.3ブロック/秒。
			// 60秒あれば十数チャンク分は進むので、サーバーが位置を追跡して
			// いれば新しいチャンクが次々に届くはずである。
			// 座標は自前で進めない。前進入力だけを送り、サーバーが動かした
			// 結果を補正パケットから受け取る。これで「サーバーが入力を
			// 受理しているか」を、こちらの予測とは無関係に判定できる。
			// 塞がれている方向だと動かないので、15秒ごとに向きを変える。
			if tick > 100 {
				yaws := []float32{-90, 0, 90, 180} // 東, 南, 西, 北
				yaw = yaws[((tick-100)/300)%uint64(len(yaws))]
				flags.Set(packet.InputFlagUp)
				move = mgl32.Vec2{0, 1}
			}
			sendPos := readPos()
			if err := conn.WritePacket(&packet.PlayerAuthInput{
				Pitch:            id.Pitch,
				Yaw:              yaw,
				HeadYaw:          yaw,
				Position:         sendPos,
				MoveVector:       move,
				InputData:        flags,
				InputMode:        packet.InputModeMouse,
				PlayMode:         packet.PlayModeNormal,
				InteractionModel: packet.InteractionModelCrosshair,
				Tick:             tick,
				Delta:            delta,
			}); err != nil {
				return
			}
		}
	}()
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for range t.C {
			minX, maxX, minZ, maxZ, n := chunkAt()
			emit(event{Event: "chunks", Data: map[string]any{
				"count":  n,
				"chunkX": []int32{minX, maxX},
				"chunkZ": []int32{minZ, maxZ},
				"posX":   readPos()[0],
				"posZ":   readPos()[2],
			}})
		}
	}()
	emit(event{Event: "ticking"})

	if *say != "" {
		// チャンクの読み込みなどが落ち着いてから送る
		time.Sleep(3 * time.Second)
		if err := conn.WritePacket(&packet.Text{
			TextType:   packet.TextTypeChat,
			SourceName: conn.IdentityData().DisplayName,
			Message:    *say,
			XUID:       conn.IdentityData().XUID,
		}); err != nil {
			emit(event{Event: "error", Error: fmt.Sprintf("発言の送信に失敗: %v", err)})
		} else {
			emit(event{Event: "said", Data: map[string]any{"message": *say}})
		}
	}

	if *cmd != "" {
		time.Sleep(2 * time.Second)
		// /say はシステムメッセージとして配信されるので、
		// プレイヤー間チャットのフィルタを受けない。切り分けに使う。
		if err := conn.WritePacket(&packet.CommandRequest{
			CommandLine: *cmd,
			CommandOrigin: protocol.CommandOrigin{
				Origin:         protocol.CommandOriginPlayer,
				UUID:           uuid.New(),
				PlayerUniqueID: id.EntityUniqueID,
			},
			Version: "52",
		}); err != nil {
			emit(event{Event: "error", Error: fmt.Sprintf("コマンドの送信に失敗: %v", err)})
		} else {
			emit(event{Event: "commanded", Data: map[string]any{"command": *cmd}})
		}
	}

	time.Sleep(*hold)
	emit(event{Event: "done"})
}

// Optional なフィールドをログに出すための小道具。未設定は null になる。
func optString(o protocol.Optional[string]) any {
	if v, ok := o.Value(); ok {
		return v
	}
	return nil
}
