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

### 判断は LLM、コードは反射だけ

**状況判断をコード側の if やルールで書き足さない。** マイクラの状況は組み合わせが
無限で、コードで網羅することはできない。判断は LLM がする。コードの仕事は
(1) 事実を欠かさず LLM に渡すこと、(2) LLM を待てない秒未満の反射、(3) 反射が
何をして何に失敗したかを LLM に報告すること、の3つである。

これは実測から来ている。2026-08-25 から 09-19 の3週間半で `agent.ts` は
1343→4778行、if は113→337、生存ルール層は0→1538行に増え、LLM への情報経路
(`prompt-builder.ts`)は184→323行しか増えなかった。死亡率は 1.9〜8.7回/時で
傾向なし。死ぬ→ログを読む→その場面を塞ぐ分岐を足す、が繰り返され、反射層は
LLM の選択を止め、失敗の理由も LLM に返さない層になっていた(「かまどが無い」で
43回同じ失敗)。参考実装の mindcraft は逆で、反射(modes.js)は10個・446行、
行動は behavior_log で LLM に報告され、LLM が `!setMode` で切れる。

死亡や空回りを見つけたら、ルールを足す前に問うこと。
1. LLM はこの状況と失敗理由を見えていたか。見えていないなら直すのは
   `src/core/survival/situation.ts`(事実の言語化)か `reflex-log.ts`(反射の報告)。
2. 見えていて選べなかったなら、足りないのはスキルか、その説明か、モデルか。
3. 秒未満で判断が要らず、待てば死ぬ。それだけが `rules.ts` に入る資格を持つ。

いまの形:

- **反射は `src/core/survival/rules.ts` の4本だけ。** escape_boxed_in / eat /
  sleep / shelter。地上へ出る・食料・武器・危険域・落とし物は LLM が選ぶ通常
  スキル。ルールは `when`(純粋な前提条件)と `run`(行動)と `report`(LLM への
  英語1行)を持ち、他を黙らせる手段も共有フィールドも持たない。
- **裁定者(`arbiter.ts`)が担当と期限を1箇所で決める。** 保持には必ず期限がある。
  行動が失敗したら担当を手放して冷却し、理由を LLM に渡す(`yield`)。同じ失敗を
  繰り返すのは裁定者の仕事ではない。
- **事実は `situation.ts` が LLM に渡す。** 地下の深さ・夜明けまでの分・危険域の
  出口座標・生肉はあるがかまどが無い・落とし物の位置。反射と同じ snapshot から
  作るので、反射が知っていて LLM が知らない事実、という差ができない。
- **思考はイベント駆動。** スキルの失敗・反射の手放し・死亡で即座に考え直す
  (最短間隔 `THINK_MIN_GAP_MS`)。30秒の周期はそれが無いときの下限。
- **スキルの一覧から削らない。** 前提が欠けているスキルは `[PRECONDITION UNMET: 理由]`
  と注記して全部見せる(`skillPrecondition`)。外すのは対象が存在しないもの(落とし物なし・
  人工物未発見・近くに人なし)だけ。以前は「ツルハシが無い」「地下だ」でコード側が
  選択肢を消していた。
- **乗り換えは LLM が決める。** 「担当して60秒未満なら別の行動を却下」は無くした。
  走っている行動の経過を `CURRENT ACTION` として渡し、同じスキルを選び直せば続き、
  別を選べば止まる。危険域内の目的地の拒否(goto.coords)、死亡後の explore 強制切替も
  同じ理由で無くした。
- **スキルは「やったか」ではなく「変わったか」で判定する。**
  `src/skills/inventory-delta.ts` を使い、持ち物か位置が変わらなければ空振り。
- **成果は `src/core/survival/metrics.ts` が測る。** 10分ごとに1行出て、
  `logs/metrics-*.json` に残る。変更が効いたかどうかはこの数字で言うこと。
- **状況を作って採点する台が `pnpm scenario`。** `SCENARIO=night-underground`
  (夜・地下20マスから地上へ出られるか)、`SCENARIO=raw-food`(生肉あり・かまど
  無しから食事に至れるか)。本番8時間・1標本ではなくローカル12分で確かめる。
  確かめられない変更は、確かめられる場所(コードの分岐)へ逃げる。台が先。

- **食べる・隠れるも LLM が選べる。** `survival.eat`(item 省略可。生の鶏肉も LLM が
  選べば食べる)と `survival.hide`(反射の shelter と同じ動作)。反射の eat/shelter は
  LLM が黙っているときの既定で、`Hide: no` で切れる。LLM が `Hide: yes` と明示した
  籠りは計測で `shelter(llm)` として分け、「握りっぱなし」には数えない。
- **同じスキルの連続失敗は再実行の間隔を倍々に広げる**(2s→20s)。判断ではなく、
  同じ入力で同じ結果になるものを叩く回数の話。思考が別を選べば戻る。
- **サイドカーの毎tick反射(逃げるか殴るか)の方針は LLM が `Stance:` で決める。**
  auto(既定: 素手・低体力・クリーパーなら逃げる)/ flee / fight。サイドカーの
  `stance` コマンドで渡り、`defendLocked` が読む。死んだら auto に戻る。呼吸・
  被弾時の即応そのものは残す(LLM を待てない)。mindcraft の cowardice /
  self_defense のオンオフに相当。
- **採点は課題を渡せる。** `agent.injectRequest(from, text)` で「丸石を8個集めて」の
  ような依頼を置く(`SCENARIO=cobble`)。渡さないと LLM は自分の優先で動き、
  測りたいスキルが呼ばれないことがある。

残っている宿題: `goto.surface` は手掘りだと1段35秒(石を素手で3個)で、密室(3x3)
では踏み台を見つけられない。柱積み(足元に置いて跳ぶ)がサイドカーの移動で
通らないのが根。これはスキルの能力の話で、分岐を足す対象ではない。

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
