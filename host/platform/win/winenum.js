'use strict';
// desktopCapturer が列挙しないウィンドウ（特に他ウィンドウに owned された「付随ウィンドウ」）を
// 精密に拾うための Win32 列挙。koffi（プリビルド FFI）で user32 を直接叩く。
//
// なぜ必要か: Chromium は「owned かつ WS_EX_APPWINDOW を持たない」ウィンドウをピッカーから除外する。
// 一部アプリ（例: Qwatch Monitor）は映像を本体とは別の owned 最上位ウィンドウに描くため、
// 本体を選んでも映像が映らない。owner を見れば、その付随ウィンドウだけを安全に拾える。
//
// 失敗時の方針: koffi のロード/呼び出しに失敗しても enumerate() は [] を返す（呼び出し側は通常動作）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const RESIZE_LOG = path.join(os.tmpdir(), 'passist-resize.log');
function logResize(line) {
  try { fs.appendFileSync(RESIZE_LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {}
}

let enumerate = () => [];
let bringToFront = () => false; // 対象ウィンドウを最前面へ（koffi 失敗時は no-op）
let typeUnicode = () => false; // Unicode文字列を直接入力（koffi 失敗時は no-op）
let setWindowSize = () => ({ ok: false, w: 0, h: 0 }); // 対象ウィンドウのサイズ変更（koffi 失敗時は no-op）

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
  const IsWindowValid = user32.func('bool __stdcall IsWindow(intptr_t hwnd)'); // 既に閉じたHWNDへのAPI呼びを未然に防ぐ
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
  const GetWTPID = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)');
  const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
  const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
  // ウィンドウのサイズ変更（位置は維持）。 SWP_NOMOVE=2 SWP_NOZORDER=4 SWP_NOACTIVATE=0x10 SWP_FRAMECHANGED=0x20
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t insertAfter, int x, int y, int cx, int cy, uint flags)');
  // MoveWindow は SetWindowPos より単純で conhost のような特殊ウィンドウでも追従しやすい
  const MoveWindow = user32.func('bool __stdcall MoveWindow(intptr_t hwnd, int x, int y, int nWidth, int nHeight, bool bRepaint)');
  // 現サイズ取得用（intptr_t 版、ログ・差分判定のため）
  const GetWindowRectV = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)');
  // 画面サイズ取得（プライマリディスプレイ）。 SM_CXSCREEN=0, SM_CYSCREEN=1
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int idx)');

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
      if (!IsWindowValid(hwnd)) return false; // 既に閉じている HWND は触らない（Win32 API の連鎖失敗を防ぐ）
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

  // 対象ウィンドウのサイズを指定（位置は維持・最前面化しない・アクティブ化しない）。
  // viewer から「自分の表示エリアの幅×高さ」を受け取ってホスト窓を合わせるのに使う(S-2)。
  // conhost.exe (Command Prompt) のような特殊ウィンドウは SetWindowPos だけだと描画が追従しないため、
  // ①SWP_FRAMECHANGED でフレーム再計算 → ②MoveWindow(再描画あり) で位置も指定し直す、の二段構え。
  // GetWindowRect で前後サイズを取得してログに出す（調査用）。
  // ※ この関数は上の try ブロック内（SetWindowPos などが定義されているスコープ）で代入する。
  setWindowSize = function (hwnd, width, height) {
    try {
      hwnd = Number(hwnd);
      if (!hwnd) return false;
      if (!IsWindowValid(hwnd)) return false; // 既に閉じている
      width  = Math.max(120, Math.round(Number(width)  || 0));
      height = Math.max(80,  Math.round(Number(height) || 0));
      if (!width || !height) return false;

      // 画面サイズ（プライマリ）で上限 clamp。 ウィンドウフレーム/タスクバー分の余裕を残すため
      // 横は -16px、 縦は -48px ほど引く（タスクバー約40px想定）。
      let screenW = 1920, screenH = 1080;
      try { const sw = GetSystemMetrics(0), sh = GetSystemMetrics(1); if (sw > 0) screenW = sw; if (sh > 0) screenH = sh; } catch {}
      width  = Math.min(width,  Math.max(120, screenW - 16));
      height = Math.min(height, Math.max(80,  screenH - 48));

      // 前のサイズ・位置（MoveWindow に渡す x,y を保持するため）
      let prevX = 0, prevY = 0, prevW = 0, prevH = 0;
      try {
        const r = {};
        if (GetWindowRectV(hwnd, r)) { prevX = r.left; prevY = r.top; prevW = r.right - r.left; prevH = r.bottom - r.top; }
      } catch {}

      // 新サイズで画面外にはみ出すなら、 はみ出さない位置に補正（ウィンドウ右端/下端が画面内に収まるよう）
      let newX = prevX, newY = prevY;
      if (newX + width  > screenW) newX = Math.max(0, screenW - width);
      if (newY + height > screenH) newY = Math.max(0, screenH - height);

      // SWP_NOZORDER(0x4)|SWP_NOACTIVATE(0x10)|SWP_FRAMECHANGED(0x20) = 0x34（位置補正もする＝SWP_NOMOVE は外す）
      const okSwp = !!SetWindowPos(hwnd, 0, newX, newY, width, height, 0x34);
      // MoveWindow(再描画あり)。 conhost には特にこれが効く。
      const okMv = !!MoveWindow(hwnd, newX, newY, width, height, true);

      let afterW = 0, afterH = 0;
      try {
        const r = {};
        if (GetWindowRectV(hwnd, r)) { afterW = r.right - r.left; afterH = r.bottom - r.top; }
      } catch {}
      const summary = `setWindowSize hwnd=${hwnd} screen=${screenW}x${screenH} want=${width}x${height} at=(${newX},${newY}) before=${prevW}x${prevH}@(${prevX},${prevY}) after=${afterW}x${afterH} swp=${okSwp} mv=${okMv}`;
      console.log('[host] ' + summary);
      logResize(summary); // 配布exeでもファイルから確認できるよう %TEMP%\passist-resize.log にも追記
      // U-6: 呼出元が「押し戻し後の実サイズ」 を見て補正できるよう、 実サイズも返す。
      return { ok: okSwp || okMv, w: afterW, h: afterH };
    } catch (e) {
      console.warn('[host] setWindowSize threw:', e && e.message);
      return { ok: false, w: 0, h: 0 };
    }
  };
} catch (e) {
  console.warn('[host] winenum 無効（koffi ロード失敗 → owned 窓掲載/前面化なし）:', e && e.message);
}

module.exports = { enumerate, bringToFront, typeUnicode, setWindowSize, _logResize: logResize, _RESIZE_LOG: RESIZE_LOG };
