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
const stats = require('./stats'); // 匿名集計（個人情報は記録しない）。snapshot は /api/stats で公開

const PORT = parseInt(process.env.PORT || '8443', 10);
const ACCESS_MODE = process.env.ACCESS_MODE || 'approve'; // 'approve' | 'pin' | 'token'
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // 例: https://xxxx.trycloudflare.com

// viewer に自動配布する TURN サーバ。REST API ephemeral credential 方式。
// - SIGN_TURN_URLS: 候補 URL のカンマ区切り。接続ごとにラウンドロビン選択
// - TURN_AUTH_SECRET: signaling だけが持つマスタ。各 TURN URL の派生鍵を HMAC-SHA256 で導出
// - 各 TURN VPS は対応する派生鍵だけを保持する（マスタは渡さない）
//   → マスタ漏洩=全TURN危険、派生鍵漏洩=その1台のみ
// - 配布する credential は username=`${expiry}:${user}` / password=HMAC-SHA1(派生鍵, username)
//   24時間で expire。漏洩しても短時間で無効化
const SIGN_TURN_URLS = (process.env.SIGN_TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_AUTH_SECRET = process.env.TURN_AUTH_SECRET || '';
const SIGN_TURN_USERNAME = process.env.SIGN_TURN_USERNAME || 'passist';
const SIGN_TURN_TTL_SEC = parseInt(process.env.SIGN_TURN_TTL_SEC || String(24 * 3600), 10);
// 各 TURN の既定帯域上限。POST /admin/turn-register で budgetBps を明示すれば上書きされる。
const TURN_DEFAULT_BUDGET_BPS = parseInt(process.env.TURN_DEFAULT_BUDGET_BPS || String(4 * 1000 * 1000), 10);
// heartbeat 仕様。動的登録した TURN は HEARTBEAT_TTL_MS 来ないと自動除外。
const HEARTBEAT_TTL_MS = parseInt(process.env.HEARTBEAT_TTL_MS || String(5 * 60 * 1000), 10);
let turnRrIndex = 0;

// 動的 TURN レジストリ: url -> { lastSeen, budgetBps }
// signaling 起動時は SIGN_TURN_URLS のみ。新 TURN VPS が /admin/turn-register に
// 派生鍵を proof として POST してくると追加される（heartbeat 60s, TTL 5min）。
const dynamicTurns = new Map();

// URL→派生鍵 のキャッシュ（マスタ から HMAC で都度計算するのは無駄なので）
const derivedKeyCache = new Map();
function deriveSecretFor(url) {
  if (!TURN_AUTH_SECRET) return '';
  let k = derivedKeyCache.get(url);
  if (!k) {
    k = crypto.createHmac('sha256', TURN_AUTH_SECRET).update(url).digest('hex');
    derivedKeyCache.set(url, k);
  }
  return k;
}

// 静的（環境変数）＋動的（heartbeat）で有効な TURN URL のリスト。TTL切れは除外。
function activeTurnUrls() {
  const now = Date.now();
  for (const [url, info] of dynamicTurns) {
    if (now - info.lastSeen > HEARTBEAT_TTL_MS) dynamicTurns.delete(url);
  }
  // 静的を先頭、動的を後ろに（重複は片方のみ）
  const out = [...SIGN_TURN_URLS];
  for (const url of dynamicTurns.keys()) if (!out.includes(url)) out.push(url);
  return out;
}

function turnForViewer() {
  if (!TURN_AUTH_SECRET) return null;
  const urls = activeTurnUrls();
  if (!urls.length) return null;
  const url = urls[turnRrIndex++ % urls.length]; // ラウンドロビン
  const derived = deriveSecretFor(url);
  const expiry = Math.floor(Date.now() / 1000) + SIGN_TURN_TTL_SEC;
  const username = `${expiry}:${SIGN_TURN_USERNAME}`;
  const credential = crypto.createHmac('sha1', derived).update(username).digest('base64');
  return { urls: url, username, credential };
}

// ホスト Electron へ自動配布する WebRTC iceServers。
// 環境変数を設定すれば、ユーザーが手動入力しなくても TURN が使われる。
// 未設定なら STUN(Google) のみ＝従来通り。
const ICE_STUN_URL = process.env.ICE_STUN_URL || 'stun:stun.l.google.com:19302';
const ICE_TURN_URL = process.env.ICE_TURN_URL || '';
const ICE_TURN_USER = process.env.ICE_TURN_USER || '';
const ICE_TURN_PASS = process.env.ICE_TURN_PASS || '';
function buildServerIceServers() {
  const list = [];
  if (ICE_STUN_URL) list.push({ urls: ICE_STUN_URL });
  if (ICE_TURN_URL && ICE_TURN_USER && ICE_TURN_PASS) {
    list.push({ urls: ICE_TURN_URL, username: ICE_TURN_USER, credential: ICE_TURN_PASS });
  }
  return list;
}

// TLS（https/wss）: 証明書と鍵のパスを渡すと有効化。例: Tailscale の `tailscale cert` で取得した証明書。
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const useTls = !!(TLS_CERT && TLS_KEY);
const SCHEME = useTls ? 'https' : 'http';

/** token -> session */
const sessions = new Map();
let viewerSeq = 0; // ビューアの一意ID採番（複数同時接続のルーティング用）
const clampMaxViewers = (n) => { const v = parseInt(n, 10); return Number.isFinite(v) ? Math.min(8, Math.max(1, v)) : 1; };

// --- TURN(relay) 経由ピアの動的 bitrate ガバナ ---
// サーバ OUT 帯域 cap（例: さくらVPSはOUT 10Mbps制限、安全側で 4Mbps を分配上限）。
// メディアは P2P 直接なら VPS は通らないので、TURN(relay) 経由のピアにのみ適用する。
const RELAY_BUDGET_BPS = parseInt(process.env.RELAY_BUDGET_BPS || String(4 * 1000 * 1000), 10);
const RELAY_MIN_BPS = parseInt(process.env.RELAY_MIN_BPS || String(100 * 1000), 10);   // 下限：監視レベル
const RELAY_MAX_BPS = parseInt(process.env.RELAY_MAX_BPS || String(1500 * 1000), 10);  // 上限：単独ピアでも盛りすぎない
// session.relayViewers = Set<viewerId>。peer-route(via:'relay') 受信で更新。
function relayCount() {
  let n = 0; for (const s of sessions.values()) if (s.relayViewers) n += s.relayViewers.size; return n;
}
// 全 TURN の総帯域。静的TURN は RELAY_BUDGET_BPS をシェアし、動的TURN は登録時の budgetBps を加算。
// 動的 TURN が増えれば総帯域が増え、1接続あたりの上限も自動的に拡大する。
function totalBudgetBps() {
  let total = SIGN_TURN_URLS.length ? RELAY_BUDGET_BPS : 0;
  const now = Date.now();
  for (const [url, info] of dynamicTurns) {
    if (now - info.lastSeen <= HEARTBEAT_TTL_MS) total += info.budgetBps;
  }
  return total || RELAY_BUDGET_BPS; // フォールバック：静的1台分
}
function calcRelayBitrate() {
  const n = relayCount();
  if (n === 0) return RELAY_MAX_BPS; // 0人なら上限値（実害なし）
  const v = Math.floor(totalBudgetBps() / n);
  return Math.max(RELAY_MIN_BPS, Math.min(RELAY_MAX_BPS, v));
}
let lastPolicy = { maxBpsRelay: 0, relayCount: -1 };
function broadcastBitratePolicy() {
  const policy = { maxBpsRelay: calcRelayBitrate(), relayCount: relayCount() };
  if (policy.maxBpsRelay === lastPolicy.maxBpsRelay && policy.relayCount === lastPolicy.relayCount) return; // 変化なし
  lastPolicy = policy;
  for (const s of sessions.values()) send(s.host, { type: 'bitrate-policy', ...policy });
}

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

// ユーザー向けトップと統計画面は GitHub Pages を正とする。301 で恒久リダイレクト。
// /api/stats（データ取得）と /s/:token（viewer）は機能上ここでしか提供できないので残す。
const PAGES_BASE = 'https://paps-jp.github.io/passist';
app.get('/', (_req, res) => res.redirect(301, PAGES_BASE + '/'));
app.get('/stats', (_req, res) => res.redirect(301, PAGES_BASE + '/stats.html'));

// 公開統計 API（個人情報なし。リアルタイム値と24h/日次サマリのみ）。
app.get('/api/stats', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*'); // 外部サイトからの埋め込みも許容
  res.json(stats.snapshot());
});

app.get('/s/:token', (_req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// 動的 TURN 登録 API。新 TURN サーバが起動時/60秒ごとに heartbeat として POST する。
// 検証: HMAC-SHA256(MASTER, url) === secret か（=正しい派生鍵を持っているか）。
// マスタは signaling だけが知るので、正規 TURN VPS（派生鍵を渡された者）しか登録できない。
app.post('/admin/turn-register', express.json({ limit: '1kb' }), (req, res) => {
  if (!TURN_AUTH_SECRET) return res.status(503).json({ error: 'master secret not configured' });
  const { url, secret, budgetBps } = req.body || {};
  if (typeof url !== 'string' || typeof secret !== 'string') return res.status(400).json({ error: 'url and secret required' });
  const expected = crypto.createHmac('sha256', TURN_AUTH_SECRET).update(url).digest('hex');
  // タイミング攻撃対策: 文字列長を揃えて timingSafeEqual
  let ok = false;
  try { ok = expected.length === secret.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(secret)); } catch {}
  if (!ok) return res.status(401).json({ error: 'invalid secret' });
  const budget = Number.isFinite(budgetBps) && budgetBps > 0
    ? Math.max(100_000, Math.min(100_000_000, budgetBps | 0))
    : TURN_DEFAULT_BUDGET_BPS;
  const existing = dynamicTurns.get(url);
  dynamicTurns.set(url, { lastSeen: Date.now(), budgetBps: budget });
  if (!existing) {
    console.log(`[server] TURN registered: ${url} (budget=${budget})`);
    broadcastBitratePolicy(); // 新TURN加入で総帯域が増えた → 配分再計算
  }
  res.json({ ok: true, heartbeatSec: 60, ttlSec: Math.round(HEARTBEAT_TTL_MS / 1000) });
});

// 動的 TURN の TTL 監視。5分heartbeat来なかったらレジストリから除外し、配分を再計算。
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [url, info] of dynamicTurns) {
    if (now - info.lastSeen > HEARTBEAT_TTL_MS) {
      dynamicTurns.delete(url);
      removed++;
      console.log(`[server] TURN expired (no heartbeat): ${url}`);
    }
  }
  if (removed) broadcastBitratePolicy();
}, 60 * 1000);

// viewer の資産配信。index 自動配信は無効（"/" は上のリダイレクトで処理）。
app.use(express.static(path.join(__dirname, 'public'), { etag: false, setHeaders: noCache, index: false }));

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
    case 'peer-route': return peerRoute(ws, msg); // host が viewer の経路(relay/p2p)を通知
    default: return;
  }
}

function hostCreate(ws, msg) {
  const token = newToken();
  // 接続方法はセッションごと（host:create で指定）。未指定/不正なら環境変数の既定。
  const accessMode = ['approve', 'pin', 'token'].includes(msg && msg.accessMode) ? msg.accessMode : ACCESS_MODE;
  // 有効期限（分）。host:create の ttlMinutes 優先、未指定なら環境変数の既定。0 は「無期限」(expiresAt=null)。
  const ttlMin = msg && Number.isFinite(msg.ttlMinutes) ? msg.ttlMinutes : SESSION_TTL_MS > 0 ? SESSION_TTL_MS / 60000 : 0;
  const expiresAt = ttlMin > 0 ? Date.now() + ttlMin * 60000 : null;
  const s = {
    token,
    host: ws,
    viewers: new Map(), // viewerId -> ws（接続中。複数同時接続可）
    pending: new Map(), // viewerId -> ws（approve 承認待ち）
    maxViewers: clampMaxViewers(msg && msg.maxViewers),
    accessMode, // 'approve'(承認制) | 'pin' | 'token'(だれでも)
    status: 'idle',
    relayViewers: new Set(), // TURN(relay)経由と判定されたviewerIdの集合（動的bitrate配分のため）
    base: baseUrl(msg && msg.publicBaseUrl),
    pin: accessMode === 'pin' ? newPin() : null,
    createdAt: Date.now(),
    expiresAt, // null = 無期限
  };
  sessions.set(token, s);
  ws.role = 'host';
  ws.token = token;
  send(ws, {
    type: 'session',
    token,
    viewerUrl: `${s.base}/s/${token}`,
    pin: s.pin,
    accessMode: s.accessMode,
    expiresAt: s.expiresAt,
    iceServers: buildServerIceServers(), // ホストはこれを優先採用＝手動設定不要でTURN自動
  });
  // 動的 bitrate ガバナの初期値を共有（TURN経由が0人なら上限値）
  send(ws, { type: 'bitrate-policy', maxBpsRelay: calcRelayBitrate(), relayCount: relayCount() });
  stats.event('session_created', { accessMode });
  console.log(`[server] session created: ${token} (${ACCESS_MODE})`);
}

function viewerJoin(ws, msg) {
  const s = sessions.get(msg.token);
  if (!s) return send(ws, { type: 'error', code: 'invalid', message: 'セッションが見つかりません' });
  if (s.expiresAt && Date.now() > s.expiresAt) {
    sessions.delete(s.token);
    return send(ws, { type: 'error', code: 'expired', message: 'セッションの有効期限が切れています' });
  }
  if (s.viewers.size + s.pending.size >= s.maxViewers) {
    stats.event('viewer_denied', { reason: 'busy' });
    return send(ws, { type: 'error', code: 'busy', message: '接続できる人数の上限に達しています' });
  }
  if (s.accessMode === 'pin' && String(msg.pin || '') !== s.pin) {
    stats.event('viewer_denied', { reason: 'pin' });
    return send(ws, { type: 'error', code: 'pin', message: 'PINが違います' });
  }

  ws.role = 'viewer';
  ws.token = s.token;
  ws.viewerId = String(++viewerSeq);

  if (s.accessMode === 'approve') {
    s.pending.set(ws.viewerId, ws);
    s.status = 'pending';
    send(ws, { type: 'waiting', message: 'ホストの承認を待っています…' });
    // ビューア提示の信頼クレデンシャル(auth)はそのままホストへ中継（サーバは保存・検証しない）
    send(s.host, { type: 'viewer:request', viewerId: ws.viewerId, auth: msg.auth || null });
  } else {
    acceptViewer(s, ws);
  }
}

function hostDecision(ws, approve, msg) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws) return;
  const viewerId = msg && msg.viewerId;
  const v = viewerId != null ? s.pending.get(viewerId) : null;
  if (!v) return;
  s.pending.delete(viewerId);
  if (approve) {
    acceptViewer(s, v, msg && msg.issue);
  } else {
    stats.event('viewer_denied', { reason: 'host_deny' });
    send(v, { type: 'denied', message: 'ホストが接続を拒否しました' });
    v.close();
    if (!s.viewers.size && !s.pending.size) s.status = 'idle';
  }
}

function acceptViewer(s, v, issue) {
  s.viewers.set(v.viewerId, v);
  s.status = 'connected';
  // issue があれば、ホストが新規発行した信頼クレデンシャルをビューアへ渡す（localStorage 保存用）
  // turn があれば viewer は STUN だけでなく TURN にも relay candidate を提示できる（NAT越え強化）
  send(v, { type: 'accepted', issue: issue || null, turn: turnForViewer() });
  send(s.host, { type: 'viewer:joined', viewerId: v.viewerId }); // 当該ビューア向けにホストがオファー作成
  stats.event('viewer_accepted', { accessMode: s.accessMode });
}

function peerRoute(ws, msg) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws) return; // ホストからのみ受け付け
  const vid = msg && msg.viewerId; if (vid == null) return;
  const wasRelay = s.relayViewers.has(vid);
  if (msg.via === 'relay') s.relayViewers.add(vid);
  else s.relayViewers.delete(vid); // p2p 等は外す
  if (wasRelay !== s.relayViewers.has(vid)) broadcastBitratePolicy();
  stats.event('peer_route', { via: msg.via, prev: wasRelay ? 'relay' : 'p2p' });
}

function relaySignal(ws, msg) {
  const s = sessions.get(ws.token);
  if (!s) return;
  if (ws.role === 'host') {
    send(s.viewers.get(msg && msg.to), { type: 'signal', data: msg.data }); // ホストは宛先ビューアを指定
  } else if (ws.role === 'viewer') {
    send(s.host, { type: 'signal', from: ws.viewerId, data: msg.data }); // 送信元ビューアIDを付与
  }
}

function hostEnd(ws) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws) return;
  for (const v of [...s.viewers.values(), ...s.pending.values()]) {
    send(v, { type: 'ended', message: 'ホストがセッションを終了しました' });
    v.close();
  }
  s.viewers.clear();
  s.pending.clear();
  s.relayViewers.clear();
  s.status = 'idle';
  broadcastBitratePolicy();
}

function onClose(ws) {
  const s = ws.token && sessions.get(ws.token);
  if (!s) return;
  if (ws.role === 'host') {
    for (const v of [...s.viewers.values(), ...s.pending.values()]) {
      send(v, { type: 'ended', message: 'ホストが切断しました' });
      v.close();
    }
    sessions.delete(s.token);
    console.log(`[server] session closed: ${s.token}`);
    broadcastBitratePolicy();
    stats.event('session_closed', { durationSec: Math.floor((Date.now() - s.createdAt) / 1000) });
  } else if (ws.role === 'viewer') {
    const wasViewer = ws.viewerId != null && s.viewers.has(ws.viewerId);
    if (wasViewer) {
      s.viewers.delete(ws.viewerId);
      send(s.host, { type: 'viewer:left', viewerId: ws.viewerId });
    }
    if (ws.viewerId != null) s.pending.delete(ws.viewerId);
    if (ws.viewerId != null && s.relayViewers.delete(ws.viewerId)) broadcastBitratePolicy();
    if (wasViewer) stats.event('viewer_left');
    if (!s.viewers.size && !s.pending.size) s.status = 'idle';
  }
}

// 期限切れセッションの掃除
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt && now > s.expiresAt) {
      for (const v of [...s.viewers.values(), ...s.pending.values()]) {
        send(v, { type: 'ended', message: '有効期限切れ' });
        v.close();
      }
      send(s.host, { type: 'expired' });
      sessions.delete(token);
      stats.event('session_expired', { durationSec: Math.floor((Date.now() - s.createdAt) / 1000) });
      console.log(`[server] session expired: ${token}`);
    }
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on ${SCHEME}://0.0.0.0:${PORT}${useTls ? ' (TLS)' : ''}`);
  console.log(`[server] viewer base url: ${baseUrl()}`);
  console.log(`[server] access mode: ${ACCESS_MODE}, session TTL: ${Math.round(SESSION_TTL_MS / 1000)}s`);
});
