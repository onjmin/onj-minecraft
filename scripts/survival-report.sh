#!/bin/bash
# 生存の実績を期間で集計する。
#
# 「直したつもりが数字に出たか」を見るための道具。ログを読み返さずに、
# 死因の内訳と籠りの効き方を1枚にまとめる。
#
# 実行:
#   bash scripts/survival-report.sh 165                   # run-bedrock-165.out 以降
#   bash scripts/survival-report.sh "2026-09-21 12:02"    # その時刻以降
#   bash scripts/survival-report.sh                       # 既定は今日の00:00
#
# 改修の前後を比べるなら番号で切ること。時刻はファイルの更新時刻で選ぶので、
# 境界をまたいで書かれていたログが丸ごと入る(下の注記)。
#
#   bash scripts/survival-report.sh 131 164 > before.txt
#   bash scripts/survival-report.sh 165 > after.txt
set -u

SINCE="${1:-$(date +%Y-%m-%d) 00:00}"
LOG_DIR="$(cd "$(dirname "$0")/.." && pwd)/logs"

# 対象のログを集める。run-bedrock-*.out だけを見る(scenario は別物)。
#
# 番号で指定できるようにしてある。時刻(-newermt)はファイルの更新時刻で選ぶため、
# 境界をまたいで書かれていたログが丸ごと入る。実測 2026-09-21、"12:02 以降" の
# つもりで数えたら、11:51 に始まって 12:01 まで書かれていた run-bedrock-164.out
# が混ざり、修正前の蓋 34 回がそのまま乗った。改修の前後を比べるときは、
# 再起動の単位(ログ1本=ランチャ1回)で切る方が正しい。
if [[ "$SINCE" =~ ^[0-9]+$ ]]; then
  FROM_N="$SINCE"
  # 第2引数で上限も切れる。改修前だけを数えるときに要る。
  TO_N="${2:-999999}"
  FILES=$(for f in "$LOG_DIR"/run-bedrock-*.out; do
    n="${f##*run-bedrock-}"
    n="${n%.out}"
    [[ "$n" =~ ^[0-9]+$ ]] || continue
    [ "$n" -ge "$FROM_N" ] && [ "$n" -le "$TO_N" ] && echo "$f"
  done | sort -t- -k3 -n)
  if [ "$TO_N" = "999999" ]; then
    RANGE_LABEL="run-bedrock-${FROM_N}.out 以降"
  else
    RANGE_LABEL="run-bedrock-${FROM_N}.out 〜 ${TO_N}.out"
  fi
else
  FILES=$(find "$LOG_DIR" -name "run-bedrock-*.out" -newermt "$SINCE" | sort)
  RANGE_LABEL="$SINCE 以降(ファイルの更新時刻で選択)"
fi

if [ -z "$FILES" ]; then
  echo "$RANGE_LABEL に当たる run-bedrock ログがありません" >&2
  exit 1
fi

# metrics-*.json を絞るための下限(エポックミリ秒)。
#
# 番号指定のときは、最初に選ばれたログが「作られた」時刻を下限にする。更新時刻
# (%Y)では駄目で、走行中のログはそれが常に今になるため、metrics が全部落ちる。
# %W(birth)はこの環境では取れるが、0 を返す環境もあるのでそのときは %Y に落とす。
if [ -n "${FROM_N:-}" ]; then
  f0=$(echo "$FILES" | head -1)
  born=$(stat -c %W "$f0" 2>/dev/null || echo 0)
  [ "${born:-0}" -gt 0 ] || born=$(stat -c %Y "$f0")
  METRICS_SINCE_MS=$((born * 1000))
else
  METRICS_SINCE_MS=$(($(date -d "$SINCE" +%s) * 1000))
fi

# 何本ぶんか、いつからいつまでか。
first=$(echo "$FILES" | head -1)
last=$(echo "$FILES" | tail -1)
n_files=$(echo "$FILES" | wc -l | tr -d ' ')
t_start=$(grep -oE "^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]" "$first" 2>/dev/null | head -1 | tr -d '[]')
t_end=$(grep -oE "^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]" "$last" 2>/dev/null | tail -1 | tr -d '[]')

# 件数を数える。パターンは行単位。
count() { grep -hcE "$1" $FILES 2>/dev/null | awk '{s+=$1} END {print s+0}'; }

deaths=$(count "死亡しました")
dd=$(count "different device")
restarts=$(count "^\[run\] 異常終了")
meals=$(count "反射:eat")
caps=$(count "頭上に蓋を置いた")
cap_fail=$(count "蓋を置けなかった")
seals=$(count "横を .* マス塞いだ")
hits_in_shelter=$(count "籠っているのに削られた")
burrows=$(count "潜って身を隠す")

echo "=========================================="
echo " 生存レポート  $RANGE_LABEL"
echo "=========================================="
echo "対象ログ  : $n_files 本 ($(basename "$first") 〜 $(basename "$last"))"
echo "時刻の範囲: ${t_start:-?} 〜 ${t_end:-?}"
echo
echo "--- 死亡 ---"
echo "回数      : $deaths"
if [ "$deaths" -gt 0 ]; then
  echo "死因の内訳:"
  grep -h "死亡しました" $FILES \
    | sed 's/.*（\(.*\)）.*/\1/' \
    | sort | uniq -c | sort -rn \
    | awk '{printf "  %-34s %s\n", $2, $1}'
  echo
  echo "やられた相手(通知から):"
  grep -h "にやられた" $FILES \
    | sed 's/.*が %entity\.\(.*\)\.name にやられた.*/\1/' \
    | sort | uniq -c | sort -rn \
    | awk '{printf "  %-34s %s\n", $2, $1}'
fi
echo
echo "--- 籠り ---"
echo "潜った回数          : $burrows"
echo "蓋を置けた          : $caps"
echo "蓋を置けなかった    : $cap_fail"
echo "横を塞いだ          : $seals"
echo "籠っているのに被弾  : $hits_in_shelter"
echo
echo "--- 接続 ---"
echo "different device    : $dd"
echo "異常終了して再接続  : $restarts"
echo
echo "--- その他 ---"
echo "食事                : $meals"
echo
echo "--- 稼働と死亡率(各セッションの自己申告) ---"
# ここの死亡数は上の grep と一致しない。metrics-*.json はセッションが計測を
# 書き出したときだけ残るので、死んですぐ落ちた回や、書く前に切れた回が抜ける。
# 実数は上の grep、率はこちらを見る(母数の稼働時間がここにしか無いため)。
# metrics-*.json は1セッション1本。稼働の合計と死亡の合計から率を出す。
#
# 集計は別ファイルに置く。node -e に複数行を渡すと、この環境(Git Bash)では
# 何も出力しないまま終了コード0で返ることがあり、失敗に気づけない。
node "$(dirname "$0")/survival-metrics.js" "$LOG_DIR" "$METRICS_SINCE_MS"
