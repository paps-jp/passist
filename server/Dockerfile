# PAssist シグナリングサーバ。本番は外部の TURN/TLS（Caddy）と組み合わせて動かす。
# Reproducible Build 対応: 同じソースから誰がビルドしても同じ image digest を得られる。
#   - npm ci で package-lock.json から厳格な依存ツリー再現
#   - SOURCE_DATE_EPOCH で全ファイル mtime を統一
# CI で生成した GIT_COMMIT / IMAGE_DIGEST / BUILD_TIMESTAMP を image に焼き込む（/api/build で公開）。
FROM node:22-alpine

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# アプリ本体
COPY . .

# === Reproducible Build: タイムスタンプを SOURCE_DATE_EPOCH に統一 ===
# 同じ commit から make すると mtime も同じ → docker image の digest が決定的になる。
# CI 不在のローカルビルドでは固定値 0 にフォールバック（決定性は保たれる）。
ARG SOURCE_DATE_EPOCH=0
RUN find /app -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

# === 透明性: ビルド情報を image に焼き込む（/api/build で公開） ===
# 利用者は公開された digest / cosign attestation と突き合わせて検証できる。
ARG GIT_COMMIT=""
ARG IMAGE_DIGEST=""
ARG BUILD_TIMESTAMP=""
ARG GIT_TAG=""
ENV GIT_COMMIT=${GIT_COMMIT}
ENV IMAGE_DIGEST=${IMAGE_DIGEST}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV GIT_TAG=${GIT_TAG}

ENV NODE_ENV=production
ENV PORT=8443
EXPOSE 8443

USER node
CMD ["node", "server.js"]
