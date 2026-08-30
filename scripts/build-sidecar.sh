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

cat > /tmp/onj-sidecar-build.sh <<'INNER'
set -e
cd /w
mkdir -p bin
gofmt -l . | grep . && { echo "gofmt が必要なファイルがあります"; exit 1; }
go vet ./...
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
