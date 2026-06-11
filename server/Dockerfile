# PAssist シグナリングサーバ。本番は外部の TURN/TLS（Caddy）と組み合わせて動かす。
FROM node:22-alpine
WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# アプリ本体
COPY . .

ENV NODE_ENV=production
ENV PORT=8443
EXPOSE 8443

USER node
CMD ["node", "server.js"]
