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
const audit = require('./audit'); // 監査ログ（IP/UA等を記録、非公開）。プロバイダ責任制限法・情プラ法対応
const { sanitizeBase, clampMaxViewers, calcBitrate } = require('./util'); // 純粋関数（test-util.js でテスト）

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
// clampMaxViewers / sanitizeBase / calcBitrate は util.js から取り込み（テスト容易化のため切り出し）

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
  return calcBitrate(relayCount(), totalBudgetBps(), RELAY_MIN_BPS, RELAY_MAX_BPS);
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

function baseUrl(override) {
  return sanitizeBase(override) || sanitizeBase(PUBLIC_BASE_URL) || `${SCHEME}://${lanIp()}:${PORT}`;
}

const newToken = () => crypto.randomBytes(16).toString('base64url');
const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const newSecret = () => crypto.randomBytes(16).toString('base64url'); // ホスト引き継ぎ認証用（ホスト以外には絶対に送らない）

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// ホスト再接続時に「待機していた viewer」全員に host:back を通知 → viewer は再join する。
// 既に WS が閉じている viewer は飛ばす。
function notifyKeptViewers(s) {
  if (!s.keptViewers || !s.keptViewers.size) return;
  let alive = 0;
  for (const [, v] of s.keptViewers) {
    if (v && v.readyState === v.OPEN) {
      send(v, { type: 'host:back', message: 'ホストが戻りました。再接続します…' });
      alive++;
    }
  }
  console.log(`[server] notified ${alive} kept viewers about host:back`);
  // 通知した viewer は再 join してくる想定。s.viewers/pending に入り直すまでは keptViewers に残しておく
  // → viewer:join を受けたら remove。close で消えた WS は次の onClose 経路で remove される。
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

// 透明性 API: 動作中サーバの自己申告（commit / image digest / build時刻）。
// ★ これ自体は嘘がつける（運営者がコード改ざんすれば偽値を返せる）。
// 真の保証は GHCR の image digest を cosign で検証すること。次のように：
//   cosign verify ghcr.io/paps-jp/passist-signaling@<digest> \
//     --certificate-identity-regexp 'https://github.com/paps-jp/passist' \
//     --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
// /api/build はサーバ運営者がオープンに自己申告するためのもので、cosign 検証の入口として使う。
const BUILD_INFO = Object.freeze({
  commit: process.env.GIT_COMMIT || '',
  imageDigest: process.env.IMAGE_DIGEST || '',
  builtAt: process.env.BUILD_TIMESTAMP || '',
  tag: process.env.GIT_TAG || '',
  sourceUrl: 'https://github.com/paps-jp/passist',
  registry: 'ghcr.io/paps-jp/passist-signaling',
  // ブラウザ単独 verify の入口。 sigverify.js が /api/cosign/bundle から bundle を取得し、
  // 自前で SHA-256 Merkle inclusion proof を verify する（@sigstore/verify を使わない軽量実装）
  bundleUrl: process.env.GIT_TAG ? `/api/cosign/bundle?tag=${encodeURIComponent(process.env.GIT_TAG)}` : '',
  signatureUrl: process.env.GIT_TAG ? `/api/cosign/signature?tag=${encodeURIComponent(process.env.GIT_TAG)}` : '',
  certificateIdentityRegexp: 'https://github.com/paps-jp/passist',
  certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
  cosignVerifyHint:
    "cosign verify <image> --certificate-identity-regexp 'https://github.com/paps-jp/passist' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'",
});
app.get('/api/build', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(BUILD_INFO);
});

// /api/cosign/bundle: GitHub Release から Sigstore Bundle を中継する（GHCR は CORS 不可なため）。
// ブラウザは sigverify.js でこの bundle を完全に自前検証する:
//   - canonicalizedBody → SHA-256 leaf hash (RFC 6962)
//   - inclusionProof.hashes を順次SHA-256で辿って root hash 算出
//   - 算出した root が bundle 内の rootHash と一致すれば「Rekor 公開ログに登録済」を確認
//   - body の payload (hashedrekord) から image digest を取り出し /api/build と照合
//   - 改ざんがあれば SHA-256 衝突困難性により破綻 → 数学的に安全
const BUNDLE_CACHE_TTL_MS = 60 * 60 * 1000;
const bundleCache = new Map();
app.get('/api/cosign/bundle', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const tag = typeof req.query.tag === 'string' && /^v[0-9.]+$/.test(req.query.tag) ? req.query.tag : null;
  if (!tag) return res.status(400).json({ error: 'tag query parameter required (e.g. ?tag=v0.2.3)' });
  const now = Date.now();
  const cached = bundleCache.get(tag);
  if (cached && now - cached.fetchedAt < BUNDLE_CACHE_TTL_MS) {
    return res.type(cached.contentType).send(cached.payload);
  }
  try {
    // GitHub Release asset 名: signaling-<tag>.rekor-entry.json （workflowが Rekor API から取得して保存）
    const url = `https://github.com/paps-jp/passist/releases/download/${encodeURIComponent(tag)}/signaling-${encodeURIComponent(tag)}.rekor-entry.json`;
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(r.status).json({ error: 'bundle fetch failed', status: r.status });
    const text = await r.text();
    bundleCache.set(tag, { fetchedAt: now, payload: text, contentType: 'application/json' });
    res.type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream error', message: e.message });
  }
});

// /api/cosign/signature: cosign download signature の出力 (Payload + Cert) を中継。
// ブラウザは Payload (base64) を decode して中の docker-manifest-digest を確認する。
const signatureCache = new Map();
app.get('/api/cosign/signature', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const tag = typeof req.query.tag === 'string' && /^v[0-9.]+$/.test(req.query.tag) ? req.query.tag : null;
  if (!tag) return res.status(400).json({ error: 'tag query parameter required' });
  const now = Date.now();
  const cached = signatureCache.get(tag);
  if (cached && now - cached.fetchedAt < BUNDLE_CACHE_TTL_MS) {
    return res.type(cached.contentType).send(cached.payload);
  }
  try {
    const url = `https://github.com/paps-jp/passist/releases/download/${encodeURIComponent(tag)}/signaling-${encodeURIComponent(tag)}.signature.json`;
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(r.status).json({ error: 'signature fetch failed', status: r.status });
    const text = await r.text();
    signatureCache.set(tag, { fetchedAt: now, payload: text, contentType: 'application/json' });
    res.type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream error', message: e.message });
  }
});

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

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.token = null;
  // heartbeat: 死んだ接続（ブラウザを閉じても TCP RST が来ない・モバイル画面ロック等）を
  // ping/pong で検出し、 viewer slot を確実に解放するための前提フラグ。
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 監査ログ用: 接続元 IP / User-Agent を ws に保存（X-Forwarded-For 経由対応）。
  // ※ stats（公開集計）には載せない。/api/stats は匿名のまま。
  ws.auditIp = audit.extractIp(req);
  ws.auditUa = audit.extractUserAgent(req);
  audit.log({ type: 'ws_connect', ip: ws.auditIp, ua: ws.auditUa });
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

// WebSocket heartbeat: 30秒ごとに ping を送り、 次の周期までに pong が返らない接続を
// terminate する。 terminate すると ws.on('close') 経由で onClose() が呼ばれて
// s.viewers / s.pending から viewerId が外れ、 maxViewers 枠が解放される。
// → 「4人占有のまま誰かがブラウザを閉じても新規接続が拒否される」 問題への対策。
const WS_HEARTBEAT_MS = parseInt(process.env.WS_HEARTBEAT_MS || '30000', 10);
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, WS_HEARTBEAT_MS);
if (wsHeartbeat.unref) wsHeartbeat.unref(); // テスト/CLI 終了をブロックしないように
wss.on('close', () => clearInterval(wsHeartbeat));

function route(ws, msg) {
  switch (msg.type) {
    case 'host:create': return hostCreate(ws, msg);
    case 'viewer:join': return viewerJoin(ws, msg);
    case 'host:approve': return hostDecision(ws, true, msg);
    case 'host:deny': return hostDecision(ws, false, msg);
    case 'host:end': return hostEnd(ws);
    case 'host:kick': return hostKick(ws, msg); // ホストが個別の viewer を切断
    case 'signal': return relaySignal(ws, msg);
    case 'peer-route': return peerRoute(ws, msg); // host が viewer の経路(relay/p2p)を通知
    default: return;
  }
}

function hostCreate(ws, msg) {
  // セッション引き継ぎ: existingToken + hostSecret が一致する既存セッションがあれば host(ws)を張り替え、
  // セッションが消えていれば（サーバ再起動など）同じ token で復元する。secret 不一致や情報不足なら新規発行。
  // → アプリ再起動・サーバ再起動・自動再接続後も同じ URL を使い続けられる。
  const existingToken = msg && typeof msg.existingToken === 'string' ? msg.existingToken : '';
  const hostSecret    = msg && typeof msg.hostSecret    === 'string' ? msg.hostSecret    : '';
  if (existingToken && hostSecret) {
    const old = sessions.get(existingToken);
    if (old) {
      if (old.hostSecret === hostSecret) {
        // 既存セッションのホスト ws を新しい接続に張り替え（既存 viewer/pending はそのまま）
        const prevHost = old.host;
        if (prevHost && prevHost !== ws && prevHost.readyState === prevHost.OPEN) {
          try { prevHost.onclose = null; prevHost.close(); } catch {}
        }
        old.host = ws;
        ws.role = 'host';
        ws.token = existingToken;
        send(ws, {
          type: 'session', token: existingToken,
          viewerUrl: `${old.base}/s/${existingToken}`,
          pin: old.pin, accessMode: old.accessMode, expiresAt: old.expiresAt,
          hostSecret: old.hostSecret, // 同じ値を返す
          iceServers: buildServerIceServers(),
          resumed: true, // ホスト側で「リンク維持で復旧した」と分かるよう示す
        });
        send(ws, { type: 'bitrate-policy', maxBpsRelay: calcRelayBitrate(), relayCount: relayCount() });
        audit.log({ type: 'host_reattach', ip: ws.auditIp, ua: ws.auditUa, token: existingToken });
        // 「ホスト切断中に WSを待たせていた viewer」 全員に host:back を送って再 join を促す。
        // viewer 側は受信したら viewer:join をやり直す → 通常の accept フローに乗る。
        if (old.keptViewers && old.keptViewers.size) {
          notifyKeptViewers(old);
        }
        console.log(`[server] host re-attached to session: ${existingToken}`);
        return;
      }
      // secret 不一致 → 引き継ぎ拒否、新規発行へフォールスルー
      audit.log({ type: 'host_create_secret_mismatch', ip: ws.auditIp, ua: ws.auditUa, token: existingToken });
      console.log(`[server] hostSecret mismatch for ${existingToken}, issuing fresh session`);
    } else {
      // セッションが無い（サーバ再起動など）→ 同じ token で session を「復元」する
      const restored = buildSession({ token: existingToken, hostSecret, ws, msg });
      sessions.set(existingToken, restored);
      ws.role = 'host';
      ws.token = existingToken;
      send(ws, {
        type: 'session', token: existingToken,
        viewerUrl: `${restored.base}/s/${existingToken}`,
        pin: restored.pin, accessMode: restored.accessMode, expiresAt: restored.expiresAt,
        hostSecret: restored.hostSecret,
        iceServers: buildServerIceServers(),
        resumed: true,
      });
      send(ws, { type: 'bitrate-policy', maxBpsRelay: calcRelayBitrate(), relayCount: relayCount() });
      stats.event('session_created', { accessMode: restored.accessMode, resumed: true });
      audit.log({ type: 'host_restore', ip: ws.auditIp, ua: ws.auditUa, token: existingToken, meta: { accessMode: restored.accessMode } });
      console.log(`[server] session restored (same token): ${existingToken}`);
      return;
    }
  }

  // 新規発行（通常ルート）
  const token = newToken();
  const s = buildSession({ token, hostSecret: newSecret(), ws, msg });
  sessions.set(token, s);
  ws.role = 'host';
  ws.token = token;
  send(ws, {
    type: 'session', token,
    viewerUrl: `${s.base}/s/${token}`,
    pin: s.pin, accessMode: s.accessMode, expiresAt: s.expiresAt,
    hostSecret: s.hostSecret, // 次回引き継ぎ用にホスト側へ渡す（このメッセージは host にのみ送られる）
    iceServers: buildServerIceServers(),
  });
  send(ws, { type: 'bitrate-policy', maxBpsRelay: calcRelayBitrate(), relayCount: relayCount() });
  stats.event('session_created', { accessMode: s.accessMode });
  audit.log({ type: 'host_create', ip: ws.auditIp, ua: ws.auditUa, token, meta: { accessMode: s.accessMode } });
  console.log(`[server] session created: ${token} (${s.accessMode})`);
}

// セッション構築の共通処理。新規発行と「復元」で共通化。
function buildSession({ token, hostSecret, ws, msg }) {
  const accessMode = ['approve', 'pin', 'invite', 'token'].includes(msg && msg.accessMode) ? msg.accessMode : ACCESS_MODE;
  const ttlMin = msg && Number.isFinite(msg.ttlMinutes) ? msg.ttlMinutes : SESSION_TTL_MS > 0 ? SESSION_TTL_MS / 60000 : 0;
  const expiresAt = ttlMin > 0 ? Date.now() + ttlMin * 60000 : null;
  return {
    token,
    hostSecret, // セッションごとに固定、ホストの引き継ぎ認証に使う
    host: ws,
    viewers: new Map(),
    pending: new Map(),
    maxViewers: clampMaxViewers(msg && msg.maxViewers),
    accessMode,
    status: 'idle',
    relayViewers: new Set(),
    base: baseUrl(msg && msg.publicBaseUrl),
    pin: accessMode === 'pin' ? newPin() : null,
    createdAt: Date.now(),
    expiresAt,
  };
}

function viewerJoin(ws, msg) {
  const s = sessions.get(msg.token);
  if (!s) return send(ws, { type: 'error', code: 'invalid', message: 'セッションが見つかりません' });
  if (s.expiresAt && Date.now() > s.expiresAt) {
    sessions.delete(s.token);
    return send(ws, { type: 'error', code: 'expired', message: 'セッションの有効期限が切れています' });
  }
  // host:back を受けて再 join してきた viewer の場合、 keptViewers から外す（新しい viewerId で扱う）
  if (s.keptViewers && ws.viewerId != null) s.keptViewers.delete(ws.viewerId);
  if (s.viewers.size + s.pending.size >= s.maxViewers) {
    stats.event('viewer_denied', { reason: 'busy' });
    audit.log({ type: 'viewer_denied', ip: ws.auditIp, ua: ws.auditUa, token: s.token, meta: { reason: 'busy' } });
    return send(ws, { type: 'error', code: 'busy', message: '接続できる人数の上限に達しています' });
  }
  if (s.accessMode === 'pin' && String(msg.pin || '') !== s.pin) {
    stats.event('viewer_denied', { reason: 'pin' });
    audit.log({ type: 'viewer_denied', ip: ws.auditIp, ua: ws.auditUa, token: s.token, meta: { reason: 'pin' } });
    return send(ws, { type: 'error', code: 'pin', message: 'PINが違います' });
  }
  // 招待リンクモード: auth(信頼クレデンシャル) が無ければ即拒否（通常URLでの接続を防ぐ）
  if (s.accessMode === 'invite' && !msg.auth) {
    stats.event('viewer_denied', { reason: 'no-invite' });
    audit.log({ type: 'viewer_denied', ip: ws.auditIp, ua: ws.auditUa, token: s.token, meta: { reason: 'no-invite' } });
    return send(ws, { type: 'error', code: 'invite', message: 'このセッションは招待リンク専用です。ホストから「招待リンク」を受け取ってください。' });
  }

  ws.role = 'viewer';
  ws.token = s.token;
  ws.viewerId = String(++viewerSeq);
  audit.log({ type: 'viewer_join', ip: ws.auditIp, ua: ws.auditUa, token: s.token, viewerId: ws.viewerId, meta: { accessMode: s.accessMode, hasAuth: !!msg.auth } });

  if (s.accessMode === 'approve' || s.accessMode === 'invite') {
    // approve: ホスト承認 / invite: ホスト側で trust 照合し trusted なら自動承認・それ以外は自動拒否
    s.pending.set(ws.viewerId, ws);
    s.status = 'pending';
    send(ws, { type: 'waiting', message: 'ホストの承認を待っています…' });
    // ビューア提示の信頼クレデンシャル(auth)はそのままホストへ中継（サーバは保存・検証しない）
    // 接続元情報をホスト UI で表示する用に同送（透明性・個別切断UIで使用）。
    // 監査ログとは別目的：ホストが自分のセッションへの接続を把握できるようにするため。
    send(s.host, { type: 'viewer:request', viewerId: ws.viewerId, auth: msg.auth || null, mode: s.accessMode, ip: ws.auditIp || '', ua: ws.auditUa || '', joinedAt: Date.now() });
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
    audit.log({ type: 'viewer_denied', ip: v.auditIp, ua: v.auditUa, token: s.token, viewerId: v.viewerId, meta: { reason: 'host_deny' } });
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
  send(s.host, { type: 'viewer:joined', viewerId: v.viewerId, ip: v.auditIp || '', ua: v.auditUa || '', joinedAt: Date.now() }); // 当該ビューア向けにホストがオファー作成
  stats.event('viewer_accepted', { accessMode: s.accessMode });
  audit.log({ type: 'viewer_accepted', ip: v.auditIp, ua: v.auditUa, token: s.token, viewerId: v.viewerId, meta: { accessMode: s.accessMode } });
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

// ホストが個別の viewer を切断する。 ホスト自身が「⛔ 切断」ボタンを押した場合に使う。
function hostKick(ws, msg) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws) return; // ホストからのみ受け付け
  const vid = msg && msg.viewerId;
  if (vid == null) return;
  const target = s.viewers.get(vid) || s.pending.get(vid);
  if (!target) return;
  send(target, { type: 'ended', message: 'ホストが接続を切断しました' });
  try { target.close(); } catch {}
  s.viewers.delete(vid);
  s.pending.delete(vid);
  if (s.relayViewers.delete(vid)) broadcastBitratePolicy();
  send(ws, { type: 'viewer:kicked', viewerId: vid });
  audit.log({ type: 'viewer_kicked', ip: ws.auditIp, ua: ws.auditUa, token: s.token, viewerId: vid });
  console.log(`[server] host kicked viewer ${vid} from ${s.token}`);
}

function hostEnd(ws) {
  const s = sessions.get(ws.token);
  if (!s || s.host !== ws) return;
  for (const v of [...s.viewers.values(), ...s.pending.values()]) {
    send(v, { type: 'ended', message: 'ホストがセッションを終了しました' });
    v.close();
  }
  // 「終了」は viewer 全部切断 + 受付停止だが、 session 自体は残す（S-1.1）。
  // ホストが「もう一度共有」で同 token+secret で host:create を送ったら張り替え経路に乗り、
  // 同じ viewerUrl を返せる（URLが変わらない）。 onClose と同じセマンティクス。
  // 完全削除は expiresAt の自動掃除 か ホスト WS の完全切断後の TTL に任せる。
  s.viewers.clear();
  s.pending.clear();
  s.relayViewers.clear();
  s.host = null;
  s.status = 'idle';
  console.log(`[server] session ended explicitly (host detached, session kept): ${s.token}`);
  audit.log({ type: 'host_end', ip: ws.auditIp, ua: ws.auditUa, token: s.token });
  broadcastBitratePolicy();
}

function onClose(ws) {
  const s = ws.token && sessions.get(ws.token);
  if (!s) return;
  if (ws.role === 'host') {
    // セッションは即削除しない＝ホストが同じ token+hostSecret で戻ってきたら復元できる。
    // 既存 viewers/pending はホストが消えたので解放。s.host を null にして「ホスト不在」状態に。
    // 完全削除は expiresAt の期限切れタイマー（または明示的な host:end）で行われる。
    if (s.host !== ws) return; // 既に新しいホストに張り替え済みなら何もしない
    // 「ホスト切断 != セッション終了」。 viewer のWSは閉じず host:gone 通知だけ送って待機させる。
    // ホストが同 token+secret で戻ってきたら host:back で各 viewer に再 join を促す。
    if (!s.keptViewers) s.keptViewers = new Map(); // viewerId -> ws
    for (const [vid, v] of [...s.viewers.entries(), ...s.pending.entries()]) {
      send(v, { type: 'host:gone', message: 'ホストの接続が切れました。再接続を待っています…' });
      s.keptViewers.set(vid, v); // WSは閉じない（M-2/3 で同URLで戻ってくる前提）
    }
    s.viewers.clear();
    s.pending.clear();
    s.relayViewers.clear();
    s.host = null;
    s.status = 'idle';
    console.log(`[server] host disconnected (session kept, viewers parked): ${s.token} (${s.keptViewers.size} viewers parked)`);
    audit.log({ type: 'host_disconnect', ip: ws.auditIp, ua: ws.auditUa, token: s.token });
    broadcastBitratePolicy();
    stats.event('session_closed', { durationSec: Math.floor((Date.now() - s.createdAt) / 1000) });
  } else if (ws.role === 'viewer') {
    const wasViewer = ws.viewerId != null && s.viewers.has(ws.viewerId);
    if (wasViewer) {
      s.viewers.delete(ws.viewerId);
      send(s.host, { type: 'viewer:left', viewerId: ws.viewerId });
    }
    if (ws.viewerId != null) s.pending.delete(ws.viewerId);
    if (ws.viewerId != null && s.keptViewers) s.keptViewers.delete(ws.viewerId); // 待機中だった viewer も掃除
    if (ws.viewerId != null && s.relayViewers.delete(ws.viewerId)) broadcastBitratePolicy();
    if (wasViewer) { stats.event('viewer_left'); audit.log({ type: 'viewer_left', ip: ws.auditIp, ua: ws.auditUa, token: s.token, viewerId: ws.viewerId }); }
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
      audit.log({ type: 'session_expired', token });
      console.log(`[server] session expired: ${token}`);
    }
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on ${SCHEME}://0.0.0.0:${PORT}${useTls ? ' (TLS)' : ''}`);
  console.log(`[server] viewer base url: ${baseUrl()}`);
  console.log(`[server] access mode: ${ACCESS_MODE}, session TTL: ${Math.round(SESSION_TTL_MS / 1000)}s`);
});
