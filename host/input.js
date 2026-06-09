'use strict';
// ネイティブ入力注入（nut.js）。
// - 遠隔から来た正規化座標(0..1)を「対象ウィンドウの画面矩形」にマッピングして注入
// - ウィンドウ矩形外へは出さない（クランプ）
// - Windows キー / Alt+Tab など “デスクトップ脱出” キーはブロック
//
// 注意: ここは OS レベルの実入力（実カーソルが動く）。対象ウィンドウが他ウィンドウに
// 隠れていると、その矩形上に重なった別ウィンドウへ入力が当たり得る点に留意（README 参照）。

const nut = require('@nut-tree-fork/nut-js');
const { mouse, keyboard, Button, Key, Point, getWindows } = nut;
const winenum = require('./winenum'); // 対象ウィンドウの前面化（koffi）

let targetTitle = null;
let targetHandle = null; // 対象ウィンドウの HWND（厳密一致用）
let targetWindow = null; // 一致した nut.js Window（focus 用にキャッシュ）
let region = null; // { left, top, width, height }
let lastRegionAt = 0; // 最後に region を更新した時刻
let refreshing = false; // 同時リフレッシュ防止

async function init() {
  mouse.config.mouseSpeed = 100000; // ほぼ即時移動
  keyboard.config.autoDelayMs = 0;
  // ※ 旧実装は 700ms ごとに getWindows() で全ウィンドウ列挙していたが、長時間稼働の
  //    負荷源になるため廃止。入力時にだけ遅延更新する（アイドル時は何もしない）。
}

// sourceId は Electron desktopCapturer の "window:<HWND>:0"。HWND を取り出して厳密一致に使う。
function setTarget(name, sourceId) {
  targetTitle = name || null;
  targetHandle = parseHandle(sourceId);
  targetWindow = null;
  region = null;
  lastRegionAt = 0;
  maybeRefresh(true);
}

// region が古ければ非ブロッキングで更新（アイドル時は走らない＝常時ポーリングしない）
function maybeRefresh(force) {
  if (refreshing) return;
  if (!force && Date.now() - lastRegionAt < 1500) return;
  refreshing = true;
  refreshRegion()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
      lastRegionAt = Date.now();
    });
}

function parseHandle(sourceId) {
  const m = /^window:(\d+):/.exec(String(sourceId || ''));
  return m ? Number(m[1]) : null;
}

// 0x0 や極端に小さい矩形（非表示/最小化）は無効として弾く（誤って画面隅へマップしないため）
const validRegion = (r) => r && r.width >= 8 && r.height >= 8;

async function refreshRegion() {
  if (targetHandle == null && !targetTitle) return;
  const wins = await getWindows();

  // 1) HWND で厳密一致（高速・文字コード非依存）。タイトル取得は不要。
  if (targetHandle != null) {
    for (const w of wins) {
      if (Number(w.windowHandle) === targetHandle) {
        const r = await w.getRegion();
        if (validRegion(r)) {
          targetWindow = w;
          region = { left: r.left, top: r.top, width: r.width, height: r.height };
        }
        return;
      }
    }
  }

  // 2) フォールバック: タイトル一致（HWND が取れない場合のみ）
  if (targetTitle) {
    for (const w of wins) {
      let title = '';
      try {
        title = await w.getTitle();
      } catch {
        continue;
      }
      if (title && (title === targetTitle || title.includes(targetTitle) || targetTitle.includes(title))) {
        const r = await w.getRegion();
        if (validRegion(r)) {
          targetWindow = w;
          region = { left: r.left, top: r.top, width: r.width, height: r.height };
          return;
        }
      }
    }
  }
  // 見つからなければ直前の有効な region を維持（瞬間的な取得失敗で操作不能にしない）
}

// 操作開始時に対象ウィンドウを前面化（他ウィンドウに隠れていると入力が別窓に当たるため）
async function focusTarget() {
  try {
    if (targetHandle != null) winenum.bringToFront(targetHandle); // 確実に最前面へ（koffi、前面化制限を回避）
    if (!targetWindow) await refreshRegion();
    if (targetWindow) await targetWindow.focus();
  } catch {
    /* focus 失敗は無視 */
  }
}

function toScreen(nx, ny) {
  if (!region) return null;
  const cx = Math.min(Math.max(nx, 0), 1);
  const cy = Math.min(Math.max(ny, 0), 1);
  return new Point(Math.round(region.left + cx * region.width), Math.round(region.top + cy * region.height));
}

const btn = (b) => (b === 2 ? Button.RIGHT : b === 1 ? Button.MIDDLE : Button.LEFT);

// “脱出” 防止のためブロックするキー組み合わせ
function blocked(code, mods = {}) {
  if (code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight') return true; // Windows キー
  if (mods.meta) return true; // Win+任意
  if (mods.alt && code === 'Tab') return true; // Alt+Tab
  if (mods.alt && code === 'F4') return true; // Alt+F4
  if (mods.alt && code === 'Escape') return true; // Alt+Esc
  if (mods.ctrl && code === 'Escape') return true; // Ctrl+Esc（スタート）
  if (mods.ctrl && mods.shift && code === 'Escape') return true; // タスクマネージャ
  return false;
}

// KeyboardEvent.code -> nut Key
const CODE_MAP = {
  Backspace: Key.Backspace,
  Tab: Key.Tab,
  Enter: Key.Enter,
  NumpadEnter: Key.Enter,
  ShiftLeft: Key.LeftShift,
  ShiftRight: Key.RightShift,
  ControlLeft: Key.LeftControl,
  ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt,
  AltRight: Key.RightAlt,
  Escape: Key.Escape,
  Space: Key.Space,
  ArrowLeft: Key.Left,
  ArrowUp: Key.Up,
  ArrowRight: Key.Right,
  ArrowDown: Key.Down,
  Home: Key.Home,
  End: Key.End,
  PageUp: Key.PageUp,
  PageDown: Key.PageDown,
  Insert: Key.Insert,
  Delete: Key.Delete,
  CapsLock: Key.CapsLock,
  Minus: Key.Minus,
  Equal: Key.Equal,
  BracketLeft: Key.LeftBracket,
  BracketRight: Key.RightBracket,
  Backslash: Key.Backslash,
  Semicolon: Key.Semicolon,
  Quote: Key.Quote,
  Backquote: Key.Grave,
  Comma: Key.Comma,
  Period: Key.Period,
  Slash: Key.Slash,
};
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(65 + i); // A..Z
  CODE_MAP['Key' + c] = Key[c];
}
for (let i = 0; i <= 9; i++) {
  CODE_MAP['Digit' + i] = Key['Num' + i];
  if (Key['NumPad' + i] !== undefined) CODE_MAP['Numpad' + i] = Key['NumPad' + i];
}
for (let i = 1; i <= 12; i++) {
  if (Key['F' + i] !== undefined) CODE_MAP['F' + i] = Key['F' + i];
}

async function handle(ev) {
  try {
    switch (ev.t) {
      case 'm': {
        maybeRefresh(); // 古ければ次回用に更新（非ブロッキング・アイドル時は走らない）
        const p = toScreen(ev.x, ev.y);
        if (p) await mouse.setPosition(p);
        break;
      }
      case 'd':
        if (targetHandle != null) winenum.bringToFront(targetHandle); // クリック先が常に対象ウィンドウになるよう最前面化（既に最前面ならskip）
        await mouse.pressButton(btn(ev.b));
        break;
      case 'u':
        await mouse.releaseButton(btn(ev.b));
        break;
      case 'w': {
        if (targetHandle != null) winenum.bringToFront(targetHandle); // スクロール先を対象ウィンドウに（既に最前面ならskip）
        if (ev.dy) {
          const a = Math.max(1, Math.round(Math.abs(ev.dy) / 40));
          if (ev.dy > 0) await mouse.scrollDown(a);
          else await mouse.scrollUp(a);
        }
        if (ev.dx) {
          const a = Math.max(1, Math.round(Math.abs(ev.dx) / 40));
          if (ev.dx > 0) await mouse.scrollRight(a);
          else await mouse.scrollLeft(a);
        }
        break;
      }
      case 'text': {
        // 確定済みテキスト（日本語含む）を Unicode 直接入力（SendInput）。ホストのIME/キーボード配列に依存しない。
        if (typeof ev.s === 'string' && ev.s.length > 0 && ev.s.length <= 2000) {
          if (targetHandle != null) winenum.bringToFront(targetHandle); // 入力先を対象ウィンドウに
          if (!winenum.typeUnicode(ev.s)) await keyboard.type(ev.s); // 失敗時のみ nut フォールバック
        }
        break;
      }
      case 'edit': {
        // 右クリックメニューのコピー/切り取り/貼り付け。Ctrl+C/X/V を順序保証で送る。
        const m = { copy: Key.C, cut: Key.X, paste: Key.V };
        const k = m[ev.a];
        if (k !== undefined) {
          await keyboard.pressKey(Key.LeftControl);
          await keyboard.pressKey(k);
          await keyboard.releaseKey(k);
          await keyboard.releaseKey(Key.LeftControl);
        }
        break;
      }
      case 'k': {
        if (blocked(ev.code, ev.mods || {})) return;
        const key = CODE_MAP[ev.code];
        if (key !== undefined) {
          if (ev.down) await keyboard.pressKey(key);
          else await keyboard.releaseKey(key);
        } else if (ev.down && typeof ev.key === 'string' && ev.key.length === 1) {
          // マップ外の印字可能文字は Unicode 直接入力（失敗時のみ nut）
          if (!winenum.typeUnicode(ev.key)) await keyboard.type(ev.key);
        }
        break;
      }
    }
  } catch {
    // 個々の注入失敗は無視（接続は維持）
  }
}

module.exports = { init, setTarget, handle, focusTarget };
