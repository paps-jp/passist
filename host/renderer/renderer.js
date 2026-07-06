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
  // 接続中/過去 viewer の audit 情報（ホスト UI で「いま誰がどこから繋がっているか」を見せる）。
  // viewerId -> { ip, ua, joinedAt, leftAt?, state: 'pending'|'connected'|'left'|'kicked' }
  // セッション中はメモリ保持。 ホスト終了 or 別画面選択で初期化（プライバシー上、永続化しない）。
  const viewerAudit = new Map();
  const VIEWER_AUDIT_MAX = 50; // 履歴は最大50件で古いものから消す（メモリ節約）
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
          ? tr('host.set.server.hintCentral', { url: $('centralServerUrl').value || 'wss://passist.paps.jp/ws' })
          : tr('host.set.server.hintSelf');
      // V-17: 中央モードでは publicBase は無視されるので、 フィールドを disabled にして混乱を防ぐ
      const pb = $('publicBase');
      if (pb) {
        pb.disabled = (v === 'central');
        pb.title = pb.disabled
          ? '中央サーバー使用中: 公開URL は中央サーバー側の設定 (passist.paps.jp) が使われます'
          : 'cloudflared 等のトンネル URL を入れて「URL を再発行」';
      }
    }
    for (const r of document.querySelectorAll('input[name="serverMode"]')) {
      r.checked = r.value === smVal;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        if (cfg.settings) cfg.settings.serverMode = r.value;
        window.host.settingsSet({ serverMode: r.value });
        renderServerModeUi();
        // V-18: 再起動 hint は出さない。 main 側 (settings:set ハンドラ) が
        //   webContents.reload() で renderer を自動再読込するので、 ユーザー再起動は不要。
      });
    }
    $('centralServerUrl').addEventListener('change', () => {
      const v = $('centralServerUrl').value.trim();
      if (cfg.settings) cfg.settings.centralServerUrl = v;
      window.host.settingsSet({ centralServerUrl: v });
      renderServerModeUi();
      // V-18: 同上、 再起動 hint は不要 (main 側で自動 reload)
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
    // sessionStorage に開閉状態とアクティブタブを保存し、 language 切替リロード後も復元する。
    const SETTINGS_OPEN_KEY = 'passist-settings-open';
    const SETTINGS_TAB_KEY = 'passist-settings-tab';
    const openSettings = () => {
      $('settingsModal').classList.remove('hidden');
      try { sessionStorage.setItem(SETTINGS_OPEN_KEY, '1'); } catch {}
    };
    const closeSettings = () => {
      $('settingsModal').classList.add('hidden');
      try { sessionStorage.removeItem(SETTINGS_OPEN_KEY); } catch {}
    };
    $('settingsBtn').onclick = openSettings;
    $('settingsClose').onclick = closeSettings;
    $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('settingsModal').classList.contains('hidden')) closeSettings();
    });
    // 設定モーダル内のタブ切替（基本 / くわしい設定 / AI 連携）。 タブ選択も sessionStorage に保存。
    const activateTab = (tabName) => {
      document.querySelectorAll('#settingsModal .tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
      document.querySelectorAll('#settingsModal .tab-content').forEach((c) => c.classList.toggle('hidden', c.id !== 'tab-' + tabName));
      if (tabName === 'ai') { refreshAiClients(); refreshAiConsents(); }
    };
    document.querySelectorAll('#settingsModal .tabs .tab').forEach((tab) => {
      tab.onclick = () => {
        activateTab(tab.dataset.tab);
        try { sessionStorage.setItem(SETTINGS_TAB_KEY, tab.dataset.tab); } catch {}
      };
    });
    if ($('aiRefresh')) $('aiRefresh').onclick = () => { refreshAiClients(); refreshAiConsents(); };
    // リロード前の状態を復元 (言語切替リロード後など)
    try {
      const savedTab = sessionStorage.getItem(SETTINGS_TAB_KEY);
      if (savedTab) activateTab(savedTab);
      if (sessionStorage.getItem(SETTINGS_OPEN_KEY) === '1') $('settingsModal').classList.remove('hidden');
    } catch {}
    // 言語切替ボタンの bind は i18n.js の applyI18n が自動でやる (CSP 制約下でも動く)。
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
      // 「終了」=現在の接続を全て切るが、 同じ URL で「もう一度共有」できるよう
      // token/hostSecret は保持する（M-2 の復元経路で同 token のセッションが再作成される）。
      // 「自動再開（前回ウィンドウを起動時に拾う）」だけは無効化する（再起動後の意図しない再共有を防ぐ）。
      window.host.settingsSet({ activeShareName: '' });
      shouldReconnect = false; // 明示的終了 = WS が閉じても自動再接続しない
      clearReconnect();
      stopWatch();
      closeAllPeers();
      sessionStarted = false; // 次に画面を選ぶと新しいURLで開始
      setStatus(tr('host.dyn.endShared'));
      endShareUi(); // 終了ボタンを「再開」へ
    };
    await loadWindows();
    maybeResume(); // 前回「終了」を押していなければ、同じウィンドウの共有を自動再開（無ければ起動を監視）
    attachMcpBridge(); // MCP (AI 連携) からの操作リクエストを受け付ける
  }

  // === 設定タブ「AI 連携」 のリスト更新 ===
  async function refreshAiClients() {
    const el = $('aiClientsList');
    if (!el || !window.host || !window.host.mcpAdmin) return;
    el.innerHTML = '';
    try {
      const list = await window.host.mcpAdmin.listClients();
      if (!list.length) { el.innerHTML = '<div class="ai-empty">' + tr('host.ai.empty') + '</div>'; return; }
      for (const c of list) {
        const row = document.createElement('div'); row.className = 'ai-item';
        const name = document.createElement('div'); name.className = 'ai-name';
        name.textContent = c.name;
        row.appendChild(name);
        const status = document.createElement('span'); status.className = 'ai-status';
        let statusKey, statusCls, canToggle;
        if (!c.exists) { statusKey = 'host.ai.status.notInstalled'; statusCls = ''; canToggle = false; }
        else if (c.configured) { statusKey = 'host.ai.status.enabled'; statusCls = 'ok'; canToggle = true; }
        else { statusKey = 'host.ai.status.disabled'; statusCls = 'off'; canToggle = true; }
        status.textContent = tr(statusKey);
        if (statusCls) status.classList.add(statusCls);
        row.appendChild(status);
        if (canToggle) {
          const btn = document.createElement('button');
          btn.textContent = c.configured ? tr('host.ai.btn.disable') : tr('host.ai.btn.enable');
          btn.onclick = async () => {
            btn.disabled = true;
            try {
              if (c.configured) await window.host.mcpAdmin.disableClient(c.id);
              else await window.host.mcpAdmin.enableClient(c.id);
            } catch (e) { alert('操作失敗: ' + e.message); }
            refreshAiClients();
          };
          row.appendChild(btn);
        }
        el.appendChild(row);
      }
    } catch (e) {
      el.innerHTML = '<div class="ai-empty">取得失敗: ' + e.message + '</div>';
    }
  }
  async function refreshAiConsents() {
    const el = $('aiConsentsList');
    if (!el || !window.host || !window.host.mcpAdmin) return;
    el.innerHTML = '';
    try {
      const list = await window.host.mcpAdmin.listConsents();
      if (!list.length) { el.innerHTML = '<div class="ai-empty">' + tr('host.ai.empty') + '</div>'; return; }
      for (const c of list) {
        const row = document.createElement('div'); row.className = 'ai-item';
        const name = document.createElement('div'); name.className = 'ai-name';
        name.textContent = c.label || c.exePath || c.key;
        if (c.exePath && c.label && c.exePath !== c.label) {
          const meta = document.createElement('div'); meta.className = 'ai-meta';
          meta.textContent = c.exePath;
          name.appendChild(document.createElement('br'));
          name.appendChild(meta);
        }
        row.appendChild(name);
        const status = document.createElement('span'); status.className = 'ai-status';
        if (c.state === 'always') { status.textContent = tr('host.ai.consent.always'); status.classList.add('ok'); }
        else if (c.state === 'deny') { status.textContent = tr('host.ai.consent.deny'); status.classList.add('off'); }
        else { status.textContent = tr('host.ai.consent.once'); }
        row.appendChild(status);
        const btn = document.createElement('button');
        btn.textContent = tr('host.ai.btn.revoke');
        btn.onclick = async () => {
          btn.disabled = true;
          try { await window.host.mcpAdmin.revokeConsent(c.key); } catch (e) { alert('取消失敗: ' + e.message); }
          refreshAiConsents();
        };
        row.appendChild(btn);
        el.appendChild(row);
      }
    } catch (e) {
      el.innerHTML = '<div class="ai-empty">取得失敗: ' + e.message + '</div>';
    }
  }

  // main から飛んでくる MCP 由来の問い合わせを処理して reply する。
  // host が AI から「画面を共有して」 と頼まれたときの実体。
  function attachMcpBridge() {
    if (!window.host || !window.host.onMcpRequest) return;
    window.host.onMcpRequest(async (type, payload) => {
      const reqId = payload && payload._reqId;
      try {
        if (type === 'get-share-state') {
          const urlVal = ($('url') && $('url').value) || '';
          const viewerList = [...peers.keys()].map((id) => ({ id, mode: id === controllerId ? 'operate' : 'view' }));
          const pendingList = reqQueue.map((r) => ({ id: r.viewerId }));
          const s = (cfg && cfg.settings) || {};
          return window.host.replyMcp(reqId, {
            active: !!sessionStarted && !!urlVal,
            url: urlVal || null,
            sharedWindow: lastSharedWindow ? { id: lastSharedWindow.id, title: lastSharedWindow.name } : null,
            accessMode: s.accessMode || 'approve',
            maxViewers: s.maxViewers || 1,
            readonly: !!s.readonly,
            viewers: viewerList,
            pending: pendingList,
          }, null);
        }
        if (type === 'start-share') {
          // 設定変更があれば反映 (次の共有から有効になる項目もあるが MCP 経由は即時)
          if (payload.accessMode && cfg && cfg.settings) { cfg.settings.accessMode = payload.accessMode; await window.host.settingsSet({ accessMode: payload.accessMode }); }
          if (payload.maxViewers && cfg && cfg.settings) { cfg.settings.maxViewers = payload.maxViewers; await window.host.settingsSet({ maxViewers: payload.maxViewers }); }
          if (payload.ttlMinutes !== undefined && cfg && cfg.settings) { cfg.settings.sessionTtlMinutes = payload.ttlMinutes; await window.host.settingsSet({ sessionTtlMinutes: payload.ttlMinutes }); }
          if (payload.readonly !== undefined && cfg && cfg.settings) { cfg.settings.readonly = !!payload.readonly; await window.host.settingsSet({ readonly: !!payload.readonly }); }
          // ウィンドウを選ぶ → choose() が signaling→URL までやってくれる
          const w = { id: payload.windowId, name: payload.windowName || payload.windowId };
          await choose(w);
          // URL が出るまで最大 10 秒待つ (signaling のレスポンス次第)
          let urlVal = '';
          for (let i = 0; i < 100; i++) {
            urlVal = ($('url') && $('url').value) || '';
            if (urlVal) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!urlVal) return window.host.replyMcp(reqId, null, 'timed out waiting for share URL');
          // QR は qrImg.src に同期で生成される (qrToggle 押下時)。 ここでは省略 (Phase 1 MVP)。
          return window.host.replyMcp(reqId, {
            url: urlVal,
            sharedWindow: { id: w.id, title: w.name },
          }, null);
        }
        if (type === 'end-share') {
          // 「終了」ボタンと同じロジックを呼ぶ
          const endBtn = $('end');
          if (endBtn && endBtn.dataset && endBtn.dataset.mode !== 'resume' && sessionStarted) {
            endBtn.click();
          }
          return window.host.replyMcp(reqId, { ok: true }, null);
        }
        return window.host.replyMcp(reqId, null, 'unknown mcp request type: ' + type);
      } catch (e) {
        return window.host.replyMcp(reqId, null, e.message || String(e));
      }
    });
  }

  async function loadWindows() {
    const grid = $('grid');
    grid.innerHTML = '<p class="hint">' + tr('host.picker.loading') + '</p>';
    // V-27: window/screen と webcam を並行取得。 webcam は先頭に並べる (よく使う想定)。
    const [wins, cams] = await Promise.all([
      window.host.listWindows(),
      listCameras(),
    ]);
    const items = [...cams, ...wins];
    grid.innerHTML = '';
    if (!items.length) {
      grid.innerHTML = '<p class="hint">' + tr('host.picker.empty') + '</p>';
      return;
    }
    for (const w of items) {
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
      // V-26: screen は 🖥️、 V-27: webcam は 📷 プレフィックスで一目で分かるように
      label.textContent = w.isCamera ? '📷 ' + w.name
        : w.isScreen ? '🖥️ ' + w.name
        : w.name;
      cap.appendChild(label);
      if (w.isCamera) {
        const sub = document.createElement('span');
        sub.className = 'subhint';
        sub.textContent = tr('host.picker.cameraSub');
        cap.appendChild(sub);
        card.title = tr('host.picker.cameraTitle');
      } else if (w.isScreen) {
        const sub = document.createElement('span');
        sub.className = 'subhint';
        sub.textContent = tr('host.picker.screenSub');
        cap.appendChild(sub);
        card.title = tr('host.picker.screenTitle');
      } else if (w.owned) {
        // owned 窓（アプリ本体に付随する別ウィンドウ）。どの本体のものか分かるよう注記。
        const sub = document.createElement('span');
        sub.className = 'subhint';
        sub.textContent = w.ownerName ? '↳ ' + w.ownerName : tr('host.picker.subWindow');
        cap.appendChild(sub);
        card.title = (w.ownerName ? w.ownerName + ' の' : '') + '付随ウィンドウ（通常は一覧に出ない別画面）';
      }
      card.append(thumb, cap);
      card.onclick = () => choose(w);
      grid.appendChild(card);
    }
  }

  async function capture() {
    // V-27: webcam (isCamera=true) の場合は getUserMedia で直接デバイスから取得。
    //   通常のウィンドウ / screen は getDisplayMedia (main 側 setDisplayMediaRequestHandler 経由)。
    if (lastSharedWindow && lastSharedWindow.isCamera) {
      const deviceId = String(lastSharedWindow.id || '').replace(/^camera:/, '');
      return await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    }
    // 選択ウィンドウは main 側の setDisplayMediaRequestHandler が selectedSourceId で固定して返す。
    // （古い getUserMedia + chromeMediaSource:'desktop' は新しい Electron で不安定/クラッシュ要因のため使わない）
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  }

  // V-27: 利用可能な webcam を列挙して picker に足す。 label が空の時 (permission 未取得時) は
  //   仮の名前 (Webcam 1, Webcam 2) で表示。 実際に選択された時に getUserMedia が走って
  //   permission ダイアログ が出る (main.js 側で setPermissionRequestHandler を許可済み)。
  // V-27.1: 同名カメラ (同じモデルを 2 台挿してる等) を見分けられるよう、 重複したら
  //   末尾に (1), (2)... を自動付与。 単独の label は素のまま。
  async function listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      let fallbackIdx = 0;
      const bases = cams.map((d) => d.label || tr('host.picker.cameraFallback', { n: ++fallbackIdx }));
      const totals = new Map();
      for (const b of bases) totals.set(b, (totals.get(b) || 0) + 1);
      const seen = new Map();
      return cams.map((d, i) => {
        const base = bases[i];
        let name = base;
        if (totals.get(base) > 1) {
          const n = (seen.get(base) || 0) + 1;
          seen.set(base, n);
          name = `${base} (${n})`;
        }
        return {
          id: 'camera:' + d.deviceId,
          name,
          thumbnail: null,
          appIcon: null,
          isCamera: true,
        };
      });
    } catch (e) {
      console.warn('[host] camera enumeration failed:', e && e.message);
      return [];
    }
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
      alert(tr('host.dyn.captureFail', { error: e.message }));
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
    startFrameWatchdog(); // V-25: フレームが止まった時にも onended と同じ経路で復旧に流す
  }

  // V-25: フレーム停滞監視。 WGC の getFrame 失敗 (Windows Graphics Capture のタイムアウト等) は
  //   MediaStreamTrack を 'ended' に落とさないため、 V-23 の onended ハンドラでは検出できない。
  //   preview の currentTime が 15 秒 (5 秒 × 3 回連続で進まない) 動かなければ frame が止まった
  //   とみなして handleCaptureLost() に流す → V-23 の recapture 経路に載る。
  //   V-25 は「track が live なのにフレームが来ない」 という中途半端状態を専門にケアする。
  // V-25.1: 初回フレーム到達待ちの間 videoWidth=0 だが、 WGC が「一度もフレームを返せない」
  //   ケース (対象窓が最小化・elevated・DRM 保護等) では従来 skip し続けて発火しなかった。
  //   startFrameWatchdog 起動時刻を記録し、 20 秒経っても videoWidth=0 なら stall とみなして発火。
  let frameWatchdogTimer = null;
  let frameWatchdogLastTime = 0;
  let frameWatchdogStallCount = 0;
  let frameWatchdogFirstFrameAwaitStart = 0;
  function startFrameWatchdog() {
    stopFrameWatchdog();
    frameWatchdogLastTime = 0;
    frameWatchdogStallCount = 0;
    frameWatchdogFirstFrameAwaitStart = Date.now();
    frameWatchdogTimer = setInterval(() => {
      const v = $('preview');
      if (!v || !v.srcObject) return; // 共有中でない = 監視スキップ
      if (!v.videoWidth) {
        // V-25.1: 20 秒経っても 1 枚目が来ない = WGC が完全に詰まってる → 発火
        if (frameWatchdogFirstFrameAwaitStart && Date.now() - frameWatchdogFirstFrameAwaitStart > 20000) {
          console.warn('[host] no first frame within 20s → triggering handleCaptureLost');
          frameWatchdogFirstFrameAwaitStart = 0;
          handleCaptureLost();
        }
        return;
      }
      // 1 枚目が到達したので await タイマは無効化、 定常の stall 監視に切り替え
      frameWatchdogFirstFrameAwaitStart = 0;
      const now = v.currentTime;
      if (now === frameWatchdogLastTime) {
        frameWatchdogStallCount++;
        if (frameWatchdogStallCount >= 3) {
          console.warn('[host] frame stall detected (~15s no advance), triggering handleCaptureLost');
          frameWatchdogStallCount = 0;
          frameWatchdogLastTime = 0;
          handleCaptureLost(); // async だが await せず fire-and-forget (次の tick で recovery が走る)
        }
      } else {
        frameWatchdogStallCount = 0;
        frameWatchdogLastTime = now;
      }
    }, 5000);
  }
  function stopFrameWatchdog() {
    if (frameWatchdogTimer) { clearInterval(frameWatchdogTimer); frameWatchdogTimer = null; }
    frameWatchdogLastTime = 0;
    frameWatchdogStallCount = 0;
    frameWatchdogFirstFrameAwaitStart = 0;
  }

  // V-23: 共有トラックが 'ended' に落ちた際の自動復旧。
  //   長時間稼働の途中で MediaStreamTrack が dead になる (Chromium キャプチャエンジンの内部エラー、
  //   ウィンドウ最小化からの復帰、 権限一時失効等) と、 新規 viewer 接続が「接続中… 映像を待って
  //   います」 で止まる。 ユーザに毎回「画面を選び直す」 操作を強いるのは監視用途で致命的なので、
  //   まず同じ selectedSourceId で getDisplayMedia を再取得し、 既存 peer には replaceTrack で
  //   差し替え (再ネゴ不要) → viewer 側は無停止で映像復活。
  //   復旧不能 (ウィンドウが本当に閉じた / 権限失効) の場合のみ従来の撤収処理へ。
  //   短時間 (10 秒以内) に何度も onended が発火する状況 = 系統的な問題なので、 ループ回避で撤収する。
  let lastRecaptureAt = 0;
  async function handleCaptureLost() {
    if (Date.now() - lastRecaptureAt < 10000) {
      console.warn('[host] track ended again within 10s of recapture — giving up, falling to teardown');
      return teardownCapture();
    }
    lastRecaptureAt = Date.now();
    const recovered = await tryAutoRecapture();
    if (recovered) return;
    return teardownCapture();
  }
  async function tryAutoRecapture() {
    if (!lastSharedWindow) return false; // 初回選択前は復旧しようがない
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // V-23.1: 対象アプリが再描画で HWND を作り直すケース (Electron 系や UWP でよくある) に対応。
        //   保存された window 名で最新の windows:list を引き直し、 一致するものがあれば
        //   selectSource で HWND を更新してから capture する。 これが「画面を選び直す」 操作の
        //   自動版。 見つからない (窓が本当に閉じた) 場合は従来通り古い ID で試して失敗させる。
        //   V-27: webcam の場合は HWND という概念が無いのでこのステップはスキップ。
        //   deviceId は不変前提 (USB 抜き差しで変わるケースは capture() で throw → 別 attempt)。
        if (!lastSharedWindow.isCamera) {
          try {
            const list = await window.host.listWindows();
            const match = list.find((w) => w.name === lastSharedWindow.name);
            if (match && match.id !== lastSharedWindow.id) {
              await window.host.selectSource(match.id, match.name);
              lastSharedWindow = { id: match.id, name: match.name };
              console.log(`[host] auto-recapture: window HWND changed, updated to ${match.id}`);
            }
          } catch (e) {
            console.warn('[host] auto-recapture: listWindows failed:', e && e.message);
          }
        }
        const newStream = await capture(); // 更新済み selectedSourceId で新しい窓の stream を取得
        const newTrack = newStream.getVideoTracks()[0];
        if (!newTrack || newTrack.readyState !== 'live') {
          try { newStream.getTracks().forEach((t) => t.stop()); } catch {}
          throw new Error('new track not live');
        }
        // V-23.2: track.readyState だけでは「live だがフレーム 0」 の擬似成功を検出できない。
        //   WGC (Windows Graphics Capture) は共有対象が最小化・保護状態・elevated 等の場合、
        //   getFrame を 5 秒ごとに timeout し続ける (track は live のまま)。
        //   実 frame が届いているかを preview の videoWidth で検証する。
        const preview = $('preview');
        preview.srcObject = newStream;
        await new Promise((r) => setTimeout(r, 3000)); // 最初のフレームが届く時間を待つ
        if (!preview.videoWidth || preview.videoWidth === 0) {
          try { newStream.getTracks().forEach((t) => t.stop()); } catch {}
          throw new Error('no frames after 3s (WGC likely timing out)');
        }
        // 既存 peer の video sender を新 track に差し替え (再ネゴ無し = viewer 無停止)
        for (const [, p] of peers.entries()) {
          const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { console.warn('[host] replaceTrack failed:', e.message); } }
        }
        // 旧 stream を止めて差し替え、 preview も更新
        const old = stream;
        stream = newStream;
        try { $('preview').srcObject = stream; } catch {}
        if (old) { try { old.getTracks().forEach((t) => t.stop()); } catch {} }
        // 新 track が 2 秒以上生きたら onended ハンドラを掛け直す (即死しても無限ループにしない)
        setTimeout(() => { if (newTrack.readyState === 'live') newTrack.onended = handleCaptureLost; }, 2000);
        startFrameWatchdog(); // V-25: 新 stream に対しても frame stall 監視を再開
        console.log(`[host] auto-recapture success on attempt ${attempt}`);
        return true;
      } catch (e) {
        console.warn(`[host] auto-recapture attempt ${attempt} failed: ${e && e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }
    return false;
  }
  // 共有していたウィンドウが消失したときの撤収処理。
  // セッション(URL/接続/承認)は維持して、ユーザーは「← 別の画面を選ぶ」で別ウィンドウを共有し直せる。
  // ホスト側の selectedSourceId と activeShareName をクリアして、無効HWND への以後のアクセスを止める。
  function teardownCapture() {
    stopFrameWatchdog(); // V-25: 共有停止時は監視も止める (recovery 経路の無限ループ抑止)
    try { $('preview').srcObject = null; } catch {}
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      stream = null;
    }
    // V-23.3: activeShareName は保持する。 消してしまうと V-24 の日次自動再起動後に
    // maybeResume() が early return して picker で止まってしまうため。 窓が本当に消えた
    // ケースでも maybeResume() → findWindowByName() が null を返し → startWatch() で
    // 「窓の起動を待つ」 状態に落ちるだけで crash 経路にはならない (元コメントの「再クラッシュ」
    // 懸念は現行 main.js の setDisplayMediaRequestHandler では発生しない)。
    // 明示的な「終了」 ボタンは別途 activeShareName='' を設定するため、 ユーザ意図的な終了は
    // このまま尊重される (line 247 参照)。
    // ホスト側の selectedSourceId をクリア → 無効HWND での setDisplayMediaRequestHandler 応答や入力注入を止める
    try { window.host.selectSource(null, null); } catch {}
    setStatus(tr('host.dyn.windowClosed'));
    // V-23.4: 24h 監視用途だと session 画面のまま止めてもユーザに気付かれない。 picker を
    // 強制展開して再選択を視覚的に促す。 既存 viewer の接続 URL / 承認状態は保持されているので、
    // 再選択したら choose() の replaceTrack で無停止で映像が復活する。
    openPickerForReselect();
    // V-23.6: 対象アプリが「再起動」 系のケースでは、 一時的に窓が消えて数秒〜数十秒後に
    //   同名で戻ってくる。 startWatch (4 秒毎の polling) を起動しておけば、 復活した瞬間に
    //   findWindowByName が拾って choose(src, {auto:true}) で自動再共有される。
    //   ユーザがその場に居なくても勝手に復旧するので 24h 監視で有効。
    try {
      const s = cfg && cfg.settings;
      const name = s && s.activeShareName;
      if (name) startWatch(name);
    } catch (e) { console.warn('[host] startWatch after teardown failed:', e && e.message); }
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

  // V-23.5: 対象アプリの window title は同じ窓でも「-」 「(未保存)」 等の suffix が動的に
  //   変わることが多い。 lastSharedWindow.name と現在の window の name が微妙に違うだけで
  //   findWindowByName が null 返しになり teardown 経路に落ちるのを防ぐ。
  //   末尾の「- xxx」 「(xxx)」 「[xxx]」 を剥がしたキャノニカル名で追加比較する。
  function canonicalWindowName(name) {
    if (!name) return '';
    return String(name)
      .replace(/\s*[\-—–\|]\s*[^\-—–\|]+$/, '') // 末尾 " - Something" を除去
      .replace(/\s*\([^)]*\)\s*$/, '')            // 末尾 "(unsaved)" 等を除去
      .replace(/\s*\[[^\]]*\]\s*$/, '')           // 末尾 "[modified]" 等を除去
      .trim();
  }
  async function findWindowByName(name) {
    // V-27: window / screen に加え webcam も探索対象に。
    const [wins, cams] = await Promise.all([window.host.listWindows(), listCameras()]);
    const all = [...cams, ...wins];
    // Level 1: 完全一致
    let hit = all.find((w) => w.name === name);
    if (hit) return hit;
    // Level 2: 部分一致 (双方向)
    hit = all.find((w) => w.name && (w.name.includes(name) || name.includes(w.name)));
    if (hit) return hit;
    // Level 3: V-23.5 canonical name (suffix 除去) で再比較
    const canon = canonicalWindowName(name);
    if (canon && canon !== name) {
      hit = all.find((w) => canonicalWindowName(w.name) === canon);
      if (hit) return hit;
      hit = all.find((w) => {
        const c = canonicalWindowName(w.name);
        return c && (c.includes(canon) || canon.includes(c));
      });
      if (hit) return hit;
    }
    return null;
  }

  function startWatch(name) {
    stopWatch();
    showWatch('対象ウィンドウ「' + name + '」の起動を待っています…（見つかり次第、自動で共有を再開します）');
    watchTimer = setInterval(async () => {
      const src = await findWindowByName(name);
      if (src) { choose(src, { auto: true }); return; } // choose 内で stopWatch される
      // V-23.7: 一致無しでも picker が見えているならリストを最新化。
      //   ユーザが手動で「更新」 ボタンを押さなくても、 対象窓が復活したらすぐ表示に現れる。
      const picker = $('picker');
      if (picker && !picker.classList.contains('hidden')) {
        try { await loadWindows(); } catch {}
      }
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
    b.append(tr('host.dyn.resumePrev', { name: w.name }));
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '▶ ' + tr('host.btn.resume').replace(/^▶\s*/, '');
    btn.onclick = () => choose(w, { auto: false });
    b.appendChild(btn);
    b.classList.remove('hidden');
  }

  // ホスト WS 自動再接続。 リモート監視用途で「絶対落ちない」ため回数上限を設けず、
  // delay 上限 (30 秒) だけで暴走を抑制する。 host:end / expired / sessionStarted=false（picker）
  // では shouldReconnect=false にして停止。 成功した host:create で existingToken/hostSecret
  // を送るため、URL は再接続前と同じが維持される。
  let shouldReconnect = true;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) return;
    // 500ms, 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... (Math.min で頭打ち)
    const delay = Math.min(30000, 500 * Math.pow(2, Math.min(reconnectAttempt, 6)));
    reconnectAttempt++;
    setStatus(tr('host.dyn.reconnecting', { n: reconnectAttempt, max: '∞' }));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startSignaling(); }, delay);
  }

  function startSignaling() {
    shouldReconnect = true;  // 新規開始 or 再開 = 自動再接続を有効化（host:end / expired で再度 false に）
    clearReconnect();
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {} } // 旧接続を確実に閉じてから張り直す
    ws = new WebSocket(cfg.signalWs);
    ws.onopen = () => {
      reconnectAttempt = 0; // 接続成功でカウンタをリセット
      // V-17: 中央サーバーモード時は publicBaseUrl を送らない。
      //   送ってしまうと中央サーバが override として採用し、 「くわしい設定」 に残った
      //   古い cafe.paps.jp 等で viewer URL が組まれてしまう。 central は環境変数
      //   PUBLIC_BASE_URL=passist.paps.jp に任せる。 self モードのときだけ送る。
      const isCentral = ((cfg.settings && cfg.settings.serverMode) || 'central') === 'central';
      sendWs({
        type: 'host:create',
        publicBaseUrl: isCentral ? undefined : ($('publicBase').value.trim() || undefined),
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

  // viewerAudit に情報を追記/更新。 max 件超過したら最古を削除（過去履歴の上限）。
  function updateAuditInfo(viewerId, patch) {
    if (viewerId == null) return;
    const cur = viewerAudit.get(viewerId) || {};
    viewerAudit.set(viewerId, { ...cur, ...patch });
    // 削除候補は state=left|kicked のうち最古の leftAt から（接続中の人を消さない）
    if (viewerAudit.size > VIEWER_AUDIT_MAX) {
      const candidates = [...viewerAudit.entries()].filter(([, a]) => a.state === 'left' || a.state === 'kicked');
      candidates.sort((a, b) => (a[1].leftAt || 0) - (b[1].leftAt || 0));
      while (viewerAudit.size > VIEWER_AUDIT_MAX && candidates.length) {
        viewerAudit.delete(candidates.shift()[0]);
      }
    }
  }

  // ホストUI に「接続中の viewer 一覧 + 個別切断ボタン + 過去履歴」を描画。
  // IP / 接続時刻を表示することで「いま誰が見ているか」をホスト自身が把握できる（透明性）。
  function renderViewerList() {
    const el = document.getElementById('viewerList');
    if (!el) return;
    const items = [...viewerAudit.entries()];
    if (!items.length) { el.innerHTML = ''; return; }
    // 接続中→ pending → 過去 の順で
    const order = { connected: 0, pending: 1, left: 2, kicked: 3 };
    items.sort((a, b) => (order[a[1].state] ?? 9) - (order[b[1].state] ?? 9) || (b[1].joinedAt || 0) - (a[1].joinedAt || 0));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const fmt = (ts) => { if (!ts) return ''; const d = new Date(ts); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2); };
    const stateLabel = (a) =>
      a.state === 'connected' ? tr('host.viewerList.connected')
      : a.state === 'pending' ? tr('host.viewerList.pending')
      : a.state === 'kicked'  ? tr('host.viewerList.kicked')
      :                          tr('host.viewerList.left');
    const rows = items.map(([vid, a]) => {
      const isActive = a.state === 'connected' || a.state === 'pending';
      const kickBtn = isActive ? `<button class="ghost small" data-kick="${esc(vid)}" title="${esc(tr('host.viewerList.kickTitle'))}">${esc(tr('host.viewerList.kickBtn'))}</button>` : '';
      const time = a.state === 'connected' || a.state === 'pending'
        ? tr('host.viewerList.timeIn',  { t: fmt(a.joinedAt) })
        : tr('host.viewerList.timeOut', { t: fmt(a.leftAt || a.joinedAt) });
      return `<li class="vl-row" data-state="${esc(a.state)}">
        <span class="vl-state">${esc(stateLabel(a))}</span>
        <span class="vl-ip" title="${esc(a.ua)}">${esc(a.ip || tr('host.viewerList.unknownIp'))}</span>
        <span class="vl-time">${esc(time)}</span>
        ${kickBtn}
      </li>`;
    }).join('');
    el.innerHTML = '<ul class="vl-list">' + rows + '</ul>';
    el.querySelectorAll('button[data-kick]').forEach((b) => { b.onclick = () => kickViewer(b.dataset.kick); });
  }

  function kickViewer(viewerId) {
    sendWs({ type: 'host:kick', viewerId });
    // UI は viewer:kicked で更新される（サーバ側からのエコー）
  }

  function onMsg(msg) {
    switch (msg.type) {
      case 'session':
        serverIceServers = Array.isArray(msg.iceServers) ? msg.iceServers : null; // サーバ配布の STUN/TURN を採用
        $('url').value = msg.viewerUrl;
        verifyAppliedBase(msg.viewerUrl); // 入力した公開URLが実際に反映されたか確認
        if (!$('qrPanel').classList.contains('hidden')) showQr(); // URL確定時にQRを更新
        if (msg.pin) {
          $('pin').textContent = tr('host.dyn.pinLabel', { pin: msg.pin });
          $('pin').classList.remove('hidden');
        }
        // セッション引き継ぎ用に token/secret を永続化（次回起動時に同じ URL を取り戻すため）。
        // resumed=true ならサーバが既存セッションを引き継いだ／復元した。
        if (msg.token && msg.hostSecret) {
          window.host.settingsSet({ lastHostToken: msg.token, lastHostSecret: msg.hostSecret });
          if (cfg.settings) { cfg.settings.lastHostToken = msg.token; cfg.settings.lastHostSecret = msg.hostSecret; }
        }
        setStatus(msg.resumed ? tr('host.dyn.resumed') : tr('host.dyn.waitingViewer'));
        break;
      case 'viewer:request':
        reqQueue.push({ viewerId: msg.viewerId, auth: msg.auth || null, ip: msg.ip || '', ua: msg.ua || '' });
        updateAuditInfo(msg.viewerId, { ip: msg.ip, ua: msg.ua, joinedAt: msg.joinedAt || Date.now(), state: 'pending' });
        processReqQueue();
        break;
      case 'viewer:joined':
        updateAuditInfo(msg.viewerId, { ip: msg.ip, ua: msg.ua, joinedAt: msg.joinedAt || Date.now(), state: 'connected' });
        startPeerFor(msg.viewerId);
        renderViewerList();
        break;
      case 'viewer:left':
        closePeerFor(msg.viewerId);
        // 履歴は残しつつ、 接続状態だけ切替
        if (viewerAudit.has(msg.viewerId)) { const a = viewerAudit.get(msg.viewerId); a.state = 'left'; a.leftAt = Date.now(); }
        renderViewerList();
        break;
      case 'viewer:kicked':
        // 自分が host:kick した結果。 既に closePeerFor で対応済みなので UI更新だけ
        if (viewerAudit.has(msg.viewerId)) { const a = viewerAudit.get(msg.viewerId); a.state = 'kicked'; a.leftAt = Date.now(); }
        renderViewerList();
        break;
      case 'signal':
        handleSignal(msg.from, msg.data);
        break;
      case 'expired':
        setStatus(tr('host.dyn.expired'));
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
    el.textContent = tr('host.dyn.turnRelay', { n: bitratePolicy.relayCount, kbps: Math.round(bitratePolicy.maxBpsRelay / 1000) });
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
    if (!raw) { hint.textContent = tr('host.set.publicBase.hint.empty'); hint.classList.remove('danger-hint'); return ''; }
    const norm = normBase(raw);
    if (!norm) {
      hint.textContent = tr('host.set.publicBase.hint.invalid');
      hint.classList.add('danger-hint');
      return '';
    }
    hint.textContent = tr('host.set.publicBase.hint.ok', { url: norm });
    hint.classList.remove('danger-hint');
    return norm;
  }
  // 発行後、入力した公開URLが実際に使われたか確認（不正ならサーバが捨てて LAN/IP になっている）。
  function verifyAppliedBase(viewerUrl) {
    const hint = $('publicBaseHint'); if (!hint) return;
    const want = normBase(($('publicBase').value || '').trim());
    if (want && viewerUrl && viewerUrl.indexOf(want) !== 0) {
      hint.textContent = tr('host.set.publicBase.hint.fallback', { url: viewerUrl });
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
    if (!u) { hint.textContent = tr('host.set.turn.hint.empty'); hint.classList.remove('danger-hint'); return; }
    const v = validateTurnUrl(u);
    if (!v.ok) { hint.textContent = tr('host.set.turn.hint.invalid'); hint.classList.add('danger-hint'); return; }
    hint.textContent = tr('host.set.turn.hint.ok', { scheme: v.scheme.toUpperCase(), host: v.host, port: v.port, transport: v.transport.toUpperCase() });
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
        setStatus(tr('host.dyn.trustedAuto', { label: res.label ? '（' + res.label + '）' : '' }));
        activeReq = null;
        processReqQueue();
        return;
      }
    }
    // 招待リンクモード: 招待されていない相手は手動承認させず自動拒否（誤って許可しないため）
    const mode = (cfg.settings && cfg.settings.accessMode) || 'approve';
    if (mode === 'invite') {
      sendWs({ type: 'host:deny', viewerId: req.viewerId });
      setStatus(tr('host.dyn.inviteOnlyReject'));
      activeReq = null;
      processReqQueue();
      return;
    }
    $('request').classList.remove('hidden');
    setStatus(tr('host.dyn.connRequest'));
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
      alert(tr('host.dyn.urlFirst'));
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
    el.textContent = tr('host.dyn.trustedCount', { n: list.length });
    if (!list.length) return;
    el.append('　');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = tr('host.dyn.clearAll');
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

  // V-28: stream を失った状態 (auto-recapture 3 回失敗 → teardownCapture 実行済み) で
  //   新規 viewer が来ると、 startPeerFor 内の stream.getTracks() で TypeError が投げられ、
  //   uncaught promise rejection になって viewer が offer を受け取れず永久待機した。
  //   picker を強制展開してユーザに再選択を促す + 状態バーで通知する。
  function openPickerForReselect() {
    try { $('session').classList.add('hidden'); } catch {}
    try { $('picker').classList.remove('hidden'); } catch {}
    try { loadWindows(); } catch (e) { console.warn('loadWindows failed:', e && e.message); }
  }

  // ビューアごとに peer 接続を張る（同じキャプチャ stream を各接続へ送る＝メッシュ）
  async function startPeerFor(viewerId) {
    // V-28: stream 無し状態での startPeerFor は早期 return。 従来は下の
    // stream.getTracks() が null で throw して silent 死になっていた。
    if (!stream) {
      console.warn(`[host] startPeerFor(${viewerId}): stream is null (recapture 済み/teardown 済み)、 picker を開いて再選択促す`);
      setStatus(tr('host.dyn.streamLostReselect'));
      openPickerForReselect();
      return;
    }
    closePeerFor(viewerId); // 再接続時の取りこぼし防止
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    // V-14: ICE restart 自動復活用の状態。 disconnected を 8 秒待ってから再交渉、 2 回まで再試行。
    const entry = { pc, dc: null, viaRelay: false, routeReported: null, disconnectTimer: null, iceRestartAttempts: 0 };
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
    // V-14: viewer 切断の自動復活ロジック。
    //   disconnected を 8 秒待ち、 戻らなければ ICE restart (pc.createOffer({iceRestart:true}))
    //   で同じ peer のまま candidate を再交渉する。
    //   V-21: リモート監視用途で「絶対落ちない」ため、 回数上限を撤廃して無限リトライ。
    //   delay は 8s → 15s → 30s → 60s と伸ばし、 60s で頭打ち。 復活まで諦めず、
    //   iceConnectionState が 'connected'/'completed' に戻ったら disconnectTimer をクリア。
    //   iOS Safari のバックグラウンド遷移 / 一時的ネットワーク断でも復活を続ける。
    function scheduleIceRestart(delayMs) {
      const cur = peers.get(viewerId);
      if (!cur || cur.pc !== pc) return;
      if (cur.disconnectTimer) clearTimeout(cur.disconnectTimer);
      cur.disconnectTimer = setTimeout(async () => {
        const c = peers.get(viewerId);
        if (!c || c.pc !== pc) return; // 既に張り替わっていたら停止
        if (['connected', 'completed'].includes(pc.iceConnectionState)) return; // 復活済み
        c.iceRestartAttempts++;
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          sendWs({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });
          console.log(`[host] ICE restart offer sent to viewer ${viewerId} (attempt ${c.iceRestartAttempts})`);
        } catch (err) {
          console.warn(`[host] ICE restart failed for viewer ${viewerId}:`, err && err.message);
        }
        // 諦めずに次のリトライを予約 (8s, 15s, 30s, 60s cap)
        const nextDelay = Math.min(60000, 8000 * Math.pow(2, Math.max(0, c.iceRestartAttempts - 1)));
        scheduleIceRestart(nextDelay);
      }, delayMs);
    }
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      const e = peers.get(viewerId);
      if (!e) return;
      if (s === 'connected' || s === 'completed') {
        detectAndReportRoute(viewerId); // 経路確定後にrelay/p2p判定
        if (e.disconnectTimer) { clearTimeout(e.disconnectTimer); e.disconnectTimer = null; }
        e.iceRestartAttempts = 0; // 復活したらリセット
      } else if (s === 'disconnected') {
        scheduleIceRestart(8000); // 8 秒の grace period (短時間の揺らぎは自然回復するので待つ)
      } else if (s === 'failed' || s === 'closed') {
        if (e.disconnectTimer) { clearTimeout(e.disconnectTimer); e.disconnectTimer = null; }
        // failed/closed は onconnectionstatechange で closePeerFor が呼ばれる
      }
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
    // V-14: ICE restart の保留タイマがあれば解除
    if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
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
    viewerAudit.clear(); // viewer 一覧（IP/接続時刻の表示）もリセット
    renderViewerList();
  }

  // 共有終了：終了ボタンを「▶ もう一度共有」 に切り替え、同じウィンドウで再開できる状態にする
  function endShareUi() {
    const e = $('end');
    e.disabled = false; // 再クリックで再開できるよう有効のまま
    e.textContent = tr('host.btn.resume');
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
    e.textContent = tr('host.btn.end');
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
    b.textContent = tr('host.session.copied');
    setTimeout(() => (b.textContent = orig), 1500);
  }

  const setStatus = (msg) => ($('status').textContent = msg);
  // i18n ヘルパ。 vars でテンプレ {key} を置換: tr('host.dyn.pinLabel', { pin: '123456' })
  const tr = (k, vars) => {
    let s = window.t ? window.t(k) : k;
    if (vars) for (const kk in vars) s = s.split('{' + kk + '}').join(vars[kk]);
    return s;
  };

  // 「接続方法」ラジオの下に出す説明（だれでも は警告色）
  function updateAccessHint() {
    const el = $('accessHint');
    if (!el) return;
    const v = (cfg.settings && cfg.settings.accessMode) || 'approve';
    el.textContent =
      v === 'approve' ? tr('host.set.access.hint.approve')
      : v === 'pin' ? tr('host.set.access.hint.pin')
      : v === 'invite' ? tr('host.set.access.hint.invite')
      : tr('host.set.access.hint.token');
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
    const access = s.accessMode === 'token' ? tr('host.dyn.chip.access.token')
                 : s.accessMode === 'pin' ? tr('host.dyn.chip.access.pin')
                 : s.accessMode === 'invite' ? tr('host.dyn.chip.access.invite')
                 : tr('host.dyn.chip.access.approve');
    const max = s.maxViewers || 1;
    const op = s.readonly ? tr('host.dyn.chip.op.viewOnly')
             : max > 1 ? tr('host.dyn.chip.op.firstOp')
             : tr('host.dyn.chip.op.ok');
    el.innerHTML = '';
    const chips = [
      tr('host.dyn.chip.access', { value: access }),
      tr('host.dyn.chip.concurrent', { n: max }),
      tr('host.dyn.chip.op', { value: op }),
      tr('host.dyn.chip.ttl', { value: ttlLabel(s.sessionTtlMinutes) }),
    ];
    for (const txt of chips) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = txt;
      el.appendChild(c);
    }
  }

  function ttlLabel(m) {
    const n = Number.isFinite(m) ? m : 30;
    if (n <= 0) return tr('host.set.ttl.infinite');
    if (n % 60 === 0) return tr('host.dyn.ttl.hours', { n: n / 60 });
    return tr('host.dyn.ttl.minutes', { n: n });
  }
})();
