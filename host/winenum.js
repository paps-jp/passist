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
let bringToFront = () => false; // 対象ウィンドウを最前面へ（koffi 失敗時は no-op）
let typeUnicode = () => false; // Unicode文字列を直接入力（koffi 失敗時は no-op）

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

  // 前面化用（hwnd を数値で渡せる intptr_t 版）
  const kernel32 = koffi.load('kernel32.dll');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int nCmdShow)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
  const GetWTPID = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)');
  const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
  const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');

  // Unicode テキスト入力（SendInput + KEYEVENTF_UNICODE）。キーボードレイアウト非依存で日本語等を正しく入力。
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U });
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');

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

  // 対象ウィンドウを最前面へ。既に最前面なら何もしない。AttachThreadInput で前面化制限を回避。
  bringToFront = function (hwnd) {
    try {
      hwnd = Number(hwnd);
      if (!hwnd) return false;
      if (Number(GetForegroundWindow()) === hwnd) return true; // 既に最前面
      ShowWindow(hwnd, 9); // SW_RESTORE（最小化なら復元しつつ表示）
      const cur = GetCurrentThreadId();
      const fgThread = GetWTPID(Number(GetForegroundWindow()), [0]);
      let attached = false;
      if (fgThread && fgThread !== cur) attached = !!AttachThreadInput(cur, fgThread, true);
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      if (attached) AttachThreadInput(cur, fgThread, false);
      return true;
    } catch {
      return false;
    }
  };

  // Unicode 文字列を前面ウィンドウへ直接入力（日本語等もレイアウト非依存で正しく入る）
  typeUnicode = function (str) {
    try {
      if (typeof str !== 'string' || !str.length) return false;
      const KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
      const inputs = [];
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i); // UTF-16 コード単位（サロゲートはそのまま順送り）
        inputs.push({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } });
        inputs.push({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } });
      }
      return SendInput(inputs.length, inputs, koffi.sizeof(INPUT)) === inputs.length;
    } catch {
      return false;
    }
  };
} catch (e) {
  console.warn('[host] winenum 無効（koffi ロード失敗 → owned 窓掲載/前面化なし）:', e && e.message);
}

module.exports = { enumerate, bringToFront, typeUnicode };
