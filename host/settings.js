'use strict';
// 設定の永続化（userData/passist-settings.json）。初回は環境変数を既定値として読む。
const fs = require('fs');

const DEFAULTS = {
  port: parseInt(process.env.PORT || '8443', 10),
  publicMode: process.env.PASSIST_PUBLIC !== '0', // UPnP でインターネット公開するか
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '', // トンネル等の公開URL（指定時は共有URLのベース）
  accessMode: process.env.ACCESS_MODE || 'approve', // approve | pin | token
  readonly: false, // 閲覧のみ：接続相手の操作（マウス/キーボード/クリップボード書込）を禁止し画面共有だけにする
  maxViewers: 1, // 同時接続できるビューア数（1〜4）。2以上で複数同時接続を許可（操作は1人のみ・他は閲覧）
  sessionTtlMinutes: Math.round(parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10) / 60000),
  language: 'auto', // i18n 用（将来）
  activeShareName: '', // 共有中ウィンドウ名（再起動時の自動再開用。終了ボタンで空に）
  // TURN サーバ（任意）。NAT が厳しい相手向けの中継。設定があるピアのみ relay 経由になり、
  // サーバ側の動的ガバナで他の relay 接続と帯域を分け合う（bitrate-policy）。
  turnUrl: '',  // 例: turn:turn.example.com:3478 ・ turns:turn.example.com:5349 ・ turn:host:port?transport=tcp
  turnUser: '', // long-term credential のユーザ名
  turnPass: '', // long-term credential のパスワード
  // 接続サーバ。central=中央サーバ(passist.paps.jp)に接続。self=自分のPCで内蔵signalingを起動（cloudflared併用）。
  serverMode: 'central',
  centralServerUrl: 'wss://passist.paps.jp/ws', // central時の接続先。viewerURLのbaseは https://passist.paps.jp を使う
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
