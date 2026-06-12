'use strict';
// プラットフォーム抽象化レイヤ。process.platform で分岐して win/mac の実装を返す。
// 抽象API:
//   platform.windows.enumerate()                    → ウィンドウ列挙（owned 補完用）
//   platform.windows.bringToFront(handle)           → 対象ウィンドウを最前面へ
//   platform.windows.typeUnicode(str)               → IME/レイアウト非依存の Unicode 入力
//   platform.windows.parseHandle(sourceId)          → desktopCapturer の sourceId からネイティブ handle 抽出
//   platform.windows.matchHandle(nutWin, handle)    → nut.js Window と handle の同一性判定
//   platform.cursor.start(cb) / stop()              → カーソル形状の変化通知
//   platform.portmap.supported                      → UPnP ポートマップが使えるか
//   platform.portmap.open(port, opts) / close()     → UPnP ポート開閉
//
// 未対応プラットフォーム（例: linux）は mac 実装（最も無害な no-op 集合）にフォールバックする。

let impl;
switch (process.platform) {
  case 'win32':
    impl = require('./win');
    break;
  case 'darwin':
    impl = require('./mac');
    break;
  default:
    console.warn(`[platform] unsupported platform "${process.platform}" — falling back to mac (no-op) impl`);
    impl = require('./mac');
}

module.exports = impl;
