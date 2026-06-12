'use strict';
// 監査ログ（非公開）。情プラ法・プロバイダ責任制限法に基づく発信者情報開示請求に対応するため、
// 接続元 IP / User-Agent / セッションtoken / 何が起きたか を append-only で記録する。
// 既存 stats.js（匿名・公開）とは目的が違うので完全に分離する。
//
// - 1行1イベントの JSONL を data/audit/YYYY-MM-DD.jsonl に追記
// - 既定 365 日保管。それ以上古いファイルは毎日自動削除
// - 通信内容（WebRTC メディア・DataChannel・入力イベント）は記録しない（プライバシー上不要かつ取れない）
// - 公開 API には載せない（/api/stats は匿名集計のまま）
// - テスト時は PASSIST_AUDIT_DIR で独立 dir を渡す

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PASSIST_AUDIT_DIR || path.join(__dirname, '..', 'data', 'audit');
const RETENTION_DAYS = parseInt(process.env.PASSIST_AUDIT_RETENTION_DAYS || '365', 10);
const UA_MAX = 200; // User-Agent は先頭 200 文字まで（情報過剰を避ける）

let enabled = true;
function ensureDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.warn('[audit] mkdir failed:', e.message); enabled = false; }
}
ensureDir();

function dayKey(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function fileFor(ts) {
  return path.join(DATA_DIR, dayKey(ts) + '.jsonl');
}

// X-Forwarded-For: クライアントIP は最右側ではなく「最左側（クライアントが最初に出した値）」が一般的に正しい。
// ただし、最左は偽装可能なので、信頼できる proxy 一段だけ取り除く（Caddy 等）。
// シンプル方針: X-Forwarded-For があれば最初の値、無ければ socket.remoteAddress。
function extractIp(req) {
  try {
    const xff = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
    const ra = req.socket && req.socket.remoteAddress;
    return ra ? normalizeIp(ra) : '';
  } catch { return ''; }
}

// "::ffff:192.0.2.1" のような IPv4-mapped IPv6 を IPv4 に正規化（記録の見やすさのため）
function normalizeIp(ip) {
  if (!ip) return '';
  ip = String(ip).trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return m ? m[1] : ip;
}

function extractUserAgent(req) {
  try {
    const ua = req.headers && (req.headers['user-agent'] || req.headers['User-Agent']);
    return ua ? String(ua).slice(0, UA_MAX) : '';
  } catch { return ''; }
}

// 主 API: イベントを 1 行追記する。失敗してもサーバ動作には影響させない。
function log(event) {
  if (!enabled) return;
  const ts = Date.now();
  const line = JSON.stringify({
    ts: new Date(ts).toISOString(),
    type: event.type || 'unknown',
    ip: event.ip || '',
    ua: event.ua || '',
    token: event.token || '',
    viewerId: event.viewerId || '',
    meta: event.meta || null,
  }) + '\n';
  try { fs.appendFileSync(fileFor(ts), line); }
  catch (e) { console.warn('[audit] append failed:', e.message); }
}

// 保管期間切れのファイルを削除（呼び出し: 起動時 + 1日1回）
function purgeOld(now = Date.now()) {
  if (!enabled) return 0;
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const dayTs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (dayTs < cutoff) {
        try { fs.unlinkSync(path.join(DATA_DIR, f)); removed++; }
        catch (e) { console.warn('[audit] unlink failed:', f, e.message); }
      }
    }
  } catch (e) { console.warn('[audit] purge readdir failed:', e.message); }
  return removed;
}

// 起動時と毎日1回パージ（テスト時のタイマー暴走防止のため unref）
purgeOld();
setInterval(purgeOld, 24 * 60 * 60 * 1000).unref();

module.exports = { log, extractIp, extractUserAgent, purgeOld, normalizeIp, _config: { DATA_DIR, RETENTION_DAYS } };
