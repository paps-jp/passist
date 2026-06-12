'use strict';
// macOS のウィンドウ管理スケルトン。
// - enumerate: desktopCapturer が owned ウィンドウも列挙するため、補完は不要（空配列）
// - bringToFront: AppleScript で対象 PID を frontmost にする
//   ※ handle は CGWindowID なので PID を引くには CGWindowListCopyWindowInfo が必要。
//      暫定で未実装（no-op）。将来 koffi + ApplicationServices で実装する想定。
// - typeUnicode: SendInput 相当が無い。nut.js の keyboard.type にフォールバックさせるため false 固定。

function enumerate() {
  return [];
}

function bringToFront(_handle) {
  // TODO: CGWindowID → PID → osascript で activate
  return false;
}

function typeUnicode(_str) {
  return false;
}

module.exports = { enumerate, bringToFront, typeUnicode };
