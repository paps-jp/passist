'use strict';
// シグナリング + 中継 + ビューア配信サーバ。
// - セッションURL（トークン）を発行
// - ホスト/ビューア間で WebRTC の SDP/ICE を中継
// - アクセス制御: approve(ホスト承認) / pin / token のいずれか
// 状態はメモリ上のみ（永続化なし）。

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8443', 10);
const ACCESS_MODE = process.env.ACCESS_MODE || 'approve'; // 'approve' | 'pin' | 'token'
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // 例: https://xxxx.trycloudflare.com

// TLS（https/wss）: 証明書と鍵のパスを渡すと有効化。例: Tailscale の `tailscale cert` で取得した証明書。
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const useTls = !!(TLS_CERT && TLS_KEY);
const SCHEME = useTls ? 'https' : 'http';

/** token -> session */
const sessions = new Map();

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function sanitizeBase(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return u.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function baseUrl(override) {
  return sanitizeBase(override) || sanitizeBase(PUBLIC_BASE_URL) || `${SCHEME}://${lanIp()}:${PORT}`;
}

const newToken = () => crypto.randomBytes(16).toString('base64url');
const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// --- HTTP: ビューア(ブラウザ)配信。アカウント不要。 ---
const app = express();
// ビューアの資産はキャッシュさせない（CDN/ブラウザに古い viewer.js/css が残るのを防ぐ）
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
app.use(express.static(path.join(__dirname, 'public'), { etag: false, setHeaders: noCache }));
app.get('/s/:token', (_req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});
app.get('/', (_req, res) =>
  res.type('html').send('<h1>PAssist</h1><p>ホストアプリでウィンドウを選び、発行されたURLを共有してください。</p>'),
);

const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.role = null;
  ws.token = null;
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    route(ws, msg);
  });
  ws.on('close', () => onClose(ws));
});

function route(ws, msg) {
  switch (msg.type) {
    case 'host:create': return hostCreate(ws, msg);
    case 'viewer:join': return viewerJoin(ws, msg);
    case 'host:approve': return hostDecision(ws, true, msg);
    case 'host:deny': return hostDecision(ws, false, msg);
    case 'host:end': return hostEnd(ws);
    case 'signal': return relaySignal(ws, msg);
    default: return;
  }
}

function hostCreate(ws, msg) {
  const token = newToken();
  const s = {
    token,
    host: ws,
    viewer: null,
    pendingViewer: null,
    status: 'idle',
    base: baseUrl(msg && msg.publicBaseUrl),
    pin: ACCESS_MODE === 'pin' ? newPin() : null,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(token, s);
  ws.role = 'host';
  ws.token = token;
  send(ws, {
    type: 'session',
    token,
    viewerUrl: `${s.base}/s/${token}`,
    pin: s.pin,
    accessMode: ACCESS_MODE,
    expiresAt: s.expiresAt,
  });
  console.log(`[server] session created: ${token} (${ACCESS_MODE})`);
}

function viewerJoin(ws, msg) {
  const s = sessions.get(msg.token);
  if (!s) return send(ws, { type: 'error', code: 'invalid', message: 'セッションが見つかりません' });
  if (Date.now() > s.expiresAt) {
    sessions.delete(s.token);
    return send(ws, { type: 'error', code: 'expired', message: 'セッションの有効期限が切れています' });
  }
  if (s.viewer) return send(ws, { type: 'error', code: 'busy', message: '別の利用者が接続中です' });
  if (ACCESS_MODE === 'pin' && String(msg.pin || '') !== s.pin) {
    return send(ws, { type: 'error', code: 'pin', message: 'PINが違います' });
  }

  ws.role = 'viewer';
  ws.token = s.token;

  if (ACCESS_MODE === 'approve') {
    s.pendingViewer = ws;
    s.status = 'pending';
    send(ws, { type: 'waiting', message: 'ホストの承認を待っています…' });
    // ビューア提示の信頼クレデンシャル(auth)はそのままホストへ中継（サーバは保存・検証しない）
    send(s.host, { type: 'viewer:request', auth: msg.auth || null });
  } else {
    acceptViewer(s, ws);
  }
}

function hostDecision(ws, approve, msg) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws || !s.pendingViewer) return;
  const v = s.pendingViewer;
  s.pendingViewer = null;
  if (approve) {
    acceptViewer(s, v, msg && msg.issue);
  } else {
    send(v, { type: 'denied', message: 'ホストが接続を拒否しました' });
    v.close();
    s.status = 'idle';
  }
}

function acceptViewer(s, v, issue) {
  s.viewer = v;
  s.status = 'connected';
  // issue があれば、ホストが新規発行した信頼クレデンシャルをビューアへ渡す（localStorage 保存用）
  send(v, { type: 'accepted', issue: issue || null });
  send(s.host, { type: 'viewer:joined' }); // ホストがオファーを作成する合図
}

function relaySignal(ws, msg) {
  const s = sessions.get(ws.token);
  if (!s) return;
  const target = ws.role === 'host' ? s.viewer : s.host;
  send(target, { type: 'signal', data: msg.data });
}

function hostEnd(ws) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws) return;
  if (s.viewer) {
    send(s.viewer, { type: 'ended', message: 'ホストがセッションを終了しました' });
    s.viewer.close();
  }
  s.viewer = null;
  s.pendingViewer = null;
  s.status = 'idle';
}

function onClose(ws) {
  const s = ws.token && sessions.get(ws.token);
  if (!s) return;
  if (ws.role === 'host') {
    if (s.viewer) {
      send(s.viewer, { type: 'ended', message: 'ホストが切断しました' });
      s.viewer.close();
    }
    sessions.delete(s.token);
    console.log(`[server] session closed: ${s.token}`);
  } else if (ws.role === 'viewer') {
    if (s.viewer === ws) {
      s.viewer = null;
      s.status = 'idle';
      send(s.host, { type: 'viewer:left' });
    }
    if (s.pendingViewer === ws) {
      s.pendingViewer = null;
      s.status = 'idle';
    }
  }
}

// 期限切れセッションの掃除
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) {
      if (s.viewer) {
        send(s.viewer, { type: 'ended', message: '有効期限切れ' });
        s.viewer.close();
      }
      send(s.host, { type: 'expired' });
      sessions.delete(token);
      console.log(`[server] session expired: ${token}`);
    }
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on ${SCHEME}://0.0.0.0:${PORT}${useTls ? ' (TLS)' : ''}`);
  console.log(`[server] viewer base url: ${baseUrl()}`);
  console.log(`[server] access mode: ${ACCESS_MODE}, session TTL: ${Math.round(SESSION_TTL_MS / 1000)}s`);
});
