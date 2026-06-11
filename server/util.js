'use strict';
// シグナリングサーバから副作用を分離した純粋関数群。
// server.js は内部に同名のラッパを置かず、ここから直接 require する。テストはこのファイル単体で完結する。

// 入力 URL を共有ベース URL として正規化する。
// - http:/https: 以外（ftp/ws/data/壊れた文字列等）は ''
// - 末尾の / を取り除く
// - 過去ハマった例: "https://usagi:paps.jp" のような不正URLは '' に落とす
function sanitizeBase(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return String(u).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// 同時接続できるビューア数を 1〜8 の範囲に clamp する。数値以外は 1。
function clampMaxViewers(n) {
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(8, Math.max(1, v)) : 1;
}

// TURN(relay) 経由ピア向けの 1接続あたり上限 bitrate を計算する純粋関数。
// 同時接続数(relayCount)が 0 のときは上限値(=実害なし)を返す。
// それ以外は budget を頭割りし、minBps〜maxBps の範囲に clamp する。
function calcBitrate(relayCount, budgetBps, minBps, maxBps) {
  if (!Number.isFinite(relayCount) || relayCount <= 0) return maxBps;
  const v = Math.floor(budgetBps / relayCount);
  return Math.max(minBps, Math.min(maxBps, v));
}

module.exports = { sanitizeBase, clampMaxViewers, calcBitrate };
