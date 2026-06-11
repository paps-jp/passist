'use strict';
// Electron メインプロセス。
// - 開いている「ウィンドウ」だけを列挙（screen は一切扱わない → デスクトップ全体は出せない）
// - 選択ウィンドウのキャプチャ要求に応える
// - レンダラから来た入力イベントをネイティブ注入モジュールへ橋渡し
// - 開発時はシグナリングサーバを子プロセスとして自動起動

const { app, BrowserWindow, desktopCapturer, session, ipcMain, Tray, Menu, nativeImage, shell, dialog, nativeTheme, clipboard, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const trust = require('./trust');
const portmap = require('./portmap');
const settings = require('./settings');
const cursorshape = require('./cursorshape');
const winenum = require('./winenum'); // owned 窓（付随ウィンドウ）を精密に列挙して一覧へ補う
const QRCode = require('qrcode'); // 共有URLのQRコード生成（スマホで読み取って接続）

// クラッシュ理由を %TEMP%\passist-crash.log に記録（異常終了の原因切り分け用）
function crashLog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('temp'), 'passist-crash.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
  console.error('[host] ' + msg);
}
let lastRendererRecover = 0;
app.on('render-process-gone', (_e, _wc, d) => {
  crashLog('render-process-gone ' + JSON.stringify(d));
  // レンダラがクラッシュしても自動復帰（クラッシュループ防止に最短5秒間隔）
  if (d && d.reason !== 'clean-exit' && Date.now() - lastRendererRecover > 5000) {
    lastRendererRecover = Date.now();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      else {
        mainWindow = null;
        createWindow();
      }
    } catch (err) {
      crashLog('recover failed ' + err.message);
    }
  }
});
app.on('child-process-gone', (_e, d) => crashLog('child-process-gone ' + JSON.stringify(d)));
process.on('uncaughtException', (e) => crashLog('uncaughtException ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (r) => crashLog('unhandledRejection ' + (r && r.stack ? r.stack : r)));

const REMOTE_SERVER_URL = process.env.REMOTE_SERVER_URL || ''; // 例: wss://example.com/ws（外部サーバ利用時）
let serverPort = parseInt(process.env.PORT || '8443', 10); // settings.init 後に確定
let signalWs = REMOTE_SERVER_URL || `ws://127.0.0.1:${serverPort}/ws`;

// 設定の serverMode に応じて signalWs を再計算（起動時・設定変更時に呼ぶ）
function computeSignalWs() {
  if (REMOTE_SERVER_URL) return REMOTE_SERVER_URL;
  const s = settings.get();
  if (s.serverMode === 'self') return `ws://127.0.0.1:${serverPort}/ws`;
  return s.centralServerUrl || 'wss://passist.paps.jp/ws';
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverProc = null;
let selectedSourceId = null;
let selectedSourceName = null;

// 入力注入（ネイティブ依存）。読み込み/初期化に失敗したら「閲覧のみ」で継続。
let input = null;
let inputReady = false;
try {
  input = require('./input');
  input
    .init()
    .then(() => {
      inputReady = true;
      console.log('[host] input injection enabled');
    })
    .catch((e) => {
      console.warn('[host] input init failed → 閲覧のみ:', e.message);
      input = null;
    });
} catch (e) {
  console.warn('[host] input module unavailable → 閲覧のみ:', e.message);
  input = null;
}

function maybeSpawnServer() {
  if (REMOTE_SERVER_URL) return; // 外部サーバを使う場合は起動しない
  // 開発時は ../server、パッケージ時は resources/server（extraResources で同梱）
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'server.js')
    : path.join(__dirname, '..', 'server', 'server.js');
  const s = settings.get();
  serverProc = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(serverPort),
      ACCESS_MODE: s.accessMode,
      SESSION_TTL_MS: String(s.sessionTtlMinutes * 60000),
      // 設定の公開URL（トンネル等）を優先。無ければ UPnP 検出の公開URL。
      PUBLIC_BASE_URL: s.publicBaseUrl || publicBaseUrl || '',
    },
    stdio: 'pipe',
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('exit', (code) => console.log(`[host] signaling server exited: ${code}`));
}

// 安全網: getDisplayMedia が使われた場合でも、選択済みウィンドウ以外は渡さない。
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['window'] }) // ★ 'screen' を含めない
        .then((sources) => {
          const chosen = sources.find((s) => s.id === selectedSourceId);
          if (chosen) return callback({ video: chosen });
          // owned 窓など getSources に出ない対象は、選択済み ID から自作ソースで返す。
          // 返すのは capture:select で固定された selectedSourceId のみ（任意ウィンドウは渡さない）。
          if (selectedSourceId) return callback({ video: { id: selectedSourceId, name: selectedSourceName || 'PAssist' } });
          callback({});
        })
        .catch(() => {
          if (selectedSourceId) callback({ video: { id: selectedSourceId, name: selectedSourceName || 'PAssist' } });
          else callback({});
        });
    },
    { useSystemPicker: false },
  );
}

ipcMain.handle('windows:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'], // ★ ウィンドウのみ
    fetchWindowIcons: true,
    thumbnailSize: { width: 320, height: 200 },
  });
  const named = sources.filter((s) => s.name && s.name.trim().length > 0);
  const list = named.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  }));

  // owned 窓（付随ウィンドウ）の自動掲載。
  // Chromium は「owned かつ非 WS_EX_APPWINDOW」をピッカーから除外するため、
  // 映像を別の owned 最上位ウィンドウに描くアプリ（例: Qwatch Monitor の CameraViewWindow）が出ない。
  // 所有者が「一覧に出ている共有可能ウィンドウ」である owned 窓だけを精密に補う（ゴミは出さない）。
  try {
    const hwndOf = (id) => { const m = /^window:(\d+):/.exec(id); return m ? Number(m[1]) : null; };
    const listed = new Map(); // owner 判定用: hwnd -> source
    for (const s of named) { const h = hwndOf(s.id); if (h != null) listed.set(h, s); }
    const seen = new Set(listed.keys());
    const WS_EX_TOOLWINDOW = 0x80;
    for (const w of winenum.enumerate()) {
      if (!w.visible || w.iconic) continue;
      if (w.owner === 0) continue; // 独立窓は対象外（owned のみ）
      if (!listed.has(w.owner)) continue; // 所有者が共有可能な掲載ウィンドウであること
      if (seen.has(w.hwnd)) continue; // 既に一覧にある
      if (w.exStyle & WS_EX_TOOLWINDOW) continue; // ツールチップ等
      if (w.width < 200 || w.height < 150) continue;
      if (!w.title || !w.title.trim()) continue;
      seen.add(w.hwnd);
      const ownerSrc = listed.get(w.owner);
      list.push({
        id: `window:${w.hwnd}:0`,
        name: w.title,
        thumbnail: null,
        appIcon: ownerSrc && ownerSrc.appIcon && !ownerSrc.appIcon.isEmpty() ? ownerSrc.appIcon.toDataURL() : null,
        owned: true,
        ownerName: ownerSrc ? ownerSrc.name : '',
      });
    }
  } catch (e) {
    console.warn('[host] owned 窓の列挙に失敗:', e && e.message);
  }
  return list;
});

ipcMain.handle('capture:select', (_e, { id, name }) => {
  selectedSourceId = id;
  selectedSourceName = name;
  if (input) input.setTarget(name, id); // id = "window:<HWND>:0" を渡して HWND 一致させる
  return true;
});

ipcMain.handle('input:focus', () => {
  if (settings.get().readonly) return; // 閲覧のみ：前面化（操作系）はしない
  if (input) return input.focusTarget();
});

// 現在フォーカスされているテキストフィールドの値をクリップボード経由で取得して返す。
// 用途: viewer 側でカーソルが ibeam の場所をタップ→既存値を取って編集ダイアログに表示する。
// 副作用: 一瞬クリップボードを書き換えるが、終了時に元の値を復元する。
ipcMain.handle('input:readSelected', async () => {
  if (settings.get().readonly) return '';
  if (!input || !input.selectAndCopy) return '';
  let backup = '';
  try { backup = clipboard.readText() || ''; } catch {}
  try {
    await input.selectAndCopy(); // Ctrl+A + Ctrl+C
    await new Promise((r) => setTimeout(r, 120)); // OS のクリップボード反映待ち
    const v = (() => { try { return clipboard.readText() || ''; } catch { return ''; } })();
    lastClip = v; // 自分が書いたクリップ変更を「外部から来た」扱いしない（broadcast抑制）
    return v;
  } finally {
    try { clipboard.writeText(backup); lastClip = backup; } catch {} // ユーザーのクリップを必ず復元
  }
});

ipcMain.handle('config:get', () => ({ signalWs, inputEnabled: !!input && inputReady, settings: settings.get(), palette: getSystemPalette() }));
ipcMain.handle('qr:make', async (_e, text) => {
  try { return await QRCode.toDataURL(String(text || ''), { margin: 1, width: 240 }); } catch { return null; }
});
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const res = settings.set(patch || {});
  signalWs = computeSignalWs(); // serverMode/centralServerUrl の変更を反映（再起動で完全反映）
  return res;
});

// Windows のテーマ/アクセント色が変わったらレンダラへ新パレットを送る
nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('theme:palette', getSystemPalette());
});

ipcMain.on('input:event', (_e, ev) => {
  if (settings.get().readonly) return; // 閲覧のみ：操作入力は無視（クライアントを信用しない最終防壁）
  if (input) input.handle(ev);
});

// --- 信頼済み端末（事前承認） ---
ipcMain.handle('trust:check', (_e, auth) => trust.check(auth));
ipcMain.handle('trust:issue', (_e, label) => trust.issue(label));
ipcMain.handle('trust:list', () => trust.list());
ipcMain.handle('trust:remove', (_e, clientId) => trust.remove(clientId));
ipcMain.handle('trust:clear', () => trust.clear());

// インターネット公開: 起動時に UPnP で Web ポート(TCP)を開け、公開IP付きの共有URLを使う。
// 既定で有効。PASSIST_PUBLIC=0 で無効（同一LAN内のみ）。外部サーバ利用時(REMOTE_SERVER_URL)は対象外。
let publicBaseUrl = '';
let portTimer = null;

async function openPublicPort() {
  if (!settings.get().publicMode || REMOTE_SERVER_URL || process.platform !== 'win32') return;
  const portNum = serverPort;
  const tryOpen = () => portmap.open(portNum, { proto: 'TCP', description: 'PAssist Web' });
  try {
    const r = await tryOpen();
    if (r.externalIp) {
      publicBaseUrl = `http://${r.externalIp}:${portNum}`;
      console.log(`[host] インターネット公開: ${publicBaseUrl} （UPnP で TCP ${portNum} を開放）`);
    } else {
      console.warn('[host] UPnP は応答しましたが公開IP不明。同一LAN内のみで動作します。');
    }
  } catch (e) {
    console.warn(`[host] UPnP 公開に失敗（同一LAN内のみで動作）: ${e.message}`);
  }
  // ルーター再起動等に備えて定期的に再主張
  portTimer = setInterval(() => tryOpen().catch(() => {}), 5 * 60 * 1000);
}

function closePublicPort() {
  if (portTimer) clearInterval(portTimer);
  portTimer = null;
  if (settings.get().publicMode && !REMOTE_SERVER_URL && process.platform === 'win32') {
    portmap.close(serverPort, { proto: 'TCP' }).catch(() => {});
  }
}

// クリップボード同期（ホスト→クライアント）：ホストのクリップボードが変わったらレンダラへ通知し、
// レンダラが DataChannel でクライアントへ送る（接続中のみ）。プライバシー上、送信は接続中だけ。
let lastClip = '';
let clipTimer = null;
function startClipboardSync() {
  try { lastClip = clipboard.readText(); } catch {}
  clipTimer = setInterval(() => {
    let t = '';
    try { t = clipboard.readText(); } catch {}
    if (t !== lastClip) {
      lastClip = t;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('clip:host', t);
    }
  }, 1000);
}
ipcMain.on('clip:set', (_e, text) => {
  if (settings.get().readonly) return; // 閲覧のみ：クライアントからのクリップボード書込は無視
  try { if (typeof text === 'string') { clipboard.writeText(text); lastClip = text; } } catch {}
});

// カーソル形状の追跡（接続時にレンダラから要求）。一度起動したら終了時まで常駐させ、
// 形状が変わるたびレンダラへ通知 → レンダラが DataChannel でクライアントへ送る。
ipcMain.on('cursor:track', (_e, on) => {
  if (on) {
    cursorshape.start((shape) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cursor:shape', shape);
    });
  }
});

// 設定のエクスポート / インポート
async function exportSettings() {
  const r = await dialog.showSaveDialog(mainWindow || undefined, {
    title: '設定のエクスポート',
    defaultPath: 'passist-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!r.canceled && r.filePath) {
    try { settings.exportTo(r.filePath); } catch (e) { dialog.showErrorBox('エクスポート失敗', e.message); }
  }
}
async function importSettings() {
  const r = await dialog.showOpenDialog(mainWindow || undefined, {
    title: '設定のインポート',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    settings.importFrom(r.filePaths[0]);
  } catch (e) {
    dialog.showErrorBox('インポート失敗', e.message);
    return;
  }
  const ans = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    message: '設定を読み込みました',
    detail: '反映するにはアプリを再起動します。',
    buttons: ['再起動', '後で'],
    defaultId: 0,
    noLink: true,
  });
  if (ans.response === 0) {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  }
}

const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

// Windows のシステム色から配色パレットを作る（背景=window, ボタン=3d-face, 主ボタン=アクセント色）。
// GetSysColor はダーク時も明色を返す仕様のため、ダーク時はアクセント色のみ API 値、地色はダーク既定。
function getSystemPalette() {
  const hex6 = (s) => '#' + String(s || '').replace('#', '').slice(0, 6);
  const sys = (name, fallback) => {
    try {
      const c = systemPreferences.getColor(name);
      return c ? hex6(c) : fallback;
    } catch {
      return fallback;
    }
  };
  let accent = '#0078d4';
  try {
    accent = hex6(systemPreferences.getAccentColor());
  } catch {}
  if (nativeTheme.shouldUseDarkColors) {
    return {
      accent, accentText: '#ffffff',
      bg: '#202020', surface: '#2b2b2b', fg: '#f3f3f3', muted: '#a6a6a6',
      border: '#3d3d3d', field: '#2d2d2d', btnBg: '#2d2d2d', btnFg: '#f3f3f3', btnHover: '#383838',
      danger: '#ff8a80',
    };
  }
  return {
    accent, accentText: '#ffffff',
    bg: sys('window', '#ffffff'),
    surface: sys('window', '#ffffff'),
    fg: sys('window-text', '#000000'),
    muted: '#5f5f5f',
    border: '#e2e2e2',
    field: sys('window', '#ffffff'),
    btnBg: sys('3d-face', '#f0f0f0'),
    btnFg: sys('button-text', '#000000'),
    btnHover: '#e6e6e6',
    danger: '#c0392b',
  };
}

// トレイ用アイコン（生成済み icon.ico）。無ければ簡易四角にフォールバック。
function makeTrayIcon() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (img && !img.isEmpty()) return img;
  } catch {}
  const s = 16;
  const buf = Buffer.alloc(s * s * 4);
  for (let i = 0; i < s * s; i++) {
    buf[i * 4] = 0xff; // B
    buf[i * 4 + 1] = 0x6c; // G
    buf[i * 4 + 2] = 0x2b; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(makeTrayIcon());
  } catch (e) {
    console.warn('[host] tray 作成に失敗（トレイ常駐は無効）:', e.message);
    tray = null;
    return;
  }
  tray.setToolTip('PAssist');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '管理画面を開く', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'ログイン時に自動起動',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: '終了', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', showMainWindow);
}

function showAbout() {
  let icon;
  try {
    const i = nativeImage.createFromPath(ICON_PATH);
    icon = i && !i.isEmpty() ? i : undefined;
  } catch {}
  dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'info',
    title: 'PAssist について',
    message: 'PAssist',
    detail:
      `バージョン: ${app.getVersion()}\n` +
      `Electron: ${process.versions.electron} / Chromium: ${process.versions.chrome}\n\n` +
      'このPCの1つのウィンドウだけを、ブラウザでリモート操作してもらうツールです。\n' +
      'https://paps.jp',
    icon,
    buttons: ['OK'],
    noLink: true,
  });
}

// カスタムのアプリメニュー（Edit / 開発者ツール / ズームは付けない）
function buildAppMenu() {
  const template = [
    {
      label: 'ファイル',
      submenu: [
        { label: '設定のエクスポート…', click: exportSettings },
        { label: '設定のインポート…', click: importSettings },
        { type: 'separator' },
        { label: '終了', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: '再読み込み', role: 'reload' },
        { type: 'separator' },
        {
          label: '全画面表示の切替',
          accelerator: 'F11',
          click: (_item, win) => { if (win) win.setFullScreen(!win.isFullScreen()); },
        },
      ],
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: 'トレイに格納', click: () => { if (mainWindow) mainWindow.hide(); } },
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: 'ホームページ（paps.jp）', click: () => shell.openExternal('https://paps.jp') },
        { type: 'separator' },
        { label: 'バージョン情報', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    backgroundColor: getSystemPalette().bg,
    title: 'PAssist（ホスト）',
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 自動起動(--hidden)時はトレイに隠したまま、それ以外は表示
  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow.show();
  });
  // 閉じる＝終了ではなくトレイに格納（トレイがある場合）。終了はトレイメニューから。
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  // 全画面の解除手段を確保：Esc で全画面を抜ける（F11 でも切替可）
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
      e.preventDefault();
    }
  });
  // 右クリック：コピー/切り取り/貼り付けのコンテキストメニュー（ホストUIのテキスト欄用）
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const ef = params.editFlags || {};
    Menu.buildFromTemplate([
      { role: 'cut', label: '切り取り', enabled: !!ef.canCut },
      { role: 'copy', label: 'コピー', enabled: !!ef.canCopy },
      { role: 'paste', label: '貼り付け', enabled: !!ef.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'すべて選択' },
    ]).popup({ window: mainWindow });
  });
}

// 多重起動防止: 2つ目の起動は既存インスタンスの管理画面を表示して自分は終了
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    settings.init(path.join(app.getPath('userData'), 'passist-settings.json'));
    serverPort = parseInt(String(settings.get().port), 10) || 8443;
    signalWs = computeSignalWs(); // 中央サーバ / 自分のPC を設定に従って決定
    trust.init(path.join(app.getPath('userData'), 'passist-trust.json'));
    setupDisplayMedia();
    buildAppMenu();
    createTray();
    // self モードでのみ公開IP取得→子プロセスsignaling起動（中央モードはサーバ既存）
    if (!REMOTE_SERVER_URL && settings.get().serverMode === 'self') {
      await openPublicPort();
      maybeSpawnServer();
    }
    createWindow();
    startClipboardSync();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });
}

// トレイ常駐中はウィンドウを閉じても終了しない。トレイが無い場合のみ通常終了。
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (clipTimer) clearInterval(clipTimer);
  cursorshape.stop();
  closePublicPort();
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {}
  }
});
