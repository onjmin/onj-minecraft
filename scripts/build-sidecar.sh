#!/bin/bash
# 統合版サイドカーをビルドする。
#
# ホストに Go を入れずに済ませるため Docker のツールチェーンを使う。
# 出力は sidecar/bedrock/bin/ に置き、TypeScript 側はそれを直接起動する。
# 純 Go(cgo なし)なので Windows 向けのクロスコンパイルがそのまま通る。
#
# 実行(WSL から):
#   bash scripts/build-sidecar.sh
set -e

PROJ=$(cd "$(dirname "$0")/.." && pwd)
SRC="$PROJ/sidecar/bedrock"

# ブロックの実行時IDは「ブロック状態NBTのハッシュ」なので、名前に戻すには
# 全ブロック状態の一覧が要る。dragonfly のものを使う。
# コミットを固定しているのは、更新でハッシュがずれると解析結果が静かに壊れるため。
DRAGONFLY_SHA=0c2c404540fc651873c24a020b0a48778bd56295
STATES="$SRC/data/block_states.nbt"
if [ ! -f "$STATES" ]; then
  echo "ブロック状態表を取得します..."
  mkdir -p "$SRC/data"
  curl -fsSL -o "$STATES"     "https://raw.githubusercontent.com/df-mc/dragonfly/$DRAGONFLY_SHA/server/world/block_states.nbt"
  echo "  $(wc -c < "$STATES") バイト"
fi

cat > /tmp/onj-sidecar-build.sh <<'INNER'
set -e
cd /w
mkdir -p bin
gofmt -l . | grep . && { echo "gofmt が必要なファイルがあります"; exit 1; }
go vet ./...
# 明るさの推定(light.go)のように、実サーバーに出さないと確かめにくいものは
# ここで押さえる。壊れても静かに間違った数を返すだけなので気づけない。
go test ./...
# Windows と Linux の両方を出す。開発機は Windows、検証は Docker のため。
GOOS=windows GOARCH=amd64 go build -o bin/onj-bedrock.exe .
GOOS=linux GOARCH=amd64 go build -o bin/onj-bedrock .
ls -la bin/
INNER

docker run --rm -i \
  -v "$SRC":/w \
  -v /tmp/onj-sidecar-build.sh:/build.sh:ro \
  -v gomodcache:/go/pkg/mod \
  -w /w golang:1.26 bash /build.sh
