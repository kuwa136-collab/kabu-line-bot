# ─────────────────────────────────────────────────────────────
# Stage 1: builder — TypeScript コンパイル
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# package.json だけ先にコピーしてキャッシュを活用
COPY package*.json tsconfig.json ./
RUN npm ci

# ソースコピー＆ビルド
COPY src    ./src
COPY config ./config
RUN npm run build

# ─────────────────────────────────────────────────────────────
# Stage 2: production — 本番イメージ（最小構成）
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# 非 root ユーザーを作成
RUN addgroup -g 1001 -S appgroup && \
    adduser  -u 1001 -S appuser -G appgroup

# 本番依存のみインストール
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ビルド成果物とコンフィグをコピー
COPY --from=builder /app/dist   ./dist
COPY --from=builder /app/config ./config

# ログ・キャッシュ用ディレクトリを作成
RUN mkdir -p logs tmp && \
    chown -R appuser:appgroup /app

USER appuser

# ヘルスチェック（HTTP サーバー :8080）
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/health | grep -q '"status":"ok"' || exit 1

EXPOSE 8080

CMD ["node", "dist/index.js"]
