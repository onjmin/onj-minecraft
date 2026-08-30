// 統合版(Bedrock)のプロトコル層だけを担当するサイドカー。
//
// JS 側のライブラリは player_auth_input の定義が実プロトコルと食い違っており
// (input_data が圧縮ビットセットなのに可変長配列として扱っている)、
// 送信系がほぼ全滅する。gophertunnel は Minecraft のリリースに追随しており
// CurrentProtocol も一致するため、プロトコルの正しさをこちらに委譲する。
//
// TypeScript 側とは標準入出力で改行区切りJSONをやり取りする。
package main

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

func main() {
	// まずは依存が解決してビルドが通ることの確認
	fmt.Printf("gophertunnel protocol=%d version=%s\n",
		protocol.CurrentProtocol, protocol.CurrentVersion)
}
