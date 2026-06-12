'use strict';
// Windows プラットフォーム実装の集約。
// 各サブモジュールは koffi/PowerShell ロード失敗時にも no-op で通る作りなので、
// ここで try/catch せずそのまま参照する。

const winenum = require('./winenum');
const cursorshape = require('./cursorshape');
const portmap = require('./portmap');

module.exports = {
  windows: {
    enumerate: winenum.enumerate,
    bringToFront: winenum.bringToFront,
    typeUnicode: winenum.typeUnicode,
    setWindowSize: winenum.setWindowSize, // viewer 画面比率にホスト窓を合わせる（S-2）
    getWindowRect: winenum.getWindowRect, // V-3 サイズ調整 OFF で元サイズに復元するための取得
    _logResize: winenum._logResize,      // デバッグ用: %TEMP%\passist-resize.log への追記関数（S-2.3）
    _RESIZE_LOG: winenum._RESIZE_LOG,
    // desktopCapturer の sourceId は Win では "window:<HWND>:0"。HWND を数値で取り出す。
    parseHandle(sourceId) {
      const m = /^window:(\d+):/.exec(String(sourceId || ''));
      return m ? Number(m[1]) : null;
    },
    // nut.js Window と HWND の厳密一致（文字コード非依存・高速）。
    matchHandle(nutWindow, handle) {
      try {
        return Number(nutWindow.windowHandle) === Number(handle);
      } catch {
        return false;
      }
    },
  },
  cursor: {
    start: cursorshape.start,
    stop: cursorshape.stop,
  },
  portmap: {
    supported: true,
    open: portmap.open,
    close: portmap.close,
  },
};
