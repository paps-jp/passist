'use strict';
// util.js の純粋関数を node 標準テストランナーで検証する（追加依存なし）。
// 実行: `node --test server/test-util.js` または `cd server && node --test`

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeBase, clampMaxViewers, calcBitrate } = require('./util');

test('sanitizeBase: 有効な http/https は末尾スラッシュを落として返す', () => {
  assert.equal(sanitizeBase('https://example.com'), 'https://example.com');
  assert.equal(sanitizeBase('http://example.com'), 'http://example.com');
  assert.equal(sanitizeBase('https://example.com/'), 'https://example.com');
  assert.equal(sanitizeBase('https://example.com:8443/'), 'https://example.com:8443');
  assert.equal(sanitizeBase('https://example.com//'), 'https://example.com');
  assert.equal(sanitizeBase('https://usagi.paps.jp'), 'https://usagi.paps.jp');
});

test('sanitizeBase: 不正なURLは空文字を返す（LANフォールバックの引き金）', () => {
  assert.equal(sanitizeBase(''), '');
  assert.equal(sanitizeBase('not-a-url'), '');
  assert.equal(sanitizeBase('ftp://example.com'), '');
  assert.equal(sanitizeBase('ws://example.com'), '');
  assert.equal(sanitizeBase('javascript:alert(1)'), '');
  // 過去ハマったタイポ。usagi の直後が ':' なので不正
  assert.equal(sanitizeBase('https://usagi:paps.jp'), '');
});

test('sanitizeBase: 異常入力でも例外を出さず空文字', () => {
  assert.equal(sanitizeBase(undefined), '');
  assert.equal(sanitizeBase(null), '');
  assert.equal(sanitizeBase(123), '');
  assert.equal(sanitizeBase({}), '');
});

test('clampMaxViewers: 1〜8 の範囲に収まる', () => {
  assert.equal(clampMaxViewers(1), 1);
  assert.equal(clampMaxViewers(4), 4);
  assert.equal(clampMaxViewers(8), 8);
  assert.equal(clampMaxViewers(0), 1);          // 下限
  assert.equal(clampMaxViewers(-100), 1);       // 下限
  assert.equal(clampMaxViewers(9), 8);          // 上限
  assert.equal(clampMaxViewers(1000), 8);       // 上限
  assert.equal(clampMaxViewers('3'), 3);        // 文字列もパース
});

test('clampMaxViewers: 数値化できない入力は 1', () => {
  assert.equal(clampMaxViewers('abc'), 1);
  assert.equal(clampMaxViewers(null), 1);
  assert.equal(clampMaxViewers(undefined), 1);
  assert.equal(clampMaxViewers(NaN), 1);
  assert.equal(clampMaxViewers({}), 1);
});

test('calcBitrate: relayCount=0 は実害ゼロなので最大値を返す', () => {
  assert.equal(calcBitrate(0, 4_000_000, 100_000, 1_500_000), 1_500_000);
  assert.equal(calcBitrate(-1, 4_000_000, 100_000, 1_500_000), 1_500_000); // 負も同じ扱い
  assert.equal(calcBitrate(NaN, 4_000_000, 100_000, 1_500_000), 1_500_000);
});

test('calcBitrate: 通常分割', () => {
  // 1人 → budget 全部だが上限で頭打ち
  assert.equal(calcBitrate(1, 4_000_000, 100_000, 1_500_000), 1_500_000);
  // 4人 → 1Mbps（上限以下）
  assert.equal(calcBitrate(4, 4_000_000, 100_000, 1_500_000), 1_000_000);
  // 5人 → 800kbps
  assert.equal(calcBitrate(5, 4_000_000, 100_000, 1_500_000), 800_000);
  // 40人 → 100kbps（下限ぎりぎり）
  assert.equal(calcBitrate(40, 4_000_000, 100_000, 1_500_000), 100_000);
});

test('calcBitrate: budget を超える分割は下限で頭打ち', () => {
  // 100人 → 40k → 100k に持ち上げ
  assert.equal(calcBitrate(100, 4_000_000, 100_000, 1_500_000), 100_000);
  // 10000人 → 400 → 100k
  assert.equal(calcBitrate(10_000, 4_000_000, 100_000, 1_500_000), 100_000);
});

test('calcBitrate: budget=0 は下限を返す', () => {
  assert.equal(calcBitrate(5, 0, 100_000, 1_500_000), 100_000);
});

test('calcBitrate: 小数結果は floor される', () => {
  // 4_000_000 / 3 = 1_333_333.33... → 1_333_333
  assert.equal(calcBitrate(3, 4_000_000, 100_000, 1_500_000), 1_333_333);
});
