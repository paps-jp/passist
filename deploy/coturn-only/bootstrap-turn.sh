#!/usr/bin/env bash
# 新 TURN 専用 VPS の初期セットアップ。Ubuntu 24.04 想定。
# 使い方: sudo bash bootstrap-turn.sh
# 前提: deploy/coturn-only/.env を編集済（TURN_URL / THIS_TURN_AUTH_SECRET / EXTERNAL_IP）
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "root権限が必要です (sudo bash $0)"; exit 1; }
cd "$(dirname "$0")"
[ -f .env ] || { echo ".env が見つかりません。.env.example を参考に作成してください"; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# Docker + Compose
if ! command -v docker >/dev/null; then
  apt-get update -y >/dev/null
  apt-get install -y ca-certificates curl gnupg gettext-base ufw >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y >/dev/null
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi

# ファイアウォール（TURN関連のみ。HTTPS等は不要）
if command -v ufw >/dev/null; then
  ufw allow 22/tcp || true
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow 5349/tcp || true
  ufw allow 5349/udp || true
  ufw allow 49152:65535/udp || true
  yes | ufw enable || true
fi

# turnserver.conf を envsubst で展開
set -a; . ./.env; set +a
envsubst < turnserver.conf.template > turnserver.conf

docker compose up -d

echo ""
echo "==="
echo " TURN専用ノード起動完了。"
echo "   docker compose logs -f heartbeat   # 60秒ごとに signaling へ heartbeat 送信を確認"
echo "   docker compose logs -f coturn      # TURN稼働ログ"
echo " signaling 側で5分以内にローテーション参加します。"
echo "==="
