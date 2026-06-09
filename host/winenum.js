'use strict';
// desktopCapturer が列挙しないウィンドウ（特に他ウィンドウに owned された「付随ウィンドウ」）を
// 精密に拾うための Win32 列挙。koffi（プリビルド FFI）で user32 を直接叩く。
//
// なぜ必要か: Chromium は「owned かつ WS_EX_APPWINDOW を持たない」ウィンドウをピッカーから除外する。
// 一部アプリ（例: Qwatch Monitor）は映像を本体とは別の owned 最上位ウィンドウに描くため、
// 本体を選んでも映像が映らない。owner を見れば、その付随ウィンドウだけを安全に拾える。
//
// 失敗時の方針: koffi のロード/呼び出しに失敗しても enumerate() は [] を返す（呼び出し側は通常動作）。

let enumerate = () => [];

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const WNDENUMPROC = koffi.proto('bool __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)');

  const EnumWindows = user32.func('bool __stdcall EnumWindows(WNDENUMPROC *proc, intptr_t lParam)');
  const GetWindow = user32.func('void* __stdcall GetWindow(void *hwnd, uint cmd)');
  const GetWindowLongW = user32.func('long __stdcall GetWindowLongW(void *hwnd, int index)');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *str, int max)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');

  const GW_OWNER = 4;
  const GWL_EXSTYLE = -20;
  const addr = (p) => { try { return Number(koffi.address(p)); } catch { return 0; } };

  enumerate = function () {
    const out = [];
    const cb = koffi.register((hwnd) => {
      try {
        const r = {};
        if (!GetWindowRect(hwnd, r)) return true;
        const exStyle = GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0;
        const owner = addr(GetWindow(hwnd, GW_OWNER));
        const pidOut = [0];
        GetWindowThreadProcessId(hwnd, pidOut);
        const buf = Buffer.alloc(512 * 2);
        const n = GetWindowTextW(hwnd, buf, 512);
        out.push({
          hwnd: addr(hwnd),
          owner,
          exStyle,
          pid: pidOut[0] >>> 0,
          visible: !!IsWindowVisible(hwnd),
          iconic: !!IsIconic(hwnd),
          title: n > 0 ? buf.toString('utf16le', 0, n * 2) : '',
          width: r.right - r.left,
          height: r.bottom - r.top,
        });
      } catch {}
      return true; // 列挙を継続
    }, koffi.pointer(WNDENUMPROC));
    try {
      EnumWindows(cb, 0);
    } finally {
      koffi.unregister(cb);
    }
    return out;
  };
} catch (e) {
  console.warn('[host] winenum 無効（koffi ロード失敗 → owned 窓の自動掲載なし）:', e && e.message);
}

module.exports = { enumerate };
