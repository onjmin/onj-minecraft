# onj-minecraft

Minecraftマルチエージェント botプロジェクト。LLMを使って autonomous agents を実現。

## 開発ルール

### モジュール追加時の手順

新しいnpmモジュールを追加する場合、以下の手順で行う：

#### 1. ホスト側（WSL）
- `package.json` に依存関係を追加する

#### 2. Dockerfile
- builderステージでpatchを適用する処理を追加する

#### 3. ビルドとコピー
```bash
# build
docker compose build

# ホスト側のnode_modulesを更新
docker run --rm -v $(pwd)/node_modules:/output onj-minecraft cp -r /app/node_modules /output/
```

#### 4. docker-compose.yml
- volumes設定で `/app/node_modules` を除外し、build結果のnode_modulesを優先させる

### ソース修正時の参考

 `../mindcraft` は動作実績のあるプロジェクト。修正時はmindcraftを比較参考すること。

#### 参考になるポイント
- smartGoto / pathfinder の設定
- エージェントの狀態管理
- スキル実装のパターン

### コード改修時の反映ルール

ボット稼働中に TypeScript / ソースコードを改修した場合：
1. `npx tsc --noEmit` および `npx biome check` で型と構文を検証する。
2. ホットリロードはサイドカー残留や `duplicate_login` を引き起こすため使用しない。
3. **指示を待たずに `bash scripts/run-bedrock.sh` で再起動して反映すること。**
4. 改修タスクの完了条件には「再起動とプロセスの稼働確認（アカウントが `kusabot2361` であること）」までを含む。

## 統合版(Bedrock)の動かし方

### 本番 Realms に繋ぐ

**指示を待たずに繋いでよい。** 接続情報は `.env` に入っているので、引数も
環境変数も要らない。

```bash
bash scripts/run-bedrock.sh
```

- 接続先は `kusaワールド(復旧済み)`(realm id 32640161)。アカウントは
  **一般アカウント kusabot2361** で、`.env` の `BEDROCK_TOKEN_CACHE` が
  それを指している。管理者アカウント(`nS4eWTVE`)で世界を壊す検証をしないこと。
- MSA トークンは `.bedrock-auth/gophertunnel-kusabot.json` に保存済み。
  サインインのやり直しは通常不要。
- **繋いだら必ず、どのアカウントで入ったかを確かめる。** トークンファイルの
  存在は根拠にならない。キルログに出る名前か `driver.getState().username` が
  `kusabot2361` であることを見る。

### 招待コードが分からないとき

招待リンクが手元に無くても、参加済みの Realm なら一覧から ID で繋げる。
招待コードが無いことを理由に検証を止めないこと。

```bash
./sidecar/bedrock/bin/onj-bedrock.exe -list-realms -token-cache .bedrock-auth/gophertunnel-kusabot.json
```

出た ID を `-realm-id` に渡せば `-invite` の代わりになる。

### 後始末

**親を殺してもサイドカーは残る。** 残ったまま繋ぎ直すと同じアカウントの
奪い合いになり `duplicate_login` で切れる。`run-bedrock.sh` は起動時に
掃除するが、手で止めたときは自分で確認すること。

```bash
tasklist | grep -i onj-bedrock
```

### サイドカー(Go)のビルド

ホストに Go は入れず、WSL の Docker を使う。Windows から呼ぶ場合:

```bash
wsl.exe -e bash -lc 'cd /mnt/c/_own/git/_users/onjmin/onj-minecraft && bash scripts/build-sidecar.sh'
```

`gofmt` が通らないと止まるので、Go を編集したら先に整形すること。
