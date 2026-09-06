# 統合版Realms 接続スパイク (M0)

統合版Realmsへの接続可否を検証した使い捨てスクリプト。2026-08-29 に接続成功を確認済み。

## 分かったこと

統合版Realmsは **RakNet(UDP) ではなく NetherNet(WebRTC/P2P)** を使う。
`GET /worlds/{id}/join` のレスポンスは以下で、IPもポートも存在しない。

```json
{ "networkProtocol": "NETHERNET_JSONRPC",
  "address": "33c9e68a-c981-46f8-ab48-17bf573f54c9",
  "sessionRegionData": { "regionName": "JapanWest" } }
```

このため以下は**すべて接続不可**（全部 RakNet 前提で、NetherNet のコードを含まない）:

- `mineflayer`（そもそもBedrock非対応）
- `bedrock-protocol`（npm最新 3.58.3 / master とも未対応）
- `mineflayer-for-bedrock`, `minetoring`（bedrock-protocol の上に乗っている）

PrismarineJS の NetherNet 対応は `nethernet` ブランチにあるが未完成
（統合PR #774 は draft）。実測ではシグナリングまでは通るが、Realm から
CONNECTRESPONSE が返らず接続できなかった。
（ついでにバグを1つ発見: リージョン名から組む `signal-japanwest.franchise.minecraft-services.net`
は存在しないホスト。既定の `signal.franchise.minecraft-services.net` なら通る）

**動いたのは [thejfkvis/BedrockX](https://github.com/thejfkvis/BedrockX)(MIT) のみ。**

## 実行方法

```bash
git clone https://github.com/thejfkvis/BedrockX.git
cd BedrockX && npm install
cp /path/to/spikes/bedrock-realms/connect.js .
REALM_INVITE=https://realms.gg/xxxxxxx node connect.js
```

初回はMSAデバイスコード認証が走る。表示されたURLとコードをブラウザで入力する。

## 重要な注意点

1. **認証方式が決め手**。`flow: "sisu"` + `Titles.MinecraftIOS` + `deviceType: "iOS"` +
   `protocolVersion: 2169` が必要。PrismarineJS 既定の `flow: "live"` + Nintendo Switch title
   では Realm 側から接続を閉じられる。
2. **`/worlds/{id}/join` は正常時も断続的に 503 を返す**。リトライ必須（BedrockX は内部で実装済み）。
3. **BedrockX の client は `spawn` を emit しない**（`emit('spawn')` はサーバ側の
   `serverPlayer.js` にしか無い）。このスクリプトは以下を自前で行っている:
   - `start_game` で `runtime_entity_id` を保持し `request_chunk_radius` を送信
   - `play_status: player_spawn` を受けて `set_local_player_as_initialized` を送信
4. 送信APIは `client.queue()` ではなく **`client.write()`**。
5. BedrockX のサンプルは接続前に `postStorySettings`（座標表示等のRealm設定変更）を呼ぶが、
   **このスクリプトでは意図的に外している**。接続には不要だった。

## 実測結果

```
[play_status] {"status":"login_success"}
[start_game] pos={"x":586.7,"y":-3.38,"z":-925.16} dim=overworld runtime_entity_id=34n
[play_status] {"status":"player_spawn"}
spawn 到達 : YES
level_chunk: 277   ← ワールドデータ取得OK
add_entity:minecraft:glow_squid × 4
inventory_content × 4
update_attributes × 6
```
