'use strict';
// macOS プラットフォーム実装の集約。
// 現状はヘッドレスCIで起動が通ることを目標としたスケルトン。
// - ウィンドウ列挙: Chromium の desktopCapturer が owned ウィンドウも正しく扱うため補完不要 → []
// - 前面化: AppleScript (System Events) で対象プロセスを activate（PID 必要なので handle の意味は要設計）
// - Unicode入力: SendInput 等価が無いため nut.js にフォールバック前提（false 固定）
// - カーソル形状: NSCursor 経由は ObjC ランタイムが必要 → 暫定で "arrow" 通知 1回のみ
// - UPnP: HNetCfg COM が無いため未サポート

const windows = require('./windows');
const cursorshape = require('./cursorshape');

module.exports = {
  windows: {
    enumerate: windows.enumerate,
    bringToFront: windows.bringToFront,
    typeUnicode: windows.typeUnicode,
    setWindowSize: windows.setWindowSize, // mac は no-op
    parseHandle(sourceId) {
      // macOS の desktopCapturer も "window:<id>:0" 形式。中身は CGWindowID。
      const m = /^window:(\d+):/.exec(String(sourceId || ''));
      return m ? Number(m[1]) : null;
    },
    matchHandle(_nutWindow, _handle) {
      // 暫定: handle 一致は未実装（input.js はタイトル一致フォールバックへ落ちる）
      return false;
    },
  },
  cursor: {
    start: cursorshape.start,
    stop: cursorshape.stop,
  },
  portmap: {
    supported: false,
    open: () => Promise.reject(new Error('UPnP port mapping is not supported on macOS')),
    close: () => Promise.resolve('UNSUPPORTED'),
  },
};
