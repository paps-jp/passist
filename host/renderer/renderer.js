/* ホスト側レンダラ（Chromium）。WebRTC の offer 側。
 * - 開いているウィンドウ一覧を表示 → 1つ選択 → そのウィンドウだけをキャプチャ
 * - シグナリングサーバに接続して共有URLを発行
 * - ビューア接続を承認したら映像トラックを送出、入力は DataChannel で受信して注入へ転送
 * - 複数同時接続(最大 maxViewers)に対応。操作できるのは1人だけ（最初の接続者）、他は閲覧のみ。 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let cfg, ws, stream;
  const peers = new Map(); // viewerId -> { pc, dc }
  let controllerId = null; // 操作権を持つビューアID（1人）。null=全員閲覧のみ
  let cursorStarted = false; // ホストのカーソル形状追跡を一度だけ開始するためのフラグ
  const reqQueue = []; // 承認待ちリクエストのキュー [{ viewerId, auth }]
  let activeReq = null; // 現在ダイアログ表示中のリクエスト
  let sessionStarted = false; // セッション確立済みか（別画面選択で「新規発行」か「映像差し替え」かを分岐）

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
    if (cfg.settings && cfg.settings.publicBaseUrl) $('publicBase').value = cfg.settings.publicBaseUrl;
    $('publicBase').addEventListener('change', () =>
      window.host.settingsSet({ publicBaseUrl: $('publicBase').value.trim() }),
    );
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
    // 接続方法（承認制 / PIN / だれでも）。変更は次の共有から有効。
    const accVal = (cfg.settings && cfg.settings.accessMode) || 'approve';
    for (const r of document.querySelectorAll('input[name="access"]')) {
      r.checked = r.value === accVal;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        if (cfg.settings) cfg.settings.accessMode = r.value;
        window.host.settingsSet({ accessMode: r.value });
        updateAccessHint();
        renderChips();
      });
    }
    updateAccessHint();
    // 有効期限（次の共有から有効）。0 = 無期限。
    $('ttlSel').value = String(cfg.settings && Number.isFinite(cfg.settings.sessionTtlMinutes) ? cfg.settings.sessionTtlMinutes : 30);
    $('ttlSel').addEventListener('change', () => {
      const m = parseInt($('ttlSel').value, 10);
      const v = Number.isFinite(m) ? m : 30;
      if (cfg.settings) cfg.settings.sessionTtlMinutes = v;
      window.host.settingsSet({ sessionTtlMinutes: v });
      renderChips();
    });
    $('settingsBtn').onclick = () => $('settingsPanel').classList.toggle('hidden'); // ⚙ 設定の開閉
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
      sendWs({ type: 'host:end' });
      window.host.settingsSet({ activeShareName: '' }); // 終了＝次回からの自動再開を解除
      stopWatch();
      closeAllPeers();
      sessionStarted = false; // 次に画面を選ぶと新しいURLで開始
      setStatus('✓ 共有を終了しました（このリンクはもう使えません）');
      endShareUi(); // 終了ボタンを無効化して「終了済み」を明示
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

  function startSignaling() {
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {} } // 旧接続を確実に閉じてから張り直す
    ws = new WebSocket(cfg.signalWs);
    ws.onopen = () =>
      sendWs({
        type: 'host:create',
        publicBaseUrl: $('publicBase').value.trim() || undefined,
        maxViewers: (cfg.settings && cfg.settings.maxViewers) || 1,
        accessMode: (cfg.settings && cfg.settings.accessMode) || 'approve',
        ttlMinutes: cfg.settings && Number.isFinite(cfg.settings.sessionTtlMinutes) ? cfg.settings.sessionTtlMinutes : 30,
      });
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => setStatus('サーバとの接続が切断されました');
    ws.onerror = () => setStatus('サーバに接続できません: ' + cfg.signalWs);
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
        $('url').value = msg.viewerUrl;
        if (!$('qrPanel').classList.contains('hidden')) showQr(); // URL確定時にQRを更新
        if (msg.pin) {
          $('pin').textContent = 'PIN: ' + msg.pin;
          $('pin').classList.remove('hidden');
        }
        setStatus('待機中。相手がURLを開くと、ここに表示されます。');
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
        closeAllPeers();
        sessionStarted = false; // 期限切れ＝次の画面選択で新規発行
        endShareUi();
        break;
    }
  }

  function reissue() {
    // 既存接続を畳んで新しいセッションURLを発行
    closeAllPeers();
    try { ws && ws.close(); } catch {}
    startSignaling();
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
        setStatus('信頼済み端末を自動承認しました' + (res.label ? '（' + res.label + '）' : ''));
        activeReq = null;
        processReqQueue();
        return;
      }
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
    el.textContent = '信頼済み端末: ' + list.length + ' 件';
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

  // ビューアごとに peer 接続を張る（同じキャプチャ stream を各接続へ送る＝メッシュ）
  async function startPeerFor(viewerId) {
    closePeerFor(viewerId); // 再接続時の取りこぼし防止
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const entry = { pc, dc: null, makingOffer: false, ignoreOffer: false, srpPending: false, polite: false }; // host=impolite
    peers.set(viewerId, entry);
    // 再ネゴ（Perfect Negotiation）。初回 offer もこれが発火する。track/datachannel 追加より前に設定。
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription(); // 暗黙 createOffer（stable時）
        sendWs({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });
      } catch (err) {
        console.warn('negotiationneeded', err);
      } finally {
        entry.makingOffer = false;
      }
    };
    if (stream) for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const dc = pc.createDataChannel('input');
    entry.dc = dc;
    dc.onopen = () => {
      if (!cursorStarted) { cursorStarted = true; window.host.cursorTrack(true); } // 一度だけ開始
      refreshModes(); // 操作権の決定＋mode 通知
    };
    dc.onmessage = (e) => {
      if (viewerId !== controllerId) return; // 操作権がないビューアの入力は無視（多重防壁）
      if (isReadonlyGlobal()) return; // 閲覧のみ時は誰の入力も無視
      try { window.host.sendInput(JSON.parse(e.data)); } catch {}
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendWs({ type: 'signal', to: viewerId, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') closePeerFor(viewerId); // 死んだ接続を解放
    };
    // 初回オファーは上記 onnegotiationneeded が自動発火する（手動 createOffer は不要）
  }

  // Perfect Negotiation（host=impolite）。offer/answer/glare/ICE を捌く。
  async function handleSignal(from, data) {
    const p = peers.get(from);
    if (!p || !p.pc) return;
    const pc = p.pc;
    try {
      if (data.sdp) {
        const desc = data.sdp;
        const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.srpPending);
        const collision = desc.type === 'offer' && !ready;
        p.ignoreOffer = !p.polite && collision; // impolite は衝突した offer を無視
        if (p.ignoreOffer) return;
        p.srpPending = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        p.srpPending = false;
        if (desc.type === 'offer') {
          // viewer 起点の offer（自分のカメラ追加など）には answer を返す
          await pc.setLocalDescription();
          sendWs({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!p.ignoreOffer) console.warn('addIceCandidate', err); }
      }
    } catch (err) {
      console.warn('handleSignal', err);
    }
  }

  function closePeerFor(viewerId) {
    const p = peers.get(viewerId);
    if (!p) return;
    // ハンドラを外してから閉じる（閉じた後のコールバックで古い参照を触らない）
    if (p.dc) {
      try { p.dc.onopen = null; p.dc.onmessage = null; p.dc.close(); } catch {}
    }
    if (p.pc) {
      try {
        p.pc.onicecandidate = null;
        p.pc.onconnectionstatechange = null;
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

  // 共有終了：終了ボタンを無効化＋文言変更し、終わったことをひと目で分かるようにする
  function endShareUi() {
    const e = $('end');
    e.disabled = true;
    e.textContent = '■ 共有を終了しました';
    $('copy').disabled = true; // 死んだURLをコピーさせない
    $('qrToggle').disabled = true;
  }
  // 共有開始：上記を「共有中」状態へ戻す
  function resetShareUi() {
    const e = $('end');
    e.disabled = false;
    e.textContent = '■ 共有を終了';
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
    const access = s.accessMode === 'token' ? 'だれでも' : s.accessMode === 'pin' ? 'PIN番号' : '承認制';
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
