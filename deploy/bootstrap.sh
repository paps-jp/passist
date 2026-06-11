#!/usr/bin/env bash
# PAssist VPS 初期セットアップ。Ubuntu 24.04 想定。
# 使い方:  sudo bash deploy/bootstrap.sh
# 機能: www ユーザー作成 / Docker導入 / UFW / .env と turnserver.conf 生成 / compose up -d
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "root権限が必要です (sudo bash $0)"; exit 1; }

WWW_USER=${WWW_USER:-www}
DOMAIN_SIGNALING=${DOMAIN_SIGNALING:-passist.paps.jp}
DOMAIN_TURN=${DOMAIN_TURN:-turn.paps.jp}
ACME_EMAIL=${ACME_EMAIL:-paps@paps.jp}
EXTERNAL_IP=${EXTERNAL_IP:-$(curl -s --max-time 5 ifconfig.me || true)}
REPO_URL=${REPO_URL:-https://github.com/paps-jp/passist.git}

echo "[bootstrap] WWW_USER=$WWW_USER  DOMAIN=$DOMAIN_SIGNALING  IP=$EXTERNAL_IP"

# 1) www ユーザー作成（鍵は呼び出し元 ubuntu からコピー）
if ! id -u "$WWW_USER" >/dev/null 2>&1; then
  echo "[bootstrap] creating user $WWW_USER"
  adduser --disabled-password --gecos '' "$WWW_USER"
  usermod -aG sudo "$WWW_USER"
  echo "$WWW_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$WWW_USER"
  chmod 440 "/etc/sudoers.d/90-$WWW_USER"
fi
mkdir -p "/home/$WWW_USER/.ssh"
# ubuntu の鍵を流用（同じ秘密鍵で www にも入れるように）
[ -f /home/ubuntu/.ssh/authorized_keys ] && cp /home/ubuntu/.ssh/authorized_keys "/home/$WWW_USER/.ssh/"
chown -R "$WWW_USER":"$WWW_USER" "/home/$WWW_USER/.ssh"
chmod 700 "/home/$WWW_USER/.ssh"
chmod 600 "/home/$WWW_USER/.ssh/authorized_keys" 2>/dev/null || true

# 2) Docker + Compose
if ! command -v docker >/dev/null; then
  echo "[bootstrap] installing docker"
  apt-get update
  apt-get install -y ca-certificates curl gnupg gettext-base git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$WWW_USER" || true

# 3) ファイアウォール
if ! command -v ufw >/dev/null; then apt-get install -y ufw; fi
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw allow 3478/tcp || true
ufw allow 3478/udp || true
ufw allow 5349/tcp || true
ufw allow 5349/udp || true
ufw allow 49152:65535/udp || true
yes | ufw enable || true

# 4) リポジトリ
APP_DIR="/home/$WWW_USER/passist"
if [ ! -d "$APP_DIR" ]; then
  sudo -u "$WWW_USER" git clone "$REPO_URL" "$APP_DIR"
else
  sudo -u "$WWW_USER" git -C "$APP_DIR" pull --ff-only
fi

# 5) .env と turnserver.conf 生成
DEPLOY="$APP_DIR/deploy"
cd "$DEPLOY"
if [ ! -f .env ]; then
  echo "[bootstrap] generating .env"
  TURN_PASSWORD=$(openssl rand -hex 16)
  # マスタ secret（signaling のみ保持・全 TURN の credential を生成可能）
  TURN_AUTH_SECRET=$(openssl rand -hex 32)
  # この VPS の coturn 用の派生鍵 = HMAC-SHA256(master, turn:DOMAIN_TURN:3478)
  THIS_TURN_URL=turn:$DOMAIN_TURN:3478
  THIS_TURN_AUTH_SECRET=$(printf '%s' "$THIS_TURN_URL" | openssl dgst -sha256 -hmac "$TURN_AUTH_SECRET" -hex | awk '{print $NF}')
  cat > .env <<EOF
DOMAIN_SIGNALING=$DOMAIN_SIGNALING
DOMAIN_TURN=$DOMAIN_TURN
PUBLIC_BASE_URL=https://$DOMAIN_SIGNALING
ACME_EMAIL=$ACME_EMAIL
EXTERNAL_IP=$EXTERNAL_IP
ACCESS_MODE=approve
SESSION_TTL_MS=1800000
SIGNALING_VERSION=v0.2.8
RELAY_BUDGET_BPS=4000000
RELAY_MIN_BPS=100000
RELAY_MAX_BPS=1500000
REALM=paps.jp
TURN_PASSWORD=$TURN_PASSWORD
TURN_AUTH_SECRET=$TURN_AUTH_SECRET
THIS_TURN_AUTH_SECRET=$THIS_TURN_AUTH_SECRET
SIGN_TURN_URLS=$THIS_TURN_URL
EOF
  chown "$WWW_USER":"$WWW_USER" .env
  chmod 600 .env
  echo "[bootstrap] TURN_PASSWORD generated (see .env)"
else
  echo "[bootstrap] .env already exists, keeping"
fi

# turnserver.conf を展開（再生成は手で消してから）
if [ ! -f turnserver.conf ]; then
  set -a; . ./.env; set +a
  envsubst < turnserver.conf.template > turnserver.conf
  chown "$WWW_USER":"$WWW_USER" turnserver.conf
fi

# 6) 起動
echo "[bootstrap] docker compose up -d"
sudo -u "$WWW_USER" -- bash -c "cd '$DEPLOY' && docker compose up -d --build"

echo ""
echo "==="
echo " 完了。動作確認:"
echo "   sudo -u $WWW_USER docker compose -f $DEPLOY/docker-compose.yml ps"
echo "   sudo -u $WWW_USER docker compose -f $DEPLOY/docker-compose.yml logs -f"
echo "   curl -sI https://$DOMAIN_SIGNALING"
echo ""
echo " TURN認証情報は $DEPLOY/.env を参照（TURN_PASSWORD）"
echo "==="
