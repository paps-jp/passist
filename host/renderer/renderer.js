/* ホスト側レンダラ（Chromium）。WebRTC の offer 側。
 * - 開いているウィンドウ一覧を表示 → 1つ選択 → そのウィンドウだけをキャプチャ
 * - シグナリングサーバに接続して共有URLを発行
 * - ビューア接続を承認したら映像トラックを送出、入力は DataChannel で受信して注入へ転送
 * - 複数同時接続(最大 maxViewers)に対応。操作できるのは1人だけ（最初の接続者）、他は閲覧のみ。 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let cfg, ws, stream;
  let serverIceServers = null; // サーバ host:create レスポンスで配布される iceServers（STUN/TURN）
  const peers = new Map(); // viewerId -> { pc, dc, viaRelay, routeReported }
  let controllerId = null; // 操作権を持つビューアID（1人）。null=全員閲覧のみ
  let cursorStarted = false; // ホストのカーソル形状追跡を一度だけ開始するためのフラグ
  const reqQueue = []; // 承認待ちリクエストのキュー [{ viewerId, auth }]
  let activeReq = null; // 現在ダイアログ表示中のリクエスト
  let sessionStarted = false; // セッション確立済みか（別画面選択で「新規発行」か「映像差し替え」かを分岐）
  let lastSharedWindow = null; // 「共有を終了」 後の「▶ もう一度共有」 用に直前のウィンドウを保持
  // サーバから配布される TURN(relay) 経由ピア向けの帯域上限。P2P 直接接続には適用しない。
  let bitratePolicy = { maxBpsRelay: 1500_000, relayCount: 0 };

  init();

  // Windows のシステム色（systemPreferences 由来）を CSS 変数へ反映
  function applyPalette(p) {
    if (!p) return;
    const r = document.documentElement.style;
    const set = (k, v) => v && r.setProperty(k, v);
    set('--bg', p.bg);
    set('--surface', p.surface);
    set('--fg', p.fg);
    set('--muted', p.muted);
    set('--border', p.border);
    set('--btn-border', p.border);
    set('--field-bg', p.field);
    set('--btn-bg', p.btnBg);
    set('--btn-fg', p.btnFg);
    set('--btn-hover', p.btnHover);
    set('--primary', p.accent);
    set('--danger', p.danger);
  }

  async function init() {
    cfg = await window.host.getConfig();
    applyPalette(cfg.palette); // Windows API の色を反映
    window.host.onThemePalette(applyPalette); // テーマ/アクセント変更に追従
    if (!cfg.inputEnabled) $('inputWarn').classList.remove('hidden');
    // 保存済み設定を反映 + 変更を保存
    // 公開URLは未設定なら passist.paps.jp を既定として扱う（入力欄は空のまま＝この既定を採用の意）。
    if (cfg.settings && cfg.settings.publicBaseUrl) $('publicBase').value = cfg.settings.publicBaseUrl;
    $('publicBase').addEventListener('change', () =>
      window.host.settingsSet({ publicBaseUrl: $('publicBase').value.trim() }),
    );
    $('publicBase').addEventListener('input', validatePublicBase); // 入力中に書式の正否を表示
    validatePublicBase();

    // TURN サーバ（任意）。空欄なら未使用＝従来通り全員 P2P 試行。
    if (cfg.settings) {
      $('turnUrl').value = cfg.settings.turnUrl || '';
      $('turnUser').value = cfg.settings.turnUser || '';
      $('turnPass').value = cfg.settings.turnPass || '';
    }
    const saveTurn = () => {
      window.host.settingsSet({
        turnUrl: $('turnUrl').value.trim(),
        turnUser: $('turnUser').value.trim(),
        turnPass: $('turnPass').value, // パスワードは trim しない（先頭/末尾の空白を意図する場合あり）
      });
      if (cfg.settings) {
        cfg.settings.turnUrl = $('turnUrl').value.trim();
        cfg.settings.turnUser = $('turnUser').value.trim();
        cfg.settings.turnPass = $('turnPass').value;
      }
      renderTurnHint();
    };
    $('turnUrl').addEventListener('change', saveTurn);
    $('turnUser').addEventListener('change', saveTurn);
    $('turnPass').addEventListener('change', saveTurn);
    $('turnUrl').addEventListener('input', renderTurnHint);
    renderTurnHint();
    // 閲覧のみモード（グローバル設定）。ON の間は接続相手の操作をホスト側で全て無視する。
    $('readonlyChk').checked = !!(cfg.settings && cfg.settings.readonly);
    $('readonlyChk').addEventListener('change', () => {
      const ro = $('readonlyChk').checked;
      if (cfg.settings) cfg.settings.readonly = ro;
      window.host.settingsSet({ readonly: ro });
      refreshModes(); // 接続中なら操作権/相手表示へ即反映
      renderChips();
    });
    // 同時接続数（次の共有から有効）。操作は1人のみ・他は閲覧。
    $('maxViewers').value = String((cfg.settings && cfg.settings.maxViewers) || 1);
    $('maxViewers').addEventListener('change', () => {
      const n = Math.max(1, Math.min(4, parseInt($('maxViewers').value, 10) || 1));
      if (cfg.settings) cfg.settings.maxViewers = n;
      window.host.settingsSet({ maxViewers: n });
      renderChips();
    });
    // サーバ（中央 / 自分のPC）。central はユーザー設定不要。self は cloudflared 等を併用。
    // 変更は再起動で完全反映（接続中の動的再接続は危険なので避ける）。
    const smVal = (cfg.settings && cfg.settings.serverMode) || 'central';
    $('centralServerUrl').value = (cfg.settings && cfg.settings.centralServerUrl) || 'wss://passist.paps.jp/ws';
    function renderServerModeUi() {
      const v = (cfg.settings && cfg.settings.serverMode) || 'central';
      $('centralUrlRow').style.display = v === 'central' ? '' : 'none';
      $('serverModeHint').textContent =
        v === 'central'
          ? '中央サーバ ' + ($('centralServerUrl').value || 'wss://passist.paps.jp/ws') + ' に接続。共有URLは https://passist.paps.jp/s/… で発行されます。'
          : '自分のPCで内蔵サーバを動かし、cloudflared 等のトンネルURLを「くわしい設定」で設定してください。';
    }
    for (const r of document.querySelectorAll('input[name="serverMode"]')) {
      r.checked = r.value === smVal;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        if (cfg.settings) cfg.settings.serverMode = r.value;
        window.host.settingsSet({ serverMode: r.value });
        renderServerModeUi();
        $('serverRestartHint').classList.remove('hidden'); // 再起動が必要であることを明示
      });
    }
    $('centralServerUrl').addEventListener('change', () => {
      const v = $('centralServerUrl').value.trim();
      if (cfg.settings) cfg.settings.centralServerUrl = v;
      window.host.settingsSet({ centralServerUrl: v });
      renderServerModeUi();
      $('serverRestartHint').classList.remove('hidden');
    });
    renderServerModeUi();

    // 接続方法（承認制 / PIN / 招待リンク / だれでも）。変更は次の共有から有効。
    const accVal = (cfg.settings && cfg.settings.accessMode) || 'approve';
    for (const r of document.querySelectorAll('input[name="access"]')) {
      r.checked = r.value === accVal;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        if (cfg.settings) cfg.settings.accessMode = r.value;
        window.host.settingsSet({ accessMode: r.value });
        updateAccessHint();
        renderChips();
        updateInviteUi(); // 招待リンクUIの表示切替
      });
    }
    updateAccessHint();
    updateInviteUi();
    // 有効期限（次の共有から有効）。0 = 無期限。
    $('ttlSel').value = String(cfg.settings && Number.isFinite(cfg.settings.sessionTtlMinutes) ? cfg.settings.sessionTtlMinutes : 30);
    $('ttlSel').addEventListener('change', () => {
      const m = parseInt($('ttlSel').value, 10);
      const v = Number.isFinite(m) ? m : 30;
      if (cfg.settings) cfg.settings.sessionTtlMinutes = v;
      window.host.settingsSet({ sessionTtlMinutes: v });
      renderChips();
    });
    // ⚙ 設定 / ⋯ くわしい設定 モーダル: 開く/閉じる（×ボタン・背景クリック・ESC）
    const openSettings = () => $('settingsModal').classList.remove('hidden');
    const closeSettings = () => $('settingsModal').classList.add('hidden');
    $('settingsBtn').onclick = openSettings;
    $('settingsClose').onclick = closeSettings;
    $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('settingsModal').classList.contains('hidden')) closeSettings();
    });
    // 設定モーダル内のタブ切替（基本 / くわしい設定）
    document.querySelectorAll('#settingsModal .tabs .tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('#settingsModal .tabs .tab').forEach((b) => b.classList.toggle('active', b === tab));
        document.querySelectorAll('#settingsModal .tab-content').forEach((c) => c.classList.toggle('hidden', c.id !== 'tab-' + tab.dataset.tab));
      };
    });
    // QRコードの開閉（既定は開）。相手はスマホのカメラで読み取って接続できる。
    $('qrToggle').onclick = () => {
      const shown = $('qrPanel').classList.toggle('hidden') === false;
      $('qrToggle').classList.toggle('open', shown);
      if (shown) showQr();
    };
    renderChips();
    // ホストのクリップボード変更を全ビューアへ転送（接続中のみ）
    window.host.onClipHost((text) => broadcast({ t: 'clip', s: text }));
    // ホストのカーソル形状を全ビューアへ転送（接続中のみ）→ ローカルカーソルの形に反映
    window.host.onCursorShape((shape) => broadcast({ t: 'cursor', s: shape }));
    $('reload').onclick = loadWindows;
    $('back').onclick = () => {
      // セッション（URL・接続・承認）は維持したまま、別の画面を選び直す（映像トラックを差し替える方式）
      $('session').classList.add('hidden');
      $('picker').classList.remove('hidden');
      loadWindows();
    };
    $('copy').onclick = copyUrl;
    $('reissue').onclick = reissue;
    $('approve').onclick = onApprove;
    $('deny').onclick = () => {
      if (activeReq) sendWs({ type: 'host:deny', viewerId: activeReq.viewerId });
      $('request').classList.add('hidden');
      $('trustChk').checked = false;
      activeReq = null;
      processReqQueue();
    };
    $('trustLink').onclick = issueTrustLink;
    $('copyTrust').onclick = () => copyField('trustUrl', 'copyTrust');
    refreshTrustInfo();
    $('end').onclick = () => {
      // 終了後の「再開」モード: 同じウィンドウで新規 URL を発行して再開（直前の lastSharedWindow を使う）
      if ($('end').dataset.mode === 'resume') {
        $('end').dataset.mode = '';
        if (lastSharedWindow) choose(lastSharedWindow);
        return;
      }
      sendWs({ type: 'host:end' });
      // 終了＝次回起動時に同じURLで復元しない（lastHostToken/Secretも破棄）。activeShareName も解除。
      window.host.settingsSet({ activeShareName: '', lastHostToken: '', lastHostSecret: '' });
      if (cfg.settings) { cfg.settings.lastHostToken = ''; cfg.settings.lastHostSecret = ''; }
      shouldReconnect = false; // 明示的終了 = WS が閉じても自動再接続しない
      clearReconnect();
      stopWatch();
      closeAllPeers();
      sessionStarted = false; // 次に画面を選ぶと新しいURLで開始
      setStatus('✓ 共有を終了しました（「▶ もう一度共有」で同じウィンドウを再開できます）');
      endShareUi(); // 終了ボタンを「再開」へ
    };
    await loadWindows();
    maybeResume(); // 前回「終了」を押していなければ、同じウィンドウの共有を自動再開（無ければ起動を監視）
  }

  async function loadWindows() {
    const grid = $('grid');
    grid.innerHTML = '<p class="hint">読み込み中…</p>';
    const wins = await window.host.listWindows();
    grid.innerHTML = '';
    if (!wins.length) {
      grid.innerHTML = '<p class="hint">共有できるウィンドウが見つかりません。</p>';
      return;
    }
    for (const w of wins) {
      const card = document.createElement('button');
      card.className = 'card';
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      if (w.thumbnail) thumb.src = w.thumbnail;
      const cap = document.createElement('div');
      cap.className = 'cap';
      if (w.appIcon) {
        const ico = document.createElement('img');
        ico.className = 'ico';
        ico.src = w.appIcon;
        cap.appendChild(ico);
      }
      const label = document.createElement('span');
      label.textContent = w.name;
      cap.appendChild(label);
      if (w.owned) {
        // owned 窓（アプリ本体に付随する別ウィンドウ）。どの本体のものか分かるよう注記。
        const sub = document.createElement('span');
        sub.className = 'subhint';
        sub.textContent = w.ownerName ? '↳ ' + w.ownerName : '↳ サブ画面';
        cap.appendChild(sub);
        card.title = (w.ownerName ? w.ownerName + ' の' : '') + '付随ウィンドウ（通常は一覧に出ない別画面）';
      }
      card.append(thumb, cap);
      card.onclick = () => choose(w);
      grid.appendChild(card);
    }
  }

  async function capture() {
    // 選択ウィンドウは main 側の setDisplayMediaRequestHandler が selectedSourceId で固定して返す。
    // （古い getUserMedia + chromeMediaSource:'desktop' は新しい Electron で不安定/クラッシュ要因のため使わない）
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  }

  async function choose(w, opts) {
    opts = opts || {};
    lastSharedWindow = w; // 終了後の「▶ もう一度共有」用に記録
    stopWatch();
    await window.host.selectSource(w.id, w.name);
    window.host.settingsSet({ activeShareName: w.name }); // 共有対象を保存（終了ボタンまで保持＝再起動で自動再開）
    let newStream;
    try {
      newStream = await capture();
    } catch (e) {
      if (opts.auto) {
        showResume(w); // 自動再開でキャプチャ不可（ユーザー操作要求等）→ 再開ボタンを提示
        return;
      }
      alert('キャプチャを開始できませんでした: ' + e.message);
      return;
    }
    hideWatch();
    if (sessionStarted) {
      // 既存セッションを維持: 全ピアの映像トラックを差し替え（URL・接続・承認はそのまま継続）
      const track = newStream.getVideoTracks()[0];
      for (const { pc } of peers.values()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || pc.getSenders()[0];
        if (sender && track) {
          try { await sender.replaceTrack(track); } catch (err) { console.warn('replaceTrack', err); }
        }
      }
      if (stream) stream.getTracks().forEach((t) => t.stop()); // 旧キャプチャを停止
      stream = newStream;
      $('preview').srcObject = stream;
      $('picker').classList.add('hidden');
      $('session').classList.remove('hidden');
      setStatus(statusText());
    } else {
      // 初回: セッション開始
      stream = newStream;
      $('preview').srcObject = stream;
      $('picker').classList.add('hidden');
      $('session').classList.remove('hidden');
      $('back').classList.remove('hidden'); // トップバーの「別の画面」「終了」を表示
      $('end').classList.remove('hidden');
      resetShareUi(); // 終了ボタン等を「共有中」状態へ戻す
      renderChips();
      startSignaling();
      sessionStarted = true;
    }
    // 共有対象ウィンドウが閉じられた（リモート操作で×が押された等）ことを検出。
    // ハンドラ未設定だと renderer は「共有中」状態のまま無効HWNDへ入力注入を続けてしまい、
    // Electron キャプチャエンジンや Win32 API がクラッシュの起点になる。
    const vt = stream.getVideoTracks()[0];
    if (vt) vt.onended = handleCaptureLost;
  }

  // 共有していたウィンドウが消失したときの撤収処理。
  // セッション(URL/接続/承認)は維持して、ユーザーは「← 別の画面を選ぶ」で別ウィンドウを共有し直せる。
  // ホスト側の selectedSourceId と activeShareName をクリアして、無効HWND への以後のアクセスを止める。
  function handleCaptureLost() {
    try { $('preview').srcObject = null; } catch {}
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      stream = null;
    }
    // 次回起動時に閉じた窓を自動再開しようとして再クラッシュ → を防ぐ
    try { window.host.settingsSet({ activeShareName: '' }); } catch {}
    // ホスト側の selectedSourceId をクリア → 無効HWND での setDisplayMediaRequestHandler 応答や入力注入を止める
    try { window.host.selectSource(null, null); } catch {}
    setStatus('共有していたウィンドウが閉じられました。「← 別の画面を選ぶ」から別のウィンドウを選び直せます。');
  }

  // --- セッション自動再開 / ウィンドウ監視 ---
  let watchTimer = null;

  async function maybeResume() {
    // 手動リロード（「別のウィンドウを選ぶ」等）では再開しない。アプリ再起動時のみ自動再開。
    if (sessionStorage.getItem('passist_skip')) {
      sessionStorage.removeItem('passist_skip');
      return;
    }
    const name = cfg.settings && cfg.settings.activeShareName;
    if (!name) return;
    const src = await findWindowByName(name);
    if (src) choose(src, { auto: true });
    else startWatch(name);
  }

  async function findWindowByName(name) {
    const wins = await window.host.listWindows();
    return (
      wins.find((w) => w.name === name) ||
      wins.find((w) => w.name && (w.name.includes(name) || name.includes(w.name))) ||
      null
    );
  }

  function startWatch(name) {
    stopWatch();
    showWatch('対象ウィンドウ「' + name + '」の起動を待っています…（見つかり次第、自動で共有を再開します）');
    watchTimer = setInterval(async () => {
      const src = await findWindowByName(name);
      if (src) choose(src, { auto: true }); // choose 内で stopWatch される
    }, 4000);
  }
  function stopWatch() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  function showWatch(text) {
    const b = $('watchBar');
    if (!b) return;
    b.innerHTML = '';
    b.append(text);
    b.classList.remove('hidden');
  }
  function hideWatch() {
    const b = $('watchBar');
    if (b) b.classList.add('hidden');
  }
  function showResume(w) {
    const b = $('watchBar');
    if (!b) return;
    b.innerHTML = '';
    b.append('前回共有していた「' + w.name + '」を再開できます。 ');
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '▶ 共有を再開';
    btn.onclick = () => choose(w, { auto: false });
    b.appendChild(btn);
    b.classList.remove('hidden');
  }

  // ホスト WS 自動再接続。指数バックオフで最大5回、5回失敗したら諦めてユーザー操作待ち。
  // host:end / expired / sessionStarted=false（picker）では shouldReconnect=false にして停止。
  // 成功した host:create で existingToken/hostSecret を送るため、URL は再接続前と同じが維持される。
  let shouldReconnect = true;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  const MAX_RECONNECT = 5;
  function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) return;
    if (reconnectAttempt >= MAX_RECONNECT) {
      setStatus(`✕ サーバとの接続が切れました（${MAX_RECONNECT}回再接続を試みて失敗）。「← 別の画面を選ぶ」から共有し直してください。`);
      return;
    }
    const delay = Math.min(30000, 500 * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    setStatus(`サーバとの接続が切れました。再接続中…（${reconnectAttempt}/${MAX_RECONNECT}）`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startSignaling(); }, delay);
  }

  function startSignaling() {
    shouldReconnect = true;  // 新規開始 or 再開 = 自動再接続を有効化（host:end / expired で再度 false に）
    clearReconnect();
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {} } // 旧接続を確実に閉じてから張り直す
    ws = new WebSocket(cfg.signalWs);
    ws.onopen = () => {
      reconnectAttempt = 0; // 接続成功でカウンタをリセット
      sendWs({
        type: 'host:create',
        publicBaseUrl: $('publicBase').value.trim() || undefined, // 空欄なら server 側で LAN/環境変数にフォールバック
        maxViewers: (cfg.settings && cfg.settings.maxViewers) || 1,
        accessMode: (cfg.settings && cfg.settings.accessMode) || 'approve',
        ttlMinutes: cfg.settings && Number.isFinite(cfg.settings.sessionTtlMinutes) ? cfg.settings.sessionTtlMinutes : 30,
        // セッション引き継ぎ: 前回の token/secret を送ると、サーバは同じ token でセッションを復元するか
        // ホスト ws を張り替えてくれる（→ 同じ viewer URL を使い続けられる）。
        existingToken: (cfg.settings && cfg.settings.lastHostToken) || undefined,
        hostSecret:    (cfg.settings && cfg.settings.lastHostSecret) || undefined,
      });
    };
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => scheduleReconnect();
    ws.onerror = () => { /* onclose も呼ばれるので集約 */ };
  }
  const sendWs = (o) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

  const isReadonlyGlobal = () => !!(cfg.settings && cfg.settings.readonly);

  // 全ビューアの open な DataChannel へ同報（クリップボード/カーソル形状などの閲覧補助）
  function broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const { dc } of peers.values()) if (dc && dc.readyState === 'open') dc.send(s);
  }

  // 指定ビューアへ操作可否を通知（readonly = グローバル閲覧のみ or 操作者でない）
  function sendModeTo(viewerId) {
    const p = peers.get(viewerId);
    if (!p || !p.dc || p.dc.readyState !== 'open') return;
    p.dc.send(JSON.stringify({ t: 'mode', readonly: isReadonlyGlobal() || viewerId !== controllerId }));
  }

  // 操作権の再決定＋全ビューアへ mode 通知。操作者は「最初に接続した(最も古い)open なビューア」。
  function refreshModes() {
    const openIds = [...peers.entries()].filter(([, p]) => p.dc && p.dc.readyState === 'open').map(([id]) => id);
    const prev = controllerId;
    if (isReadonlyGlobal()) controllerId = null;
    else if (!controllerId || !openIds.includes(controllerId)) controllerId = openIds[0] || null;
    for (const id of peers.keys()) sendModeTo(id);
    if (controllerId && controllerId !== prev) window.host.focusTarget(); // 操作者が変わった時だけ対象を前面へ
    setStatus(statusText());
  }

  function statusText() {
    const n = peers.size;
    if (!n) return '待機中。相手がURLを開くと、ここに表示されます。';
    return `接続中: ${n}人` + (controllerId && peers.has(controllerId) ? '（操作: 1人 / 他は閲覧）' : '（全員閲覧のみ）');
  }

  function onMsg(msg) {
    switch (msg.type) {
      case 'session':
        serverIceServers = Array.isArray(msg.iceServers) ? msg.iceServers : null; // サーバ配布の STUN/TURN を採用
        $('url').value = msg.viewerUrl;
        verifyAppliedBase(msg.viewerUrl); // 入力した公開URLが実際に反映されたか確認
        if (!$('qrPanel').classList.contains('hidden')) showQr(); // URL確定時にQRを更新
        if (msg.pin) {
          $('pin').textContent = 'PIN: ' + msg.pin;
          $('pin').classList.remove('hidden');
        }
        // セッション引き継ぎ用に token/secret を永続化（次回起動時に同じ URL を取り戻すため）。
        // resumed=true ならサーバが既存セッションを引き継いだ／復元した。
        if (msg.token && msg.hostSecret) {
          window.host.settingsSet({ lastHostToken: msg.token, lastHostSecret: msg.hostSecret });
          if (cfg.settings) { cfg.settings.lastHostToken = msg.token; cfg.settings.lastHostSecret = msg.hostSecret; }
        }
        setStatus(msg.resumed
          ? '✓ 前回のセッションを引き継ぎました（URL は同じ）。相手がURLを開くと、ここに表示されます。'
          : '待機中。相手がURLを開くと、ここに表示されます。');
        break;
      case 'viewer:request':
        reqQueue.push({ viewerId: msg.viewerId, auth: msg.auth || null });
        processReqQueue();
        break;
      case 'viewer:joined':
        startPeerFor(msg.viewerId);
        break;
      case 'viewer:left':
        closePeerFor(msg.viewerId);
        break;
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'expired':
        setStatus('⏰ 有効期限が切れました。「← 別の画面を選ぶ」から共有し直してください');
        // 期限切れ＝同じURLでの引き継ぎは不可。lastHostToken/Secret を破棄、再接続も停止。
        window.host.settingsSet({ lastHostToken: '', lastHostSecret: '' });
        if (cfg.settings) { cfg.settings.lastHostToken = ''; cfg.settings.lastHostSecret = ''; }
        shouldReconnect = false;
        clearReconnect();
        closeAllPeers();
        sessionStarted = false; // 期限切れ＝次の画面選択で新規発行
        endShareUi();
        break;
      case 'bitrate-policy':
        bitratePolicy = { maxBpsRelay: msg.maxBpsRelay | 0, relayCount: msg.relayCount | 0 };
        applyBitrateLimits(); // 現在のrelay経由ピアに即時反映
        renderNetInfo();
        break;
    }
  }

  // TURN(relay) 経由と判定された viewer の video sender にのみ maxBitrate を適用。
  // P2P 直接接続は VPS OUT を使わないので絞らない（操作・画質を最大化）。
  async function applyBitrateLimits() {
    for (const [, p] of peers) {
      if (!p.viaRelay || !p.pc) continue;
      for (const sender of p.pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = bitratePolicy.maxBpsRelay;
          await sender.setParameters(params); // 再ネゴ不要・即時反映
        } catch (err) { console.warn('setParameters', err); }
      }
    }
  }

  // 接続確立直後、getStats でこの peer が TURN(relay) 経由か P2P かを判定。
  // 判定結果は peer に記憶し、サーバへ peer-route で通知（サーバが relayCount を集計）。
  async function detectAndReportRoute(viewerId) {
    const p = peers.get(viewerId); if (!p || !p.pc) return;
    try {
      const stats = await p.pc.getStats();
      let local = null;
      for (const r of stats.values()) {
        if (r.type === 'candidate-pair' && r.nominated && (r.state === 'succeeded' || r.state === 'in-progress')) {
          const l = stats.get(r.localCandidateId);
          if (l) { local = l; break; }
        }
      }
      const via = local && local.candidateType === 'relay' ? 'relay' : 'p2p';
      if (p.routeReported === via) return; // 同じ判定の重複送信を避ける
      p.viaRelay = via === 'relay';
      p.routeReported = via;
      sendWs({ type: 'peer-route', viewerId, via });
      if (p.viaRelay) applyBitrateLimits(); // 新たにrelay化したピアに即時適用
    } catch (err) { console.warn('detectAndReportRoute', err); }
  }

  // ヘッダ下の小さい注記に「TURN利用 N人・各 X kbps」を出す（0人のときは何も出さない）
  function renderNetInfo() {
    const el = $('netInfo'); if (!el) return;
    if (!bitratePolicy.relayCount) { el.textContent = ''; return; }
    el.textContent = `TURN中継: ${bitratePolicy.relayCount}人 / 各 ${Math.round(bitratePolicy.maxBpsRelay / 1000)} kbps`;
  }

  // 公開URL（トンネル）の書式チェック＋見える化。サーバ側 sanitizeBase と同じ判定で、
  // 不正だと「黙って LAN/IP に戻る」ことを赤字で知らせる（cloudflared 設定ミスの自己診断）。
  function normBase(u) {
    try { const url = new URL(u); if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''; return u.replace(/\/+$/, ''); }
    catch { return ''; }
  }
  function validatePublicBase() {
    const el = $('publicBase'), hint = $('publicBaseHint');
    if (!el || !hint) return '';
    const raw = el.value.trim();
    if (!raw) { hint.textContent = '未入力なら社内LAN内のアドレスになります（外部からは接続できません）。cloudflared 等のトンネルURLを入れて「URLを再発行」してください。'; hint.classList.remove('danger-hint'); return ''; }
    const norm = normBase(raw);
    if (!norm) {
      hint.textContent = '⚠ URLの書式が正しくありません。例: https://usagi.paps.jp（「:」でなく「.」、余分な空白・全角に注意）。このままでは社内LANのアドレスになります。';
      hint.classList.add('danger-hint');
      return '';
    }
    hint.textContent = '✓ この公開URLで発行します: ' + norm;
    hint.classList.remove('danger-hint');
    return norm;
  }
  // 発行後、入力した公開URLが実際に使われたか確認（不正ならサーバが捨てて LAN/IP になっている）。
  function verifyAppliedBase(viewerUrl) {
    const hint = $('publicBaseHint'); if (!hint) return;
    const want = normBase(($('publicBase').value || '').trim());
    if (want && viewerUrl && viewerUrl.indexOf(want) !== 0) {
      hint.textContent = '⚠ 入力した公開URLが使われていません（書式が不正のため LAN に戻りました）。発行: ' + viewerUrl;
      hint.classList.add('danger-hint');
    }
  }

  function reissue() {
    // 既存接続を畳んで新しいセッションURLを発行
    validatePublicBase();
    closeAllPeers();
    try { ws && ws.close(); } catch {}
    startSignaling();
  }

  // TURN URL の書式チェック（turn:host:port / turns:host:port / ?transport=tcp 等を許容）
  function validateTurnUrl(u) {
    if (!u) return { ok: false, reason: 'empty' };
    try {
      const m = /^(turn|turns):([^:?#\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(u.trim());
      if (!m) return { ok: false, reason: 'format' };
      return { ok: true, scheme: m[1].toLowerCase(), host: m[2], port: m[3] || (m[1].toLowerCase() === 'turns' ? '5349' : '3478'), transport: m[4] || (m[1].toLowerCase() === 'turns' ? 'tcp' : 'udp') };
    } catch { return { ok: false, reason: 'format' }; }
  }
  function renderTurnHint() {
    const hint = $('turnHint'); if (!hint) return;
    const u = ($('turnUrl').value || '').trim();
    if (!u) { hint.textContent = 'TURN未設定。NAT越えに失敗した相手とは接続できません。'; hint.classList.remove('danger-hint'); return; }
    const v = validateTurnUrl(u);
    if (!v.ok) { hint.textContent = '⚠ URL書式が不正です。例: turn:turn.example.com:3478 または turns:turn.example.com:5349?transport=tcp'; hint.classList.add('danger-hint'); return; }
    hint.textContent = `✓ ${v.scheme.toUpperCase()} ${v.host}:${v.port} (${v.transport.toUpperCase()}) を使います`;
    hint.classList.remove('danger-hint');
  }

  // RTCPeerConnection 用 iceServers を構築。
  // 優先順: ユーザー手動設定（自前TURN）> サーバ配布（passist.paps.jp の既定TURN/STUN）> フォールバック(Google STUN)。
  function buildIceServers() {
    const s = cfg.settings || {};
    const v = validateTurnUrl(s.turnUrl || '');
    if (v.ok && s.turnUser && s.turnPass) {
      // ユーザーが自前 TURN を入れている＝それを優先。STUN も付ける（NAT越え補助）。
      return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: s.turnUrl.trim(), username: s.turnUser, credential: s.turnPass }];
    }
    if (serverIceServers && serverIceServers.length) return serverIceServers; // サーバ配布
    return [{ urls: 'stun:stun.l.google.com:19302' }]; // フォールバック
  }

  // 承認キューを1件ずつ処理（信頼済みは自動承認、それ以外はダイアログ）
  function processReqQueue() {
    if (activeReq || !reqQueue.length) return;
    activeReq = reqQueue.shift();
    handleViewerRequest(activeReq);
  }

  async function handleViewerRequest(req) {
    if (req.auth) {
      const res = await window.host.trustCheck(req.auth);
      if (res && res.trusted) {
        sendWs({ type: 'host:approve', viewerId: req.viewerId });
        setStatus('招待済み端末を自動承認しました' + (res.label ? '（' + res.label + '）' : ''));
        activeReq = null;
        processReqQueue();
        return;
      }
    }
    // 招待リンクモード: 招待されていない相手は手動承認させず自動拒否（誤って許可しないため）
    const mode = (cfg.settings && cfg.settings.accessMode) || 'approve';
    if (mode === 'invite') {
      sendWs({ type: 'host:deny', viewerId: req.viewerId });
      setStatus('招待リンクを持たない接続を自動拒否しました');
      activeReq = null;
      processReqQueue();
      return;
    }
    $('request').classList.remove('hidden');
    setStatus('接続リクエストがあります');
  }

  async function onApprove() {
    if (!activeReq) return;
    // 「この端末を信頼」がオンなら新しいクレデンシャルを発行してビューアへ渡す
    let issue = null;
    if ($('trustChk').checked) issue = await window.host.trustIssue('承認時に信頼');
    sendWs({ type: 'host:approve', viewerId: activeReq.viewerId, issue });
    $('request').classList.add('hidden');
    $('trustChk').checked = false;
    activeReq = null;
    refreshTrustInfo();
    processReqQueue();
  }

  // 相手に渡す“事前承認リンク”を発行（現在のセッションURL + 信頼クレデンシャル）
  async function issueTrustLink() {
    if (!$('url').value) {
      alert('先にウィンドウを選択してURLを発行してください');
      return;
    }
    const cred = await window.host.trustIssue('事前承認リンク');
    $('trustUrl').value = $('url').value + '#k=' + cred.clientId + '.' + cred.secret;
    $('trustLinkRow').classList.remove('hidden');
    refreshTrustInfo();
  }

  async function refreshTrustInfo() {
    const list = await window.host.trustList();
    const el = $('trustManage');
    el.textContent = '招待済み端末: ' + list.length + ' 件';
    if (!list.length) return;
    el.append('　');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = 'すべて解除';
    a.onclick = async (e) => {
      e.preventDefault();
      await window.host.trustClear();
      refreshTrustInfo();
    };
    el.appendChild(a);
  }

  // 接続方法ラジオ変更時の表示制御。invite モード時は招待リンクUIを表示。
  function updateInviteUi() {
    const isInvite = ((cfg.settings && cfg.settings.accessMode) || 'approve') === 'invite';
    const box = $('inviteBox'); if (box) box.classList.toggle('hidden', !isInvite);
  }

  // ビューアごとに peer 接続を張る（同じキャプチャ stream を各接続へ送る＝メッシュ）
  async function startPeerFor(viewerId) {
    closePeerFor(viewerId); // 再接続時の取りこぼし防止
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    const entry = { pc, dc: null, viaRelay: false, routeReported: null };
    peers.set(viewerId, entry);
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const dc = pc.createDataChannel('input');
    entry.dc = dc;
    dc.onopen = () => {
      if (!cursorStarted) { cursorStarted = true; window.host.cursorTrack(true); } // 一度だけ開始
      refreshModes(); // 操作権の決定＋mode 通知
    };
    dc.onmessage = async (e) => {
      if (viewerId !== controllerId) return; // 操作権がないビューアの入力は無視（多重防壁）
      if (isReadonlyGlobal()) return; // 閲覧のみ時は誰の入力も無視
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.t === 'readtext') {
        // テキスト編集モード: 現在のフィールド値をクリップボード経由で取得して返す。
        // クリップボードにファイル等が入っていて保護できない場合は aborted=理由 を付けて返す。
        try {
          const r = await window.host.readSelectedText();
          if (dc.readyState === 'open') {
            const out = (r && typeof r === 'object')
              ? { t: 'fieldtext', s: r.value || '', aborted: r.aborted ? r.reason : null }
              : { t: 'fieldtext', s: r || '' }; // 旧API互換
            dc.send(JSON.stringify(out));
          }
        } catch (err) { console.warn('readSelectedText', err); }
        return;
      }
      try { window.host.sendInput(m); } catch {}
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendWs({ type: 'signal', to: viewerId, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') closePeerFor(viewerId); // 死んだ接続を解放
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') detectAndReportRoute(viewerId); // 経路確定後にrelay/p2p判定
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });
  }

  async function handleSignal(from, data) {
    const p = peers.get(from);
    if (!p || !p.pc) return;
    if (data.sdp) {
      await p.pc.setRemoteDescription(data.sdp); // ビューアからの answer
    } else if (data.candidate) {
      try {
        await p.pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn('addIceCandidate', err);
      }
    }
  }

  function closePeerFor(viewerId) {
    const p = peers.get(viewerId);
    if (!p) return;
    // 経路が relay 扱いだったらサーバ集計を確実に減らす（viewer 側 close を待たずに即時）
    if (p.viaRelay) sendWs({ type: 'peer-route', viewerId, via: 'p2p' });
    // ハンドラを外してから閉じる（閉じた後のコールバックで古い参照を触らない）
    if (p.dc) {
      try { p.dc.onopen = null; p.dc.onmessage = null; p.dc.close(); } catch {}
    }
    if (p.pc) {
      try {
        p.pc.onicecandidate = null;
        p.pc.onconnectionstatechange = null;
        p.pc.oniceconnectionstatechange = null;
        p.pc.ontrack = null;
        p.pc.close();
      } catch {}
    }
    peers.delete(viewerId);
    refreshModes(); // 操作者が抜けたら次の人へ委譲＋全体へ mode 再通知
  }

  function closeAllPeers() {
    for (const id of [...peers.keys()]) closePeerFor(id);
    controllerId = null;
    $('request').classList.add('hidden');
    activeReq = null;
    reqQueue.length = 0;
  }

  // 共有終了：終了ボタンを「▶ もう一度共有」 に切り替え、同じウィンドウで再開できる状態にする
  function endShareUi() {
    const e = $('end');
    e.disabled = false; // 再クリックで再開できるよう有効のまま
    e.textContent = '▶ もう一度共有';
    e.dataset.mode = 'resume';
    e.classList.remove('danger');
    e.classList.add('primary');
    $('copy').disabled = true; // 死んだURLをコピーさせない
    $('qrToggle').disabled = true;
  }
  // 共有開始：上記を「共有中」状態へ戻す
  function resetShareUi() {
    const e = $('end');
    e.disabled = false;
    e.textContent = '■ 共有を終了';
    e.dataset.mode = '';
    e.classList.remove('primary');
    e.classList.add('danger');
    $('copy').disabled = false;
    $('qrToggle').disabled = false;
  }

  function copyUrl() {
    copyField('url', 'copy');
  }
  function copyField(inputId, btnId) {
    navigator.clipboard.writeText($(inputId).value);
    const b = $(btnId);
    const orig = b.textContent;
    b.textContent = 'コピー済';
    setTimeout(() => (b.textContent = orig), 1500);
  }

  const setStatus = (t) => ($('status').textContent = t);

  // 「接続方法」ラジオの下に出す説明（だれでも は警告色）
  function updateAccessHint() {
    const el = $('accessHint');
    if (!el) return;
    const v = (cfg.settings && cfg.settings.accessMode) || 'approve';
    el.textContent =
      v === 'approve' ? 'つなぐたびに、あなたの「許可」が必要です（安全）。'
      : v === 'pin' ? '相手は、表示されるPIN番号の入力が必要です。'
      : v === 'invite' ? '事前に発行する「招待リンク」を持つ相手だけが自動接続できます。通常URLからの接続は自動拒否されます。'
      : '⚠ URLを知っていれば誰でも即接続できます。インターネット公開時はとくに注意してください。';
    el.classList.toggle('danger-hint', v === 'token');
  }

  // 共有URLのQRコードを生成して表示（main 側で生成 → data URL）
  async function showQr() {
    const url = $('url').value;
    if (!url) return;
    try {
      const data = await window.host.qrMake(url);
      if (data) $('qrImg').src = data;
    } catch {}
  }

  // 共有画面に「今の設定」をチップで表示（接続方法・同時接続・操作可否）
  function renderChips() {
    const el = $('modeChips');
    if (!el) return;
    const s = cfg.settings || {};
    const access = s.accessMode === 'token' ? 'だれでも' : s.accessMode === 'pin' ? 'PIN番号' : s.accessMode === 'invite' ? '招待リンク' : '承認制';
    const max = s.maxViewers || 1;
    const op = s.readonly ? '全員 閲覧のみ' : max > 1 ? '操作は先着1人・他は閲覧' : '操作 可';
    el.innerHTML = '';
    for (const t of ['接続方法: ' + access, '同時接続: ' + max + '人', '操作: ' + op, '有効期限: ' + ttlLabel(s.sessionTtlMinutes)]) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t;
      el.appendChild(c);
    }
  }

  function ttlLabel(m) {
    const n = Number.isFinite(m) ? m : 30;
    if (n <= 0) return '無期限';
    if (n % 60 === 0) return n / 60 + '時間';
    return n + '分';
  }
})();
