# --- Build Stage ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# pnpmのバージョンを package.json と一致させる
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml ./

# 開発依存(tsx等)も含めてインストール（CI/CDやビルド用）
RUN pnpm install --frozen-lockfile

# --- Runtime Stage ---
FROM node:24-bookworm-slim AS builder

# 実行時に必要な最小限のライブラリ（mineflayer-canvasやheadless対応）
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libgl1-mesa-dri \
    libgl1-mesa-dev \
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    iputils-ping \
    curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# builderからnode_modulesとpackage.jsonをコピー
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# 環境変数の設定
ENV NODE_ENV=production

# 8Bモデルの応答が遅い場合、Node.js自体のタイムアウトで死なないよう設定
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Xvfb（仮想ディスプレイ）をバックグラウンドで動かしつつ実行する
# これがないとボットの視覚（Canvas）周りでコケることがある
CMD ["sh", "-c", "Xvfb :99 -screen 0 1024x768x16 & export DISPLAY=:99 && npm start"]
