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
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/df-mc/go-playfab/v2"
	"github.com/df-mc/go-xsapi/v2"
	"github.com/df-mc/go-xsapi/v2/xal/sisu"
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
	address := flag.String("address", "", "開発用: 統合版サーバーへ直に繋ぐ (例: 127.0.0.1:19132)")
	name := flag.String("name", "", "開発用: 表示名を指定する（複数体を繋ぎ分けるため。online-mode=false のときだけ効く）")
	flag.Parse()

	emit(event{Event: "ready", Data: map[string]any{
		"protocol": protocol.CurrentProtocol,
		"version":  protocol.CurrentVersion,
	}})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 開発用のプロキシ。実クライアントが何を送っているかを見るためのもの。
	if listen, upstream, ok := proxyRequested(); ok {
		runProxy(ctx, listen, upstream)
		return
	}

	// 開発用のローカルサーバーへ直に繋ぐ経路。Realms は NetherNet だが
	// 自前で立てた統合版サーバーは RakNet なので、認証もシグナリングも要らない。
	// online-mode=false で動かす前提。
	if *address != "" {
		// 開発用。gophertunnel が内部で握り潰すエラーを見えるようにする。
		// これが無いと切断理由が "context canceled" としか分からない。
		d := &minecraft.Dialer{
			ErrorLog: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
				Level: slog.LevelDebug,
			})),
		}
		if os.Getenv("BEDROCK_TRACE") == "1" {
			// 切断の直前に何が来ていたかを見るための覗き窓。
			d.PacketFunc = func(h packet.Header, payload []byte, src, dst net.Addr) {
				if h.PacketID == packet.IDCommandRequest {
					fmt.Fprintln(os.Stderr, "cmdreq bytes:", hex.EncodeToString(payload))
					return
				}
				fmt.Fprintln(os.Stderr, "pkt id=", h.PacketID, "len=", len(payload), "from=", src)
			}
		}
		if *name != "" {
			// オフライン接続の表示名は IdentityData 側。ClientData ではサーバーに
			// 反映されず Steve のままになる。
			d.IdentityData = login.IdentityData{DisplayName: *name}
			d.ClientData = login.ClientData{ThirdPartyName: *name}
		}
		conn, err := d.DialContext(ctx, "raknet", *address)
		if err != nil {
			fail("サーバーへの接続に失敗(%s): %v", *address, err)
		}
		defer conn.Close()
		emit(event{Event: "connected", Data: map[string]any{"address": *address}})
		runSession(ctx, conn)
		return
	}

	if *invite == "" {
		fail("-invite か -address を指定してください")
	}

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

	runSession(ctx, conn)
}

// runSession はスポーンさせてからセッションに引き渡す。
// Realms 経由でもローカルサーバーでも、ここから先の扱いは同じ。
func runSession(ctx context.Context, conn *minecraft.Conn) {
	if err := conn.DoSpawn(); err != nil {
		fail("スポーンに失敗: %v", err)
	}

	id := conn.GameData()
	emit(event{Event: "spawn", Data: map[string]any{
		"entityRuntimeID":      id.EntityRuntimeID,
		"position":             []float32{id.PlayerPosition[0], id.PlayerPosition[1], id.PlayerPosition[2]},
		"dimension":            id.Dimension,
		"gameMode":             id.PlayerGameMode,
		"playerPermissions":    id.PlayerPermissions,
		"chatRestrictionLevel": id.ChatRestrictionLevel,
	}})

	// ここから先はセッションに委ねる。標準入力のコマンドで操作し、
	// 状態の変化を標準出力へ流す。
	newSession(conn, id).serve(ctx)
	emit(event{Event: "done"})
}
