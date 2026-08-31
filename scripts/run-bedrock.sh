#!/bin/bash
# 統合版のエージェントを回し続ける。
#
# Realms は10人までなので、混んでいるとボットは自分から抜ける(終了コード3)。
# そのときは時間を置いて入り直す。人が減っていればそのまま居座れる。
#
# 実行:
#   REALM_INVITE=https://realms.gg/xxxx bash scripts/run-bedrock.sh
set -u

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
