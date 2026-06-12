'use strict';
// Local HTTP API の認証トークン管理。
// - PAssist 起動時にランダム 32 バイトの hex を生成
// - %APPDATA%\PAssist\local-api-token (ユーザのみアクセス可) に保存
// - passist-mcp はファイルを読み取って Authorization: Bearer <token> ヘッダに付与
// - PAssist 終了時に token を破棄 (ファイル削除)
//   → token は実質「アプリ実行中のみ有効」 になり、 漏洩リスクが時間軸で限定される

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let currentToken = null;
let tokenFile = null;

// 起動時に呼ぶ。 token を新規生成してファイルへ書き出し。
function init(userDataDir) {
  tokenFile = path.join(userDataDir, 'local-api-token');
  currentToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, currentToken, { mode: 0o600 });
    // Windows では fs の mode は無視されるため、 ACL の厳密化は OS まかせ
    // (userData は既に %APPDATA%\<appName> 配下＝ユーザ専用)。
  } catch (e) {
    console.warn('[local-api-auth] token 書き出し失敗:', e.message);
  }
  return currentToken;
}

function getToken() {
  return currentToken;
}

function getTokenFilePath() {
  return tokenFile;
}

// PAssist 終了時に呼ぶ。 token ファイルを削除して旧 token を無効化。
function shutdown() {
  if (!tokenFile) return;
  try {
    fs.unlinkSync(tokenFile);
  } catch {}
  currentToken = null;
}

// Express middleware: Authorization: Bearer <token> を検証
function authMiddleware(req, res, next) {
  const h = req.headers && req.headers.authorization;
  const m = h && /^Bearer\s+([A-Fa-f0-9]+)$/.exec(h);
  if (!m || !currentToken) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'AUTH_FAILED', message: 'Bearer token required' } }));
    return;
  }
  // 定数時間比較 (タイミング攻撃対策)
  const a = Buffer.from(m[1], 'hex');
  const b = Buffer.from(currentToken, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'AUTH_FAILED', message: 'invalid token' } }));
    return;
  }
  next();
}

module.exports = { init, getToken, getTokenFilePath, shutdown, authMiddleware };
