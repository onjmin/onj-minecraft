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

# 前の実行が残したサイドカーを始末してから始める。
#
# 親(tsx)を殺してもサイドカーは生き残る。実際に接続したまま残っていたのを
# 確認している。残ったまま繋ぎ直すと同じアカウントの奪い合いになり、
# duplicate_login で切れる。存在しないバグを追う羽目になるので先に消す。
if command -v taskkill >/dev/null 2>&1; then
  taskkill //IM onj-bedrock.exe //F >/dev/null 2>&1 || true
fi
pkill -f "onj-bedrock" >/dev/null 2>&1 || true

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
