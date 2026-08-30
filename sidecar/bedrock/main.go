// 統合版(Bedrock)のプロトコル層だけを担当するサイドカー。
//
// JS 側のライブラリは player_auth_input の定義が実プロトコルと食い違っており
// (公式スキーマでは圧縮ビットセットなのに可変長配列として扱っている)、
// 送信系がほぼ全滅する。gophertunnel は Minecraft のリリースに追随しており
// CurrentProtocol も一致するため、プロトコルの正しさをこちらに委譲する。
//
// TypeScript 側とは標準入出力で改行区切りJSONをやり取りする。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/auth"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/realms"
	"golang.org/x/oauth2"
)

// 標準出力に出す1行。TypeScript 側はこれを改行区切りで読む。
type event struct {
	Event string `json:"event"`
	// 進捗や結果の中身。イベント種別ごとに使うキーが違う。
	Data map[string]any `json:"data,omitempty"`
	// 失敗時のみ入る
	Error string `json:"error,omitempty"`
}

func emit(e event) {
	b, err := json.Marshal(e)
	if err != nil {
		// ここで失敗するのは実装バグなので握り潰さない
		fmt.Fprintf(os.Stderr, "emit のシリアライズに失敗: %v\n", err)
		return
	}
	fmt.Println(string(b))
	os.Stdout.Sync()
}

func fail(format string, args ...any) {
	emit(event{Event: "error", Error: fmt.Sprintf(format, args...)})
	os.Exit(1)
}

// トークンをファイルにキャッシュする。毎回デバイスコード認証を要求しないため。
func tokenSource(cachePath string) (oauth2.TokenSource, error) {
	if b, err := os.ReadFile(cachePath); err == nil {
		var tok oauth2.Token
		if err := json.Unmarshal(b, &tok); err == nil {
			return auth.RefreshTokenSource(&tok), nil
		}
		// 壊れていたら取り直す
	}

	emit(event{Event: "auth_required", Data: map[string]any{
		"message": "ブラウザでサインインしてください（コードは標準エラー出力に表示されます）",
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
	return auth.RefreshTokenSource(tok), nil
}

func main() {
	invite := flag.String("invite", "", "Realm の招待コード（https://realms.gg/ は省略可）")
	cache := flag.String("token-cache", ".bedrock-auth/gophertunnel.json", "トークンのキャッシュ先")
	flag.Parse()

	emit(event{Event: "ready", Data: map[string]any{
		"protocol": protocol.CurrentProtocol,
		"version":  protocol.CurrentVersion,
	}})

	if *invite == "" {
		fail("-invite を指定してください")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	src, err := tokenSource(*cache)
	if err != nil {
		fail("認証に失敗: %v", err)
	}

	client := realms.NewClient(src, nil)

	realm, err := client.Realm(ctx, *invite)
	if err != nil {
		fail("Realm の取得に失敗: %v", err)
	}
	emit(event{Event: "realm", Data: map[string]any{
		"id":    realm.ID,
		"name":  realm.Name,
		"state": realm.State,
	}})

	// Realm が停止していれば起動を待ってから address を返してくれる
	addr, err := realm.Address(ctx)
	if err != nil {
		fail("接続先の取得に失敗: %v", err)
	}
	emit(event{Event: "address", Data: map[string]any{
		"address":         addr.Address,
		"networkProtocol": string(addr.NetworkProtocol),
		"region":          addr.SessionRegionData.RegionName,
		"pendingUpdate":   addr.PendingUpdate,
	}})
}
