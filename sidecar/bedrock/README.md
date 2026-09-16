# 統合版プロトコル用サイドカー

統合版(Bedrock)のプロトコル層だけを担当する Go プロセス。
TypeScript 側の `BedrockDriver` から起動して、標準入出力で改行区切りJSONをやり取りする。

## なぜ分離するのか

JS のライブラリ(`bedrock-protocol` / BedrockX / `minecraft-data`)は
`player_auth_input` の定義が実プロトコルと食い違っている。

Mojang が公開している公式スキーマ(https://github.com/Mojang/bedrock-protocol-docs)では

    "Input Data": {
      "description": "Bitset of per-tick input flags. Each flag gates additional optional fields below.",
      "x-serialization-options": ["Compression", "Enum-as-Value"]
    }

と、圧縮ビットセットで後続の任意フィールドの有無を決める形。
一方 JS 側は可変長配列 + presence 真偽値5個としており、エンコードが根本的に違う。
このため input_data 以降の読み取りが全てズレ、サーバーに

    {"violation_type":"malformed","packet_id":144,"reason":"BinaryStream read() incomplete"}

と判定されて切断される。`command_request` も同様に壊れている。

現行の統合版では `player_auth_input` は移動専用ではなく、採掘(block_action)・
設置や使用(transaction)・インベントリ操作(item_stack_request)を全て運ぶ統合チャネルなので、
これが壊れていると能動的な操作がほぼ全滅する。

gophertunnel は Minecraft のリリースに追随しており protocol=2193 / version=1.26.50 と一致するため、
プロトコルの正しさをこちらに委譲する。

Realm は勝手に最新版へ上がるので、この版が遅れると接続が `client outdated` で
弾かれる。実際 2026-09-16 に 1.26.50 が出た直後、2169 のままだった間は
一切繋がらなかった。そのときは `go.mod` の replace 先を上げてビルドし直す。

## 構成

| 部品 | 調達 |
| --- | --- |
| Bedrock プロトコル定義 | gophertunnel（委譲） |
| Realm の接続情報取得 | gophertunnel の realms パッケージ（委譲） |
| NetherNet トランスポート | df-mc/go-nethernet（委譲） |
| franchise シグナリング | 既製品が無いため自前。BedrockX の実装で動作実績のあるロジックを移植する |

## ビルド

ホストに Go は不要。Docker で行う。

    docker run --rm -v "$(pwd)":/w -w /w golang:1.26 go build -o sidecar .
