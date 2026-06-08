'use strict';
// 信頼ストアの単体テスト:  node host/trust.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trust = require('./trust');

const tmp = path.join(os.tmpdir(), 'passist-trust-test-' + process.pid + '.json');
function cleanup() {
  try { fs.unlinkSync(tmp); } catch {}
}
cleanup();

let n = 0;
const ok = (c, m) => {
  assert.ok(c, 'FAIL: ' + m);
  n++;
  console.log('  ok - ' + m);
};

trust.init(tmp);
ok(trust.list().length === 0, '初期状態は空');

const cred = trust.issue('テスト端末');
ok(cred.clientId && cred.secret, 'issue が clientId と secret を返す');
ok(trust.list().length === 1, '信頼リストに1件');

ok(trust.check(cred).trusted === true, '正しいクレデンシャルは信頼される');
ok(trust.check(cred).label === 'テスト端末', 'ラベルが返る');
ok(trust.check({ clientId: cred.clientId, secret: 'wrong' }).trusted === false, '誤った secret は拒否');
ok(trust.check({ clientId: 'unknown', secret: cred.secret }).trusted === false, '未知の clientId は拒否');
ok(trust.check(null).trusted === false, 'null は拒否');
ok(trust.check({}).trusted === false, '空オブジェクトは拒否');

// 永続化: ファイルから再読込しても有効
trust.init(tmp);
ok(trust.check(cred).trusted === true, 'init 再読込後も信頼が残る');

trust.remove(cred.clientId);
ok(trust.check(cred).trusted === false, 'remove で失効');

trust.issue('a');
trust.issue('b');
ok(trust.list().length === 2, '複数発行で2件');
trust.clear();
ok(trust.list().length === 0, 'clear で全消去');

cleanup();
console.log(`\ntrust.test.js: ALL PASS (${n} checks)`);
