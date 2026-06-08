'use strict';
// 設定の永続化（userData/passist-settings.json）。初回は環境変数を既定値として読む。
const fs = require('fs');

const DEFAULTS = {
  port: parseInt(process.env.PORT || '8443', 10),
  publicMode: process.env.PASSIST_PUBLIC !== '0', // UPnP でインターネット公開するか
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '', // トンネル等の公開URL（指定時は共有URLのベース）
  accessMode: process.env.ACCESS_MODE || 'approve', // approve | pin | token
  sessionTtlMinutes: Math.round(parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10) / 60000),
  language: 'auto', // i18n 用（将来）
  activeShareName: '', // 共有中ウィンドウ名（再起動時の自動再開用。終了ボタンで空に）
};

let filePath = null;
let data = { ...DEFAULTS };

function clean(obj) {
  // 既知キーだけを採用（不正なインポートを弾く）
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function init(p) {
  filePath = p;
  try {
    if (fs.existsSync(p)) data = clean(JSON.parse(fs.readFileSync(p, 'utf8')));
    else save(); // 初回は既定値で設定ファイルを作成（「設定を保存」を明示）
  } catch {
    data = { ...DEFAULTS };
  }
  return get();
}

function get() {
  return { ...data };
}
function set(patch) {
  data = clean({ ...data, ...patch });
  save();
  return get();
}
function save() {
  try {
    if (filePath) fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {}
}
function exportTo(p) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function importFrom(p) {
  data = clean(JSON.parse(fs.readFileSync(p, 'utf8')));
  save();
  return get();
}

module.exports = { init, get, set, save, exportTo, importFrom, DEFAULTS };
