'use strict';
// stats.js のイベント記録と snapshot を検証する。
// PASSIST_STATS_DIR で独立 dir を渡し、本番の data/stats.json には触らない。
// 実行: `node --test server/test-stats.js`

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// stats.js を require する前に独立 dir を環境変数で指定する（プロセス内で1回読まれる）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'passist-stats-test-'));
process.env.PASSIST_STATS_DIR = TMP;

const stats = require('./stats');

test('初期 snapshot: live/last24h はゼロ', () => {
  const s = stats.snapshot();
  assert.equal(s.live.sessions, 0);
  assert.equal(s.live.viewers, 0);
  assert.equal(s.live.relays, 0);
  assert.equal(s.last24h.sessions, 0);
  assert.equal(s.last24h.viewersAccepted, 0);
  assert.equal(s.last24h.viewersDenied, 0);
});

test('session_created → live.sessions と last24h.sessions が増える', () => {
  const before = stats.snapshot();
  stats.event('session_created', { accessMode: 'approve' });
  stats.event('session_created', { accessMode: 'invite' });
  const after = stats.snapshot();
  assert.equal(after.live.sessions, before.live.sessions + 2);
  assert.equal(after.last24h.sessions, before.last24h.sessions + 2);
});

test('session_closed: live.sessions が減って totalSeconds が積まれる', () => {
  const before = stats.snapshot();
  stats.event('session_closed', { durationSec: 120 });
  const after = stats.snapshot();
  assert.equal(after.live.sessions, Math.max(0, before.live.sessions - 1));
  // daily の今日エントリに totalSeconds が積まれる
  const today = Object.keys(after.daily).pop();
  assert.ok(after.daily[today].totalSeconds >= 120);
});

test('viewer_accepted / viewer_left の live カウント', () => {
  const before = stats.snapshot();
  stats.event('viewer_accepted', { accessMode: 'approve' });
  stats.event('viewer_accepted', { accessMode: 'approve' });
  let snap = stats.snapshot();
  assert.equal(snap.live.viewers, before.live.viewers + 2);

  stats.event('viewer_left');
  snap = stats.snapshot();
  assert.equal(snap.live.viewers, before.live.viewers + 1);
});

test('viewer_denied: 24h カウントが増えるが live は不変', () => {
  const before = stats.snapshot();
  stats.event('viewer_denied', { reason: 'pin' });
  stats.event('viewer_denied', { reason: 'no-invite' });
  const after = stats.snapshot();
  assert.equal(after.last24h.viewersDenied, before.last24h.viewersDenied + 2);
  assert.equal(after.live.viewers, before.live.viewers); // 拒否では live は動かない
});

test('peer_route(p2p→relay): liveRelays が増える', () => {
  const before = stats.snapshot();
  stats.event('peer_route', { via: 'relay', prev: 'p2p' });
  const after = stats.snapshot();
  assert.equal(after.live.relays, before.live.relays + 1);
});

test('peer_route(relay→p2p): liveRelays が減る', () => {
  const before = stats.snapshot();
  stats.event('peer_route', { via: 'p2p', prev: 'relay' });
  const after = stats.snapshot();
  assert.equal(after.live.relays, Math.max(0, before.live.relays - 1));
});

test('peer_route(p2p→p2p): liveRelays は変わらず p2pPeers が増える', () => {
  const before = stats.snapshot();
  stats.event('peer_route', { via: 'p2p', prev: null });
  const after = stats.snapshot();
  assert.equal(after.live.relays, before.live.relays);
  const today = Object.keys(after.daily).pop();
  assert.ok(after.daily[today].p2pPeers > 0);
});

test('snapshot.last24h.turnRatio が承認数に対する relay 比率になる', () => {
  // 簡易確認: NaN や負値にならない
  const s = stats.snapshot();
  assert.ok(s.last24h.turnRatio >= 0 && s.last24h.turnRatio <= 100);
  assert.ok(s.last24h.acceptRatio >= 0 && s.last24h.acceptRatio <= 100);
});

test('flush: data/stats.json がテスト用 dir に作られる', async () => {
  stats.flush();
  const f = path.join(TMP, 'stats.json');
  // 同期的に書く実装なので即時存在する
  assert.ok(fs.existsSync(f), 'stats.json が作られているはず');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Array.isArray(j.events));
  assert.ok(j.daily && typeof j.daily === 'object');
});

test.after(() => {
  // テスト終了時に一時 dir を片付け
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
