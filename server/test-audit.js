'use strict';
// audit.js のテスト。PASSIST_AUDIT_DIR で独立 dir に出力、テスト後に削除。
// 実行: `node --test server/test-audit.js`

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'passist-audit-test-'));
process.env.PASSIST_AUDIT_DIR = TMP;
process.env.PASSIST_AUDIT_RETENTION_DAYS = '7'; // テスト用に短く

const audit = require('./audit');

function listFiles() {
  return fs.readdirSync(TMP).filter((f) => f.endsWith('.jsonl')).sort();
}
function readLast(file) {
  const lines = fs.readFileSync(path.join(TMP, file), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('log: 1イベントが JSONL に追記される', () => {
  audit.log({ type: 'ws_connect', ip: '192.0.2.1', ua: 'Test/1.0' });
  const files = listFiles();
  assert.equal(files.length, 1, 'ファイルが1つできる');
  const e = readLast(files[0]);
  assert.equal(e.type, 'ws_connect');
  assert.equal(e.ip, '192.0.2.1');
  assert.equal(e.ua, 'Test/1.0');
  assert.ok(e.ts, 'タイムスタンプあり');
});

test('log: 同じ日のイベントは同じファイルに追記される', () => {
  const before = fs.readFileSync(path.join(TMP, listFiles()[0]), 'utf8').split('\n').filter(Boolean).length;
  audit.log({ type: 'viewer_join', ip: '198.51.100.5', token: 'abc123', viewerId: 'v1', meta: { accessMode: 'approve' } });
  audit.log({ type: 'viewer_accepted', ip: '198.51.100.5', token: 'abc123', viewerId: 'v1' });
  const after = fs.readFileSync(path.join(TMP, listFiles()[0]), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before + 2, '2行追記される');
});

test('extractIp: X-Forwarded-For が最優先（最左を使用）', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(audit.extractIp(req), '203.0.113.5');
});

test('extractIp: X-Forwarded-For 無しなら socket.remoteAddress', () => {
  const req = { headers: {}, socket: { remoteAddress: '192.0.2.42' } };
  assert.equal(audit.extractIp(req), '192.0.2.42');
});

test('extractIp: IPv4-mapped IPv6 を IPv4 に正規化', () => {
  const req = { headers: {}, socket: { remoteAddress: '::ffff:192.0.2.1' } };
  assert.equal(audit.extractIp(req), '192.0.2.1');
});

test('extractIp: 異常入力でも空文字（例外なし）', () => {
  assert.equal(audit.extractIp({}), '');
  assert.equal(audit.extractIp(null), '');
});

test('extractUserAgent: 200文字でカット', () => {
  const ua = 'Mozilla/'.repeat(50); // 400文字
  const req = { headers: { 'user-agent': ua } };
  const out = audit.extractUserAgent(req);
  assert.equal(out.length, 200);
});

test('extractUserAgent: 無ければ空文字', () => {
  assert.equal(audit.extractUserAgent({ headers: {} }), '');
  assert.equal(audit.extractUserAgent({}), '');
});

test('purgeOld: 保管期間より古いファイルを削除する', () => {
  // 30日前の日付でダミーファイルを作る
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const oldName = oldDate.getUTCFullYear() + '-' + String(oldDate.getUTCMonth() + 1).padStart(2, '0') + '-' + String(oldDate.getUTCDate()).padStart(2, '0') + '.jsonl';
  fs.writeFileSync(path.join(TMP, oldName), '{"type":"old"}\n');
  assert.ok(fs.existsSync(path.join(TMP, oldName)), '古いファイルが存在する');
  const removed = audit.purgeOld();
  assert.ok(removed >= 1, '少なくとも1つ削除された');
  assert.equal(fs.existsSync(path.join(TMP, oldName)), false, '古いファイルが消えた');
});

test('purgeOld: 保管期間内のファイルは残す', () => {
  // 当日のファイルは購読された後でも残る
  audit.log({ type: 'sanity' });
  audit.purgeOld();
  assert.ok(listFiles().length >= 1, '当日ファイルは残る');
});

test('normalizeIp: 空・無効入力に強い', () => {
  assert.equal(audit.normalizeIp(''), '');
  assert.equal(audit.normalizeIp(null), '');
  assert.equal(audit.normalizeIp('192.0.2.1'), '192.0.2.1');
  assert.equal(audit.normalizeIp('::ffff:198.51.100.42'), '198.51.100.42');
  assert.equal(audit.normalizeIp('2001:db8::1'), '2001:db8::1');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
