'use strict';
// PAssist の Local HTTP API (127.0.0.1:8444)。
// MCP クライアント (passist-mcp) からの操作要求を受け、 ホスト内の処理に橋渡しする。
//
// 設計:
//   - HTTP は Node 標準 http のみ (express を増やさない、 依存を最小化)。
//   - loopback のみで listen ('127.0.0.1') = 外部からアクセス不可。
//   - 認証: Authorization: Bearer <token> (local-api-auth.js)。
//   - 同意: クライアント別。 初回の API 呼び出しで未決定なら同意ダイアログ要求 IPC を送る。
//     ダイアログ表示中に呼び出しは「ペンディング」 で保留。 結果を待ってから API 応答。
//
// 公開 URL は本ファイル下部の routes テーブルを参照。

const http = require('http');
const crypto = require('crypto');
const auth = require('./local-api-auth');
const consent = require('./local-api-consent');
const handlers = require('./local-api-handlers');

let server = null;
let listenPort = 8444;
let ipcBridge = null; // { sendToRenderer, getWindowList, getShareState, startShareForRenderer, endShareFromRenderer, requestConsent }
const pendingConsent = new Map(); // clientKey -> [resolveFns]

// CORS / preflight 無効化: loopback なので CORS は気にしない。
// ただし Content-Type が JSON でないリクエストは body を読まない。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 256 * 1024) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// passist-mcp が送ってくるクライアント情報 (X-PAssist-Client-* ヘッダ)
function extractClientInfo(req) {
  const exePath = req.headers['x-passist-client-exe'] || '';
  const label = req.headers['x-passist-client-label'] || '';
  const pid = parseInt(req.headers['x-passist-client-pid'] || '0', 10) || null;
  return { exePath, label, pid };
}

// 同意フローを通す。 結果: true (許可) / false (拒否)
async function ensureConsent(clientInfo) {
  const key = consent.clientKey(clientInfo);
  if (consent.isAllowed(key)) return true;
  if (consent.isDenied(key)) return false;
  // 未決定。 renderer に同意ダイアログ要求 IPC を送り、 結果を待つ。
  // 既にダイアログ表示中なら同じ Promise に合流させる。
  if (pendingConsent.has(key)) {
    return new Promise((resolve) => pendingConsent.get(key).push(resolve));
  }
  const waiters = [];
  pendingConsent.set(key, waiters);
  try {
    const result = await ipcBridge.requestConsent({ clientInfo, key });
    // result: { decision: 'always'|'once'|'deny' }
    consent.record(key, clientInfo, result.decision);
    const allowed = result.decision === 'always' || result.decision === 'once';
    for (const r of waiters) r(allowed);
    return allowed;
  } catch (e) {
    console.warn('[local-api] consent dialog failed:', e.message);
    for (const r of waiters) r(false);
    return false;
  } finally {
    pendingConsent.delete(key);
  }
}

// ルートテーブル: メソッド + URL → handler 関数
const routes = [
  { method: 'GET', path: '/api/local/windows', handler: handlers.listWindows },
  { method: 'POST', path: '/api/local/share/start', handler: handlers.shareStart },
  { method: 'GET', path: '/api/local/share', handler: handlers.shareStatus },
  { method: 'POST', path: '/api/local/share/end', handler: handlers.shareEnd },
];

async function dispatch(req, res) {
  // 認証
  const okAuth = await new Promise((resolve) => auth.authMiddleware(req, res, () => resolve(true)));
  if (!okAuth) return; // authMiddleware が 401 を返している

  // クライアント情報抽出 + 同意フロー
  const clientInfo = extractClientInfo(req);
  const allowed = await ensureConsent(clientInfo);
  if (!allowed) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'USER_DECLINED', message: 'user denied consent for this client' } }));
    return;
  }

  // body 読み込み (POST のみ)
  if (req.method === 'POST' || req.method === 'PUT') {
    try { req.rawBody = await readBody(req); } catch (e) {
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'VALIDATION', message: e.message } }));
      return;
    }
  }

  // ルーティング
  const url = (req.url || '').split('?')[0];
  const route = routes.find((r) => r.method === req.method && r.path === url);
  if (!route) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${url}` } }));
    return;
  }

  try {
    await route.handler(req, res, ipcBridge);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: e.message } }));
    }
  }
}

// bridge: main プロセスから渡される IPC 関数群
function start({ userDataDir, bridge, port }) {
  ipcBridge = bridge;
  listenPort = port || 8444;
  auth.init(userDataDir);
  consent.init(userDataDir);
  server = http.createServer((req, res) => {
    dispatch(req, res).catch((e) => {
      console.warn('[local-api] dispatch error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      console.log(`[local-api] listening on http://127.0.0.1:${listenPort} (token: ${auth.getTokenFilePath()})`);
      resolve({ port: listenPort });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => {
      auth.shutdown();
      resolve();
    });
  });
}

module.exports = { start, stop, consent };
