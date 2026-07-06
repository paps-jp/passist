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
// V-28.4: 従来は writeFileSync 失敗 (Windows ファイルロック / OneDrive 同期 / AV 干渉等) を
//   silently 握りつぶし、 currentToken には in-memory の新規 random を残していた。 結果
//   disk 上の古い token と in-memory の token が乖離し、 passist-mcp からの Authorization
//   Bearer が全部 AUTH_FAILED になっていた (「file token を読んで送っても認証通らない」)。
//   修正: (a) tmp file + rename で書き込みを頑健化、 (b) 書き込み失敗時は既存 disk token を
//   採用して in-memory と disk を一致させる、 (c) どちらも駄目なら新 token 継続で desync
//   状態を明示ログ。
function init(userDataDir) {
  tokenFile = path.join(userDataDir, 'local-api-token');
  const newToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const tmp = tokenFile + '.tmp';
    try {
      // atomic write via tmp + rename (Windows のファイルロックを避ける)
      fs.writeFileSync(tmp, newToken, { mode: 0o600 });
      try { fs.renameSync(tmp, tokenFile); }
      catch {
        // rename も失敗したら直接上書きを試す
        fs.writeFileSync(tokenFile, newToken, { mode: 0o600 });
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    currentToken = newToken;
  } catch (e) {
    console.warn('[local-api-auth] token 書き出し失敗:', e.message, '→ 既存 disk token を採用試行');
    try {
      const existing = String(fs.readFileSync(tokenFile, 'utf-8') || '').trim();
      if (/^[A-Fa-f0-9]+$/.test(existing) && existing.length >= 32) {
        currentToken = existing;
        console.warn('[local-api-auth] 既存 disk token を採用 (in-memory と一致させた)');
      } else {
        currentToken = newToken;
        console.error('[local-api-auth] 既存 token が不正、 in-memory の新 token を使用 (認証 desync 継続)');
      }
    } catch (e2) {
      currentToken = newToken;
      console.error('[local-api-auth] 既存 token 読み込みも失敗:', e2.message);
    }
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
