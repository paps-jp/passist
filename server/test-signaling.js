'use strict';
// シグナリング/中継サーバの結合テスト。
// 事前に ACCESS_MODE=approve でサーバを起動しておくこと:
//   PowerShell:  $env:PORT="8990"; $env:ACCESS_MODE="approve"; node server/server.js
//   別ターミナルで:  $env:TEST_PORT="8990"; node server/test-signaling.js
// （ホスト/ビューアを WS で模擬し、一連の流れ・信頼クレデンシャル中継・複数同時接続を検証する）
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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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

  // --- ホストがセッション発行（既定 maxViewers=1） ---
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

  // --- 新規ビューア(auth なし) → ホストに承認リクエスト(viewerId 付き / auth=null) ---
  const v1 = await open();
  send(v1, { type: 'viewer:join', token: sess.token });
  await waitFor(v1, type('waiting'), 'v1 waiting');
  const req1 = await waitFor(host, type('viewer:request'), 'host viewer:request #1');
  ok(req1.auth === null, '初回リクエストは auth=null');
  ok(!!req1.viewerId, 'viewer:request に viewerId が付く');
  const id1 = req1.viewerId;

  // --- ホストが「信頼」付きで承認 → ビューアに issue が届く ---
  const issued = { clientId: 'CID-1', secret: 'SECRET-1' };
  send(host, { type: 'host:approve', viewerId: id1, issue: issued });
  const acc1 = await waitFor(v1, type('accepted'), 'v1 accepted');
  ok(acc1.issue && acc1.issue.clientId === 'CID-1', 'accepted に発行クレデンシャルが乗る');
  const joined1 = await waitFor(host, type('viewer:joined'), 'host viewer:joined');
  ok(joined1.viewerId === id1, 'viewer:joined に該当 viewerId が乗る');

  // --- シグナリング双方向中継（from/to 付き） ---
  send(v1, { type: 'signal', data: { sdp: 'ANSWER' } });
  const toHost = await waitFor(host, type('signal'), 'host gets signal');
  ok(toHost.data.sdp === 'ANSWER' && toHost.from === id1, 'viewer→host の signal を from 付きで中継');
  send(host, { type: 'signal', to: id1, data: { candidate: 'CAND' } });
  const toV = await waitFor(v1, type('signal'), 'viewer gets signal');
  ok(toV.data.candidate === 'CAND', 'host→viewer の signal を宛先指定で中継');

  // --- 既定では2人目は上限で拒否 ---
  const v2 = await open();
  send(v2, { type: 'viewer:join', token: sess.token });
  const busy = await waitFor(v2, type('error'), 'v2 error');
  ok(busy.code === 'busy', 'maxViewers=1 では2人目は busy で拒否');
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
  send(host, { type: 'host:approve', viewerId: req3.viewerId }); // 自動承認を模擬
  const acc3 = await waitFor(v3, type('accepted'), 'v3 accepted');
  ok(acc3.issue === null, '自動承認は新規 issue なし');
  v3.close();

  // --- 拒否 ---
  const v4 = await open();
  send(v4, { type: 'viewer:join', token: sess.token });
  const req4 = await waitFor(host, type('viewer:request'), 'host request #4');
  send(host, { type: 'host:deny', viewerId: req4.viewerId });
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

  // ========== だれでも(token)モード: 承認なしで即接続 ==========
  const hostT = await open();
  send(hostT, { type: 'host:create', accessMode: 'token' });
  const sessT = await waitFor(hostT, type('session'), 'sessT');
  ok(sessT.accessMode === 'token', 'session に accessMode=token が乗る');
  const vt = await open();
  send(vt, { type: 'viewer:join', token: sessT.token });
  const accT = await waitFor(vt, type('accepted'), 'token accepted');
  ok(accT.type === 'accepted', 'token モードは承認なしで即 accepted');
  await waitFor(hostT, type('viewer:joined'), 'token viewer:joined');
  vt.close();
  hostT.close();

  // ========== 無期限（ttlMinutes=0） ==========
  const hostU = await open();
  send(hostU, { type: 'host:create', accessMode: 'token', ttlMinutes: 0 });
  const sessU = await waitFor(hostU, type('session'), 'sessU');
  ok(sessU.expiresAt === null, 'ttlMinutes=0 で expiresAt=null（無期限）');
  const vu = await open();
  send(vu, { type: 'viewer:join', token: sessU.token });
  const accU = await waitFor(vu, type('accepted'), 'unlimited accepted');
  ok(accU.type === 'accepted', '無期限セッションに接続できる（期限切れ扱いされない）');
  vu.close();
  hostU.close();

  // ========== 複数同時接続（maxViewers=2） ==========
  const host2 = await open();
  send(host2, { type: 'host:create', maxViewers: 2 });
  const sess2 = await waitFor(host2, type('session'), 'session2');

  // 2人を承認
  const a = await open();
  send(a, { type: 'viewer:join', token: sess2.token });
  const reqA = await waitFor(host2, type('viewer:request'), 'reqA');
  send(host2, { type: 'host:approve', viewerId: reqA.viewerId });
  await waitFor(a, type('accepted'), 'a accepted');
  const joinedA = await waitFor(host2, type('viewer:joined'), 'joinedA');

  const b = await open();
  send(b, { type: 'viewer:join', token: sess2.token });
  const reqB = await waitFor(host2, type('viewer:request'), 'reqB');
  send(host2, { type: 'host:approve', viewerId: reqB.viewerId });
  await waitFor(b, type('accepted'), 'b accepted');
  const joinedB = await waitFor(host2, type('viewer:joined'), 'joinedB');
  ok(joinedA.viewerId !== joinedB.viewerId, '複数ビューアに別々の viewerId が割り当たる');

  // 宛先指定の signal は当該ビューアだけに届く
  send(host2, { type: 'signal', to: reqA.viewerId, data: { sdp: 'TO-A' } });
  const aGot = await waitFor(a, type('signal'), 'a signal');
  ok(aGot.data.sdp === 'TO-A', 'signal は宛先ビューアに届く');
  await delay(300);
  ok(b.queue.findIndex(type('signal')) < 0, 'signal は宛先以外のビューアには届かない');

  // 上限到達で3人目は busy
  const c = await open();
  send(c, { type: 'viewer:join', token: sess2.token });
  const busy3 = await waitFor(c, type('error'), 'c error');
  ok(busy3.code === 'busy', 'maxViewers=2 で3人目は busy');
  c.close();

  // 1人切断 → ホストに viewer:left（viewerId 付き）。空き1でき、新規が入れる
  a.close();
  const leftA = await waitFor(host2, type('viewer:left'), 'viewer:left A');
  ok(leftA.viewerId === reqA.viewerId, 'viewer:left に切断 viewerId が乗る');
  const d = await open();
  send(d, { type: 'viewer:join', token: sess2.token });
  const reqD = await waitFor(host2, type('viewer:request'), 'reqD（空きができ再受付）');
  ok(!!reqD.viewerId, '1人抜けたら新規ビューアを受け付ける');
  d.close();
  b.close();
  host2.close();

  console.log(`\ntest-signaling.js: ALL PASS (${n} checks)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
