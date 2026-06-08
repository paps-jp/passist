'use strict';
// 信頼済み端末ストア（ホスト側でのみ保持・永続化）。
// クレデンシャルは { clientId, secret }。保存するのは secret のハッシュのみ。
// secret 平文はビューアの localStorage にのみ保存され、接続時に提示される。

const fs = require('fs');
const crypto = require('crypto');

let filePath = null;
let data = { clients: {} }; // clientId -> { secretHash, label, addedAt }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function init(p) {
  filePath = p;
  try {
    if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    data = { clients: {} };
  }
  if (!data || typeof data !== 'object' || !data.clients) data = { clients: {} };
  return data;
}

function save() {
  try {
    if (filePath) fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {
    /* 保存失敗は致命的でない（次回再発行できる） */
  }
}

// 新しい信頼クレデンシャルを発行して保存。平文 secret は呼び出し元（→ビューア）にだけ返す。
function issue(label) {
  const clientId = crypto.randomUUID();
  const secret = crypto.randomBytes(24).toString('base64url');
  data.clients[clientId] = { secretHash: sha256(secret), label: label || '信頼済み端末', addedAt: Date.now() };
  save();
  return { clientId, secret };
}

// ビューア提示の auth を照合。
function check(auth) {
  if (!auth || !auth.clientId || !auth.secret) return { trusted: false };
  const rec = data.clients[auth.clientId];
  if (!rec) return { trusted: false };
  if (rec.secretHash !== sha256(auth.secret)) return { trusted: false };
  return { trusted: true, label: rec.label };
}

function list() {
  return Object.entries(data.clients).map(([clientId, r]) => ({
    clientId,
    label: r.label,
    addedAt: r.addedAt,
  }));
}

function remove(clientId) {
  delete data.clients[clientId];
  save();
}

function clear() {
  data = { clients: {} };
  save();
}

module.exports = { init, issue, check, list, remove, clear };
