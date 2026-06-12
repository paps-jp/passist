'use strict';
// macOS のカーソル形状検出スケルトン。
// NSCursor.currentCursor 経由は Swift/ObjC ランタイムが必要なため、最低限の起動互換を優先。
// - start: 何もしない（コールバックは呼ばない）
// - stop: 何もしない
// 将来的には osascript + System Events、または Swift helper binary 経由で実装予定。

function start(_callback) {
  // no-op
}

function stop() {
  // no-op
}

module.exports = { start, stop };
