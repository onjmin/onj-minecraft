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
2. `pnpm test` を通す。生存の判断(裁定者・ルール表・計測)はサーバー無しで試せる。
3. 生存ループに触ったなら `pnpm scenario` をローカルで通してから本番へ繋ぐ。
4. ホットリロードはサイドカー残留や `duplicate_login` を引き起こすため使用しない。
5. **指示を待たずに `bash scripts/run-bedrock.sh` で再起動して反映すること。**
6. 改修タスクの完了条件には「再起動とプロセスの稼働確認（アカウントが `kusabot2361` であること）」までを含む。

### 生存ループの作り

死に方だけを見て反射を足し続けた結果、`agent.ts` は1364行から5040行に増え、
反射は15個・共有フィールドは27個が多重書き込みという状態になった。5日ぶんの
ログで死亡率は 5.5〜5.9回/時から動かず、2026-09-17 には3つの反射が噛み合って
4時間26分スキルが1つも動かない停止が起きている。いまは次の形にしてある。

- **判断は `src/core/survival/` に集める。** ルールは `when`(純粋な前提条件)と
  `run`(行動)だけを持ち、他のルールを黙らせる手段も、共有フィールドで合図する
  手段も持たない。誰が担当するかと、いつまで掴んでよいかは裁定者が1箇所で決める。
- **保持には必ず期限がある。** 期限の無い保持を1つでも許すと、そこで止まった
  ときに誰も気づけない。上限は裁定者が一括で強制する(夜の籠りだけ例外)。
- **ルールを足すコストは「順位表に1行」。** 既存との組み合わせを数える必要は無い。
  順位そのものが仕様なので、並べ替えたら理由を `rules.ts` に書くこと。
- **スキルは「やったか」ではなく「変わったか」で判定する。**
  `src/skills/inventory-delta.ts` を使い、持ち物か位置が変わらなければ空振り。
- **成果は `src/core/survival/metrics.ts` が測る。** 10分ごとに1行出て、
  `logs/metrics-*.json` に残る。死亡間隔の中央値・食料保有率・空振り率・
  最長停滞。変更が効いたかどうかはこの数字で言うこと。

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
