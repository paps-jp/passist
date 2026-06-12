'use strict';
// MCP クライアント別の同意 (consent) 永続化。
// - クライアント識別子は passist-mcp 起動時に発見する親プロセス情報から生成 (実行ファイル名+SHA-256)
// - 状態は 'always' (常に許可) / 'once' (今回だけ) / 'deny' (拒否)
// - 'always' / 'deny' は %APPDATA%\PAssist\mcp-consents.json に永続化
// - 'once' はメモリ内のみ。 当該クライアントプロセスが切断 (TCP close) するまで有効
// - 同意取り消し・拒否解除は設定タブから操作可能

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let consentsFile = null;
let persisted = {}; // { clientKey: { state: 'always'|'deny', decidedAt: iso, label: string } }
const sessionAllowed = new Set(); // 今回だけ許可された clientKey 集合 (プロセス寿命と一致)

function init(userDataDir) {
  consentsFile = path.join(userDataDir, 'mcp-consents.json');
  try {
    if (fs.existsSync(consentsFile)) {
      persisted = JSON.parse(fs.readFileSync(consentsFile, 'utf8')) || {};
    } else {
      persisted = {};
    }
  } catch (e) {
    console.warn('[local-api-consent] consent 読み込み失敗、 空で再開:', e.message);
    persisted = {};
  }
}

// クライアント情報から安定したキーを作る。 同じバイナリ (path) からの呼び出しは同じキー。
// MCP は親プロセスを stdio 越しに spawn するので、 PPID や exePath で識別する。
function clientKey({ exePath, label }) {
  const src = (exePath || label || 'unknown').toLowerCase();
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
}

// 現在の許可状態。 'always' | 'once' | 'deny' | null (未決定)
function currentState(clientKeyId) {
  if (persisted[clientKeyId] && persisted[clientKeyId].state) return persisted[clientKeyId].state;
  if (sessionAllowed.has(clientKeyId)) return 'once';
  return null;
}

// 接続が許可されているか? (always or once)
function isAllowed(clientKeyId) {
  const s = currentState(clientKeyId);
  return s === 'always' || s === 'once';
}

function isDenied(clientKeyId) {
  return currentState(clientKeyId) === 'deny';
}

// 同意を記録する。 result: 'always' | 'once' | 'deny'
function record(clientKeyId, info, result) {
  if (result === 'always' || result === 'deny') {
    persisted[clientKeyId] = {
      state: result,
      decidedAt: new Date().toISOString(),
      label: info && info.label,
      exePath: info && info.exePath,
    };
    save();
  } else if (result === 'once') {
    sessionAllowed.add(clientKeyId);
  }
}

// セッション内の許可を解除 (プロセス切断時に呼ぶ)
function clearSession(clientKeyId) {
  sessionAllowed.delete(clientKeyId);
}

// 設定タブから個別取消
function revoke(clientKeyId) {
  delete persisted[clientKeyId];
  sessionAllowed.delete(clientKeyId);
  save();
}

// 設定タブ表示用: 永続化済み + セッション内 をマージ
function list() {
  const out = [];
  for (const [key, v] of Object.entries(persisted)) {
    out.push({ key, ...v });
  }
  for (const key of sessionAllowed) {
    if (!persisted[key]) {
      out.push({ key, state: 'once', decidedAt: null, label: null });
    }
  }
  return out;
}

function save() {
  if (!consentsFile) return;
  try {
    fs.mkdirSync(path.dirname(consentsFile), { recursive: true });
    fs.writeFileSync(consentsFile, JSON.stringify(persisted, null, 2));
  } catch (e) {
    console.warn('[local-api-consent] 保存失敗:', e.message);
  }
}

module.exports = { init, clientKey, currentState, isAllowed, isDenied, record, clearSession, revoke, list };
