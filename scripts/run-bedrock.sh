#!/bin/bash
# 統合版のエージェントを回し続ける。
#
# Realms は10人までなので、混んでいるとボットは自分から抜ける(終了コード3)。
# そのときは時間を置いて入り直す。人が減っていればそのまま居座れる。
#
# 実行（引数も環境変数も要らない。接続情報は .env から読む）:
#   bash scripts/run-bedrock.sh
#
# .env に要るのは次の2つ。どちらも .env.example に説明がある。
#   REALM_INVITE          招待コード（URL 丸ごとでも可）
#   BEDROCK_TOKEN_CACHE   使うアカウント。検証は必ず kusabot2361 側にする
#
# 招待コードが見つからないときは、参加済みの Realm を一覧して ID で繋げる:
#   ./sidecar/bedrock/bin/onj-bedrock.exe -list-realms -token-cache .bedrock-auth/gophertunnel-kusabot.json
set -u

# .claude/worktrees/ 配下（Claude Codeのサブエージョンが isolation:"worktree" で
# 作る、このリポジトリの独立コピー）から起動していないか確認する。
#
# 2026-09-11、そこで動かしっぱなしになっていたコピーが本家と同じ
# kusabot2361アカウント・同じ .env を使い続け、本家の再接続を「別デバイスで
# 接続中」で塞ぎ、unj-thread.jsonもcwd基準の相対パスなので気づかれずに
# 別スレを立て続けていた。隔離されるのはファイルシステムだけで、Realms
# アカウントやunjのスレ状態のような外部リソースは分離されないため、
# worktreeから本番へ繋ぐと必ず本家と衝突する。
# どうしても検証で使う場合は ALLOW_WORKTREE_BEDROCK=1 で明示的に許可する。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ "$SCRIPT_DIR" == *"/.claude/worktrees/"* ]] && [ "${ALLOW_WORKTREE_BEDROCK:-}" != "1" ]; then
  echo "[run] .claude/worktrees/ 配下からの起動を検知したため中止します。" >&2
  echo "[run] 本番Realm/kusabot2361と衝突します。本家のチェックアウトから実行してください。" >&2
  echo "[run] どうしても必要なら ALLOW_WORKTREE_BEDROCK=1 を付けて再実行してください。" >&2
  exit 1
fi

# 自分の Windows 側の PID を調べる。
#
# Git Bash の `$$` は MSYS の pid であって、Windows の pid ではない。
# ps -W は両方を並べて出すので、そこから引く。
my_winpid() {
  ps -W 2>/dev/null | awk -v p="$$" '$1==p {print $4; exit}'
}

# そのプロセスがまだ生きているか。msys pid と Windows pid のどちらでも見る。
alive() { # $1=msys pid, $2=win pid
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && return 0
  [ -n "${2:-}" ] && ps -W 2>/dev/null | awk -v w="$2" '$4==w {found=1} END{exit !found}' && return 0
  return 1
}

# 前の実行(run-bedrock.sh自身)が残っていたら止めてから始める。
#
# pnpm run start:bedrock を二重起動すると、tsxプロセスが2本並走し、
# 同じアカウントの奪い合い(duplicate_login)だけでなく、logs/unj-thread.json
# の読み書きがプロセスごとに独立してレースし、起動の度にunjスレが
# 複数本立つ(本番影響あり)。PIDファイルで前回分を強制終了してから
# 自分のPIDを書き込む。
#
# PIDファイルには msys pid と Windows pid を両方書く。
# 以前は `$$`(msys pid)だけを書き、それをそのまま taskkill //PID に渡して
# いた。taskkill は Windows の pid しか解さないので、まったく別のプロセスを
# 狙うことになる。実測 2026-09-12、ファイルには 3151 が入っていたのに、
# 実際に走っていたループの Windows pid は 37256 だった。止め損ねたループが
# もう1本走り続け、同じアカウントを奪い合って "Cannot join world ...
# different device" で20分ほど弾かれ続けた。無関係の Windows プロセスを
# 巻き込む危険もある。
PID_FILE="$(dirname "$0")/.run-bedrock.pid"
SELF_MSYS="$$"
SELF_WIN="$(my_winpid)"

if [ -f "$PID_FILE" ]; then
  OLD_MSYS=""
  OLD_WIN=""
  read -r OLD_MSYS OLD_WIN < "$PID_FILE" 2>/dev/null || true
  if [ -n "${OLD_MSYS:-}" ] && [ "$OLD_MSYS" != "$SELF_MSYS" ]; then
    if alive "$OLD_MSYS" "${OLD_WIN:-}"; then
      echo "[run] 前回のrun-bedrock.sh(msys=$OLD_MSYS win=${OLD_WIN:-?})を止める"
      kill -9 "$OLD_MSYS" >/dev/null 2>&1 || true
      # Windows pid が分かっているときだけ taskkill を使う。msys pid を
      # 渡してはいけない(別プロセスを殺す)。
      #
      # //T を付けない。付けるとループ・node・サイドカーが同時に落ち、
      # サイドカーは標準入力の EOF を受け取れずに死ぬ。すると Realm へ
      # 切断が届かず、次の接続が "different device" で弾かれる
      # (詳しくは下の「前の実行が残した〜」の節)。ここではループだけ止め、
      # node とサイドカーは後で順番に畳む。
      if [ -n "${OLD_WIN:-}" ] && command -v taskkill >/dev/null 2>&1; then
        taskkill //F //PID "$OLD_WIN" >/dev/null 2>&1 || true
      fi
      # 本当に消えたか確かめる。消せないまま進むと2本走り、同じアカウントを
      # 奪い合って延々と弾かれる。黙って続けるのが一番たちが悪い。
      for _ in 1 2 3 4 5; do
        alive "$OLD_MSYS" "${OLD_WIN:-}" || break
        sleep 1
      done
      if alive "$OLD_MSYS" "${OLD_WIN:-}"; then
        echo "[run] 前回のループを止められませんでした(msys=$OLD_MSYS win=${OLD_WIN:-?})。" >&2
        echo "[run] 2本走ると同じアカウントを奪い合って接続できません。手で止めてから再実行してください。" >&2
        exit 1
      fi
    fi
  fi
fi
printf '%s %s\n' "$SELF_MSYS" "${SELF_WIN:-}" > "$PID_FILE"

# PIDファイルに載っていないループも始末する。
#
# ファイルは「最後に起動したもの」しか覚えていない。ファイルを消してから
# 死んだ回や、書く前に落ちた回のループは、どこにも記録が残らず生き残る。
# 実測 2026-09-12、PIDファイルには既に死んだ msys pid が入っていたため
# 停止処理が空振りし、記録の無いループ(win=29748)がそのまま走り続けて
# 同じアカウントを奪い合った。記録に頼らず、コマンドラインで数えて止める。
#
# 絞り込みは厳しくすること。`*run-bedrock.sh*` のような部分一致にすると、
# `bash -c "... run-bedrock.sh ..."` のように文字列を含むだけのシェル
# (ログを見ているだけの端末など)まで巻き込む。実際それで無関係のシェルを
# 5本落とした。末尾一致にし、`-c` 付きの呼び出しを除く。
#
# 自分の子(bash が外部コマンドを起動するために fork した複製)も除く。
# fork 直後の子は親と同じコマンドラインを持つので、この条件に素で当たる。
# 実測 2026-09-21、稼働中のループ win=55252 の下に同じコマンドラインの
# win=50720 が常駐しており、起動のたびに「記録に無い」として3本前後を
# 報告していた。実際には他人のループではなく自分の身内で、ログだけが
# 「取りこぼしが常にある」ように見えていた。
if command -v powershell >/dev/null 2>&1; then
  for other in $(powershell -NoProfile -Command \
    "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'bash.exe' -and \$_.CommandLine -like '*run-bedrock.sh' -and \$_.CommandLine -notlike '* -c *' -and \$_.ParentProcessId -ne ${SELF_WIN:-0} } | Select-Object -ExpandProperty ProcessId" \
    2>/dev/null | tr -d '\r'); do
    [ "$other" = "${SELF_WIN:-}" ] && continue
    echo "[run] 記録に無いrun-bedrock.sh(win=$other)を止める"
    # //T を付けない。理由は上の「前回のrun-bedrock.sh」と同じ。
    taskkill //F //PID "$other" >/dev/null 2>&1 || true
  done
fi

# 自分が書いたものだと分かるときだけ消す。
#
# 無条件に消すと、後から起動した方が書いたファイルを、先に終わった方が
# 消してしまう。すると次の起動は「前回は無かった」と判断し、実際には
# 走っているループを残したまま2本目を立てる。今回の二重起動はこれが原因。
trap 'if [ "$(awk "NR==1{print \$1}" "$PID_FILE" 2>/dev/null)" = "$SELF_MSYS" ]; then rm -f "$PID_FILE"; fi' EXIT

# 前の実行が残したtsx本体・サイドカーを始末してから始める。
#
# 親(tsx)を殺してもサイドカーは生き残る。実際に接続したまま残っていたのを
# 確認している。残ったまま繋ぎ直すと同じアカウントの奪い合いになり、
# duplicate_login で切れる。存在しないバグを追う羽目になるので先に消す。
#
# 消し方には順番がある。サイドカーを taskkill //F でいきなり落とすと、
# Realm に切断が届かないままプロセスだけが消える。サーバー側はしばらく
# 「まだ別デバイスで遊んでいる」と見なすので、直後の接続は必ず
# "Cannot join world ... different device" で弾かれる。実測 2026-09-21、
# 本日の起動30回すべてで最初の1回が弾かれ、30秒待って入り直していた。
# 1回あたり約70秒、合計35分がここで溶けていた。
#
# サイドカーは標準入力が閉じたら自分で片付ける(session.go readCommands の
# EOF → close → main.go の defer conn.Close())。親の node を先に落とせば
# パイプが閉じ、切断が正しく Realm に届く。そこで
#   1. node/tsx を //T 無しで止める     … サイドカーの stdin が閉じる
#   2. サイドカーが自分で消えるのを待つ … ここで切断が届く
#   3. 残ったときだけ //F で落とす      … 従来どおりの保険
# の順で進める。//T を使うと node とサイドカーが同時に死に、EOF を
# 渡す相手がいなくなるので付けない。
#
# `pnpm run start:bedrock` のコマンドラインは
# `node .../pnpm.cjs run start:bedrock` になるので "tsx --env-file=..." を
# 含まない。実測 2026-09-12、そうして残った2本が接続を握ったままで、
# 新しい接続が "different device" で弾かれ続けた。名前で取りこぼさないよう、
# コマンドラインで数えて始末する。
killed_bot=0
if command -v powershell >/dev/null 2>&1; then
  for stale in $(powershell -NoProfile -Command \
    "Get-CimInstance Win32_Process | Where-Object { \$_.Name -like 'node*' -and (\$_.CommandLine -like '*workflow/bedrock.ts*' -or \$_.CommandLine -like '*start:bedrock*') } | Select-Object -ExpandProperty ProcessId" \
    2>/dev/null | tr -d '\r'); do
    [ "$stale" = "${SELF_WIN:-}" ] && continue
    echo "[run] 残っていたボット(win=$stale)を止める"
    taskkill //F //PID "$stale" >/dev/null 2>&1 || true
    killed_bot=1
  done
fi
pkill -f "tsx --env-file=.env src/workflow/bedrock.ts" >/dev/null 2>&1 || true
pkill -f "start:bedrock" >/dev/null 2>&1 || true

# サイドカーが自分で切断して消えるのを待つ。
#
# 実測、行儀よく閉じれば数秒で消える。それを待たずに次へ進むと、
# 上で書いた "different device" に逆戻りする。
sidecar_pids() {
  if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command \
      "Get-CimInstance Win32_Process | Where-Object { \$_.Name -like 'onj-bedrock*' } | Select-Object -ExpandProperty ProcessId" \
      2>/dev/null | tr -d '\r'
  fi
}

if [ -n "$(sidecar_pids)" ]; then
  echo "[run] サイドカーが自分で切断するのを待つ"
  for _ in $(seq 1 20); do
    [ -z "$(sidecar_pids)" ] && break
    sleep 1
  done
fi

# それでも残るときだけ力ずくで落とす。
#
# この経路を通ったときは Realm 側に切断が届いていない。すぐ繋ぎ直しても
# 弾かれるだけなので、セッションが切れるまで待ってから入る。実測、
# 強制終了から入り直せたのは約40秒後だった。余裕を見て60秒置く。
if [ -n "$(sidecar_pids)" ]; then
  echo "[run] サイドカーが応じないので強制終了する" >&2
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //IM onj-bedrock.exe //F >/dev/null 2>&1 || true
  fi
  pkill -f "onj-bedrock" >/dev/null 2>&1 || true
  echo "[run] Realm 側のセッションが切れるまで60秒待つ" >&2
  sleep 60
elif [ "$killed_bot" = "1" ]; then
  # 行儀よく閉じた場合でも、サーバーが後始末を終えるまでに少し間がある。
  echo "[run] 切断の後始末に5秒置く"
  sleep 5
fi

REJOIN_WAIT="${REJOIN_INTERVAL_MS:-120000}"
REJOIN_SEC=$((REJOIN_WAIT / 1000))

while true; do
  npx tsx --env-file=.env src/workflow/bedrock.ts
  code=$?
  case "$code" in
    0)
      echo "[run] 正常終了"
      exit 0
      ;;
    3)
      echo "[run] 席を譲って抜けた。${REJOIN_SEC}秒後に様子を見に戻る"
      sleep "$REJOIN_SEC"
      ;;
    *)
      # 接続失敗やクラッシュ。少し置いて入り直す。
      echo "[run] 異常終了(code=$code)。30秒後に再接続"
      sleep 30
      ;;
  esac
done
