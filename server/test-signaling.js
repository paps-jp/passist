'use strict';
// シグナリング/中継サーバの結合テスト。
// 事前に ACCESS_MODE=approve でサーバを起動しておくこと:
//   PowerShell:  $env:PORT="8990"; $env:ACCESS_MODE="approve"; node server/server.js
//   別ターミナルで:  $env:TEST_PORT="8990"; node server/test-signaling.js
// （ホスト/ビューアを WS で模擬し、一連の流れと信頼クレデンシャルの中継を検証する）
const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || '8990';
const WS = `ws://127.0.0.1:${PORT}/ws`;

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.queue = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = ws.waiters.findIndex((x) => x.pred(msg));
      if (i >= 0) ws.waiters.splice(i, 1)[0].resolve(msg);
      else ws.queue.push(msg);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
function waitFor(ws, pred, label, timeout = 3000) {
  const i = ws.queue.findIndex(pred);
  if (i >= 0) return Promise.resolve(ws.queue.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + label)), timeout);
    ws.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
const type = (t) => (m) => m.type === t;

async function main() {
  let n = 0;
  const ok = (c, m) => {
    if (!c) throw new Error('FAIL: ' + m);
    n++;
    console.log('  ok - ' + m);
  };

  // --- ホストがセッション発行 ---
  let host;
  try {
    host = await open();
  } catch (e) {
    throw new Error(
      `サーバへ接続できません (${WS}: ${e.message})。先に ACCESS_MODE=approve でサーバを起動してください。`,
    );
  }
  send(host, { type: 'host:create' });
  const sess = await waitFor(host, type('session'), 'session');
  ok(!!sess.token, 'ホストが session トークンを受領');
  ok(/\/s\//.test(sess.viewerUrl), 'viewerUrl が /s/<token> 形式');

  // --- 新規ビューア(auth なし) → ホストに承認リクエスト(auth=null) ---
  const v1 = await open();
  send(v1, { type: 'viewer:join', token: sess.token });
  await waitFor(v1, type('waiting'), 'v1 waiting');
  const req1 = await waitFor(host, type('viewer:request'), 'host viewer:request #1');
  ok(req1.auth === null, '初回リクエストは auth=null');

  // --- ホストが「信頼」付きで承認 → ビューアに issue が届く ---
  const issued = { clientId: 'CID-1', secret: 'SECRET-1' };
  send(host, { type: 'host:approve', issue: issued });
  const acc1 = await waitFor(v1, type('accepted'), 'v1 accepted');
  ok(acc1.issue && acc1.issue.clientId === 'CID-1', 'accepted に発行クレデンシャルが乗る');
  await waitFor(host, type('viewer:joined'), 'host viewer:joined');

  // --- シグナリング双方向中継 ---
  send(v1, { type: 'signal', data: { sdp: 'ANSWER' } });
  const toHost = await waitFor(host, type('signal'), 'host gets signal');
  ok(toHost.data.sdp === 'ANSWER', 'viewer→host の signal を中継');
  send(host, { type: 'signal', data: { candidate: 'CAND' } });
  const toV = await waitFor(v1, type('signal'), 'viewer gets signal');
  ok(toV.data.candidate === 'CAND', 'host→viewer の signal を中継');

  // --- 同時接続は1人 ---
  const v2 = await open();
  send(v2, { type: 'viewer:join', token: sess.token });
  const busy = await waitFor(v2, type('error'), 'v2 error');
  ok(busy.code === 'busy', '2人目は busy で拒否');
  v2.close();

  // --- ホスト終了 → ビューアに通知 ---
  send(host, { type: 'host:end' });
  const ended = await waitFor(v1, type('ended'), 'v1 ended');
  ok(ended.type === 'ended', 'host:end でビューアに通知');
  v1.close();

  // --- 信頼済み再接続: auth を提示 → サーバはそのままホストへ中継 ---
  const v3 = await open();
  send(v3, { type: 'viewer:join', token: sess.token, auth: issued });
  await waitFor(v3, type('waiting'), 'v3 waiting');
  const req3 = await waitFor(host, type('viewer:request'), 'host viewer:request #3');
  ok(
    req3.auth && req3.auth.clientId === 'CID-1' && req3.auth.secret === 'SECRET-1',
    'auth がホストへ改変なく中継される（=ホストが信頼判定できる）',
  );
  send(host, { type: 'host:approve' }); // ホストの自動承認を模擬
  const acc3 = await waitFor(v3, type('accepted'), 'v3 accepted');
  ok(acc3.issue === null, '自動承認は新規 issue なし');
  v3.close();

  // --- 拒否 ---
  const v4 = await open();
  send(v4, { type: 'viewer:join', token: sess.token });
  await waitFor(host, type('viewer:request'), 'host request #4');
  send(host, { type: 'host:deny' });
  const denied = await waitFor(v4, type('denied'), 'v4 denied');
  ok(denied.type === 'denied', 'host:deny でビューアに通知');
  v4.close();

  // --- 不正トークン ---
  const v5 = await open();
  send(v5, { type: 'viewer:join', token: 'bogus-token' });
  const inv = await waitFor(v5, type('error'), 'v5 error');
  ok(inv.code === 'invalid', '不正トークンは invalid で拒否');
  v5.close();

  host.close();
  console.log(`\ntest-signaling.js: ALL PASS (${n} checks)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
