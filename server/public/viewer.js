/* ブラウザ側ビューア。アカウント不要 — URL のトークンだけで接続する。
 * 役割: WebRTC の answer 側。映像を表示し、マウス/キーボード入力を DataChannel で送る。 */
(() => {
  'use strict';
  const token = location.pathname.split('/').filter(Boolean).pop();

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const stage = $('stage');
  const video = $('video');
  const toolbar = $('toolbar');
  const gate = $('gate');
  const pinBox = $('pinBox');
  const pinInput = $('pinInput');
  const pinBtn = $('pinBtn');
  const fsBtn = $('fsBtn');

  const setStatus = (t, show = true) => {
    statusEl.textContent = t;
    statusEl.classList.toggle('hidden', !show);
  };

  let ws, pc, dc;
  let controlEnabled = true; // ホストが「閲覧のみ」を通知したら false（操作入力を一切送らない）
  let makingOffer = false, srpPending = false; // Perfect Negotiation（viewer=polite）
  const rosterStreams = new Map(); // streamId -> {pid, kind:'screen'|'camera'}
  const pendingStreams = new Map(); // roster 到着前に来た stream を stash
  let localMedia = null, vCamOn = false, vMicOn = false; // 自分のカメラ/マイク
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}/ws`;

  // 信頼クレデンシャル（事前承認）。URL フラグメント #k=clientId.secret があれば取り込み、
  // 以後は localStorage から提示する。これがホスト側の信頼リストと一致すれば自動承認される。
  const CRED_KEY = 'passist_cred';
  function loadCred() {
    const m = location.hash.match(/k=([^.&]+)\.([^&]+)/);
    if (m) {
      const c = { clientId: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]) };
      try {
        localStorage.setItem(CRED_KEY, JSON.stringify(c));
      } catch {}
      history.replaceState(null, '', location.pathname); // フラグメントを URL から消す
      return c;
    }
    try {
      return JSON.parse(localStorage.getItem(CRED_KEY) || 'null');
    } catch {
      return null;
    }
  }
  let cred = loadCred();

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => join();
    ws.onmessage = (e) => onSignal(JSON.parse(e.data));
    ws.onclose = () => setStatus('接続が切断されました');
    ws.onerror = () => setStatus('サーバに接続できません');
  }
  function join(pin) {
    ws.send(JSON.stringify({ type: 'viewer:join', token, pin, auth: cred || undefined }));
  }

  function onSignal(msg) {
    switch (msg.type) {
      case 'waiting': setStatus(msg.message); break;
      case 'accepted':
        if (msg.issue) {
          try {
            localStorage.setItem(CRED_KEY, JSON.stringify(msg.issue));
            cred = msg.issue;
          } catch {}
        }
        setStatus('接続中… 映像を待っています');
        startPeer();
        break;
      case 'denied': setStatus(msg.message); teardown(); break;
      case 'ended': setStatus(msg.message); teardown(); break;
      case 'expired': setStatus('有効期限が切れました'); teardown(); break;
      case 'error':
        if (msg.code === 'pin') showPin('PINを入力してください');
        else setStatus(msg.message);
        break;
      case 'signal': handleSignal(msg.data); break;
    }
  }

  function showPin(note) {
    pinBox.classList.remove('hidden');
    setStatus(note, true);
  }
  pinBtn.onclick = () => {
    pinBox.classList.add('hidden');
    join(pinInput.value.trim());
  };

  function startPeer() {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    makingOffer = false; srpPending = false;
    // 自分のカメラ等を追加したら offer を出す（viewer=polite）。P0では発火しない（受け身）。
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
      } catch (e) {
        console.warn('negotiationneeded', e);
      } finally {
        makingOffer = false;
      }
    };
    pc.ontrack = (e) => {
      stage.classList.remove('hidden');
      toolbar.classList.remove('hidden');
      setStatus('', false);
      if (e.streams[0]) routeStream(e.streams[0]); // roster で 画面/カメラ に振り分け
    };
    pc.ondatachannel = (e) => {
      dc = e.channel; // ホストが作成した 'input' チャネル
      dc.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.t === 'clip' && typeof m.s === 'string') onHostClip(m.s); // ホストのクリップボードを同期
          else if (m && m.t === 'cursor' && typeof m.s === 'string') applyHostCursor(m.s); // カーソル形状を反映
          else if (m && m.t === 'mode') applyMode(m); // 操作可否（閲覧のみ）の通知
          else if (m && m.t === 'roster') applyRoster(m); // どの stream が画面/カメラか
        } catch {}
      };
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ type: 'signal', data: { candidate: e.candidate } }));
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setStatus('接続が不安定です (' + pc.connectionState + ')');
      }
    };
  }

  // Perfect Negotiation（viewer=polite）。ホストからの offer は衝突時も rollback して受ける。
  async function handleSignal(data) {
    if (!pc) return;
    try {
      if (data.sdp) {
        const desc = data.sdp;
        srpPending = desc.type === 'answer';
        await pc.setRemoteDescription(desc); // polite: 衝突 offer でも受ける（暗黙 rollback）
        srpPending = false;
        if (desc.type === 'offer') {
          await pc.setLocalDescription(); // 暗黙 createAnswer
          ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { console.warn('addIceCandidate', err); }
      }
    } catch (err) {
      console.warn('handleSignal', err);
    }
  }

  /* ---------- ビデオ通話（カメラ/マイク・タイル） ---------- */
  function routeStream(s) {
    const info = rosterStreams.get(s.id);
    if (info) return applyStream(s, info);
    pendingStreams.set(s.id, s); // roster 未着 → 後で振り分け
    if (!video.srcObject && s.getVideoTracks().length) { video.srcObject = s; resetZoom(); } // 暫定で画面表示（roster到着で訂正）
  }
  function applyStream(s, info) {
    if (info.kind === 'screen') { if (video.srcObject !== s) { video.srcObject = s; resetZoom(); } }
    else renderTile(info.pid, s, false); // camera
  }
  function applyRoster(m) {
    rosterStreams.clear();
    for (const r of m.streams || []) rosterStreams.set(r.streamId, { pid: r.pid, kind: r.kind });
    for (const [id, s] of [...pendingStreams]) { const info = rosterStreams.get(id); if (info) { applyStream(s, info); pendingStreams.delete(id); } }
  }
  function tilesEl() { return document.getElementById('tiles'); }
  function renderTile(pid, s, self) {
    const el = tilesEl(); if (!el) return;
    let t = el.querySelector('[data-pid="' + CSS.escape(pid) + '"]');
    if (!t) {
      t = document.createElement('div'); t.className = 'tile'; t.dataset.pid = pid;
      const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = !!self;
      if (self) v.style.transform = 'scaleX(-1)';
      const n = document.createElement('span'); n.className = 'tname'; n.textContent = self ? 'あなた' : 'ホスト';
      t.append(v, n);
      self ? el.prepend(t) : el.appendChild(t);
    }
    t.querySelector('video').srcObject = s;
  }
  function removeTile(pid) { const el = tilesEl(); if (!el) return; const t = el.querySelector('[data-pid="' + CSS.escape(pid) + '"]'); if (t) t.remove(); }

  async function vEnsureMedia() {
    if (localMedia) return localMedia;
    localMedia = await navigator.mediaDevices.getUserMedia({
      video: { width: { max: 640 }, height: { max: 360 }, frameRate: { max: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    localMedia.getVideoTracks().forEach((t) => (t.enabled = vCamOn));
    localMedia.getAudioTracks().forEach((t) => (t.enabled = vMicOn));
    if (pc) for (const tr of localMedia.getTracks()) pc.addTrack(tr, localMedia); // ホストへ送る（再ネゴ→host側 ontrack）
    return localMedia;
  }
  async function vSetCam(on) {
    try { if (on) await vEnsureMedia(); vCamOn = on; if (localMedia) localMedia.getVideoTracks().forEach((t) => (t.enabled = on)); updateViewerMediaUi(); }
    catch (e) { setStatus('カメラを開始できません: ' + e.message); }
  }
  async function vSetMic(on) {
    try { if (on) await vEnsureMedia(); vMicOn = on; if (localMedia) localMedia.getAudioTracks().forEach((t) => (t.enabled = on)); updateViewerMediaUi(); }
    catch (e) { setStatus('マイクを開始できません: ' + e.message); }
  }
  function updateViewerMediaUi() {
    const c = document.getElementById('vCamBtn'), m = document.getElementById('vMicBtn');
    if (c) { c.classList.toggle('on', vCamOn); c.textContent = vCamOn ? '📹' : '📷'; }
    if (m) { m.classList.toggle('on', vMicOn); m.textContent = vMicOn ? '🎤' : '🔇'; }
    if (vCamOn && localMedia) renderTile('self', localMedia, true); else removeTile('self');
  }
  function attachCallButtons() {
    const c = document.getElementById('vCamBtn'), m = document.getElementById('vMicBtn');
    if (c) c.onclick = () => vSetCam(!vCamOn);
    if (m) m.onclick = () => vSetMic(!vMicOn);
  }

  /* ---------- 入力キャプチャ ---------- */
  const MAX_BUFFER = 256 * 1024; // DataChannel バッファ上限。超えたら mousemove は捨てる（バックプレッシャ対策）
  const send = (o) => {
    if (!controlEnabled) return; // 閲覧のみ：操作系メッセージは送らない
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(o));
  };

  // マウス移動は高頻度。requestAnimationFrame で最新座標のみ間引き送信（約60Hz）。
  let pendingMove = null;
  let moveScheduled = false;
  function flushMove() {
    moveScheduled = false;
    const p = pendingMove;
    pendingMove = null;
    if (p && dc && dc.readyState === 'open' && dc.bufferedAmount < MAX_BUFFER) {
      send({ t: 'm', x: p.x, y: p.y });
    }
  }

  // video 表示領域(レターボックス補正込み)での正規化座標 0..1。範囲外は null。
  function norm(cx, cy) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    const offX = (r.width - dispW) / 2;
    const offY = (r.height - dispH) / 2;
    const x = (cx - r.left - offX) / dispW;
    const y = (cy - r.top - offY) / dispH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  // 最新座標のみ間引いて移動送信（マウス/タッチ共通）
  function queueMove(p) {
    pendingMove = p;
    if (!moveScheduled) {
      moveScheduled = true;
      requestAnimationFrame(flushMove);
    }
  }

  // 表示ズーム（スマホのピンチ用）。CSS transform で video を拡大/移動。
  // norm() は getBoundingClientRect（=変換後の矩形）を読むので、拡大中でも操作座標は自動で整合する。
  let zScale = 1, zTx = 0, zTy = 0;
  function applyZoom() {
    video.style.transformOrigin = '0 0';
    video.style.transform = zScale === 1 && !zTx && !zTy ? '' : `translate(${zTx}px, ${zTy}px) scale(${zScale})`;
  }
  function resetZoom() { zScale = 1; zTx = 0; zTy = 0; applyZoom(); }

  // タッチ操作モード（1本指ドラッグの挙動）: scroll=共有窓の中身をスクロール / mouse=ポインタ操作 / pan=拡大画面の移動
  let touchMode = 'scroll';
  function attachModeBtn() {
    const modeBtn = document.getElementById('modeBtn');
    if (!modeBtn) return;
    const MODES = ['scroll', 'mouse', 'pan'];
    const svg = (inner) =>
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    const ICON = {
      scroll: svg('<polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>'),
      mouse: svg('<path d="M4 3l6.5 16 2.3-6.8 6.8-2.3L4 3z"/><path d="M13.5 13.5L19 19"/>'),
      pan: svg('<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>'),
    };
    const TEXT = { scroll: 'スクロール', mouse: 'マウス', pan: '画面移動' };
    const set = (m) => { touchMode = m; modeBtn.innerHTML = ICON[m] + '<span>' + TEXT[m] + '</span>'; };
    set('scroll');
    modeBtn.onclick = () => set(MODES[(MODES.indexOf(touchMode) + 1) % MODES.length]); // タップで順に切替
  }

  function attachInput() {
    video.addEventListener('mousemove', (e) => {
      const p = norm(e.clientX, e.clientY);
      if (p) queueMove(p);
    });
    video.addEventListener('mousedown', (e) => {
      if (e.button === 2) return; // 右クリックはコピペのメニュー用（ホストへは送らない）
      const p = norm(e.clientX, e.clientY);
      if (p) {
        send({ t: 'm', x: p.x, y: p.y });
        send({ t: 'd', b: e.button });
      }
      e.preventDefault();
    });
    video.addEventListener('mouseup', (e) => {
      if (e.button === 2) return;
      send({ t: 'u', b: e.button });
      e.preventDefault();
    });
    // 右クリックメニューは document 全体で処理（attachClipboardMenu 参照）。
    video.addEventListener(
      'wheel',
      (e) => {
        send({ t: 'w', dx: e.deltaX, dy: e.deltaY });
        e.preventDefault();
      },
      { passive: false },
    );

    const onKey = (down) => (e) => {
      // 操作対象に集中しているときだけ送る
      if (!hasFocus) return;
      send({ t: 'k', down, code: e.code, key: e.key, mods: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey } });
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    attachTouch(); // スマホ: タップ=クリック / 1本指ドラッグ=移動 / 長押し=メニュー
  }

  // スマホ向けタッチ操作（タッチネイティブ方式）:
  //  1本指: タップ=クリック / ドラッグ=スクロール(縦横) / 長押し=コピー等メニュー
  //         （連続タップ=2クリック→ホスト側でOSがダブルクリック判定）
  //  2本指: ピンチで拡大/縮小＋パン（閲覧のみでも可）
  function attachTouch() {
    const LONG_MS = 500, MOVE_THRESH = 10, STEP = 4; // STEP を小さくするほどスクロールが速い
    let lpTimer = null, sx = 0, sy = 0, lastX = 0, lastY = 0, moved = false, longFired = false;
    let accX = 0, accY = 0, pinch = null;
    const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const startPinch = (e) => {
      clearLP(); moved = true; longFired = false;
      const r = video.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pinch = { d: dist(e.touches[0], e.touches[1]), mx, my, baseX: r.left - zTx, baseY: r.top - zTy };
    };
    // 蓄積分を STEP ごとにホイール送信（縦/横）。指と逆向き=自然なスクロール方向。
    const flushScroll = () => {
      while (Math.abs(accY) >= STEP) { const up = accY > 0; send({ t: 'w', dx: 0, dy: up ? -360 : 360 }); accY += up ? -STEP : STEP; }
      while (Math.abs(accX) >= STEP) { const right = accX > 0; send({ t: 'w', dx: right ? -360 : 360, dy: 0 }); accX += right ? -STEP : STEP; }
    };

    video.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) { startPinch(e); e.preventDefault(); return; } // ピンチ（閲覧のみでも拡大可）
      if (ctxMenu && !ctxMenu.classList.contains('hidden')) { hideCtxMenu(); e.preventDefault(); return; }
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; lastX = t.clientX; lastY = t.clientY;
      moved = false; longFired = false; accX = 0; accY = 0;
      if (controlEnabled) { const p = norm(sx, sy); if (p) send({ t: 'm', x: p.x, y: p.y }); } // 触れた場所へカーソル＝スクロール/操作の対象を共有窓に確定（ホスト側で前面化）
      clearLP();
      if (controlEnabled) lpTimer = setTimeout(() => { longFired = true; showCtxMenu(sx, sy); }, LONG_MS); // 長押し=メニュー
      e.preventDefault();
    }, { passive: false });

    video.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 2) { // ピンチ拡大＋パン
        if (!pinch) startPinch(e);
        const a = e.touches[0], b = e.touches[1];
        const d = dist(a, b);
        const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
        const ns = Math.min(5, Math.max(1, zScale * (d / pinch.d)));
        const f = ns / zScale;
        zTx = zTx - (mx - pinch.baseX - zTx) * (f - 1) + (mx - pinch.mx);
        zTy = zTy - (my - pinch.baseY - zTy) * (f - 1) + (my - pinch.my);
        zScale = ns;
        if (zScale <= 1.005) { zScale = 1; zTx = 0; zTy = 0; }
        applyZoom();
        pinch.d = d; pinch.mx = mx; pinch.my = my;
        e.preventDefault();
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      if (!moved && (Math.abs(t.clientX - sx) > MOVE_THRESH || Math.abs(t.clientY - sy) > MOVE_THRESH)) {
        moved = true; clearLP(); // ドラッグ開始→長押し取消（スクロールへ）
      }
      if (moved) { // 1本指ドラッグ: モードで挙動が変わる
        const dx = t.clientX - lastX, dy = t.clientY - lastY;
        if (touchMode === 'pan') { zTx += dx; zTy += dy; applyZoom(); } // ①拡大画面の移動（閲覧のみでも可）
        else if (controlEnabled) {
          if (touchMode === 'mouse') { const p = norm(t.clientX, t.clientY); if (p) queueMove(p); } // ③ポインタを指の位置へ
          else { accX += dx; accY += dy; flushScroll(); } // ②共有窓の中身スクロール（縦横）
        }
      }
      lastX = t.clientX; lastY = t.clientY;
      e.preventDefault();
    }, { passive: false });

    const end = (e) => {
      if (pinch) { if (e.touches.length < 2) pinch = null; clearLP(); e.preventDefault(); return; }
      clearLP();
      if (longFired) { longFired = false; e.preventDefault(); return; } // メニュー表示済み
      if (!moved && controlEnabled) { // タップ=その位置を左クリック（連続タップはOSがダブルクリック判定）
        const p = norm(sx, sy);
        if (p) { send({ t: 'm', x: p.x, y: p.y }); send({ t: 'd', b: 0 }); send({ t: 'u', b: 0 }); }
      }
      e.preventDefault();
    };
    video.addEventListener('touchend', end, { passive: false });
    video.addEventListener('touchcancel', () => { clearLP(); longFired = false; moved = false; pinch = null; });
  }

  // テキスト入力ダイアログ：右クリック→「テキスト入力…」で開く。日本語はローカルIMEで確定し
  // （候補窓は相手のブラウザに表示）、Enter または「挿入」で確定テキストを送信（ホストは Unicode 直接入力）。
  const textDialog = document.getElementById('textDialog');
  const textInput = document.getElementById('textInput');
  function openTextDialog() {
    if (!textDialog) return;
    const host = document.fullscreenElement || document.body; // 全画面でも前面に出す
    if (textDialog.parentNode !== host) host.appendChild(textDialog);
    textDialog.classList.remove('hidden');
    textInput.value = '';
    textInput.focus();
  }
  function closeTextDialog() {
    if (textDialog) textDialog.classList.add('hidden');
  }
  function submitText() {
    const t = textInput.value;
    if (t) send({ t: 'text', s: t });
    textInput.value = '';
    textInput.focus(); // 続けて入力できるよう開いたままにする
  }
  function attachTextDialog() {
    if (!textDialog) return;
    let composing = false;
    textInput.addEventListener('compositionstart', () => { composing = true; });
    textInput.addEventListener('compositionend', () => { composing = false; });
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !composing) {
        e.preventDefault(); // IME変換確定の Enter では送信しない
        submitText();
      } else if (e.key === 'Escape') {
        closeTextDialog();
      }
    });
    document.getElementById('textInsert').onclick = submitText;
    document.getElementById('textCancel').onclick = closeTextDialog;
  }

  // クリップボード同期：ホストのコピー内容を受け取り、可能なら自分のクリップボードにも反映
  let remoteClip = '';
  function onHostClip(s) {
    remoteClip = s;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).catch(() => {});
  }

  // 右クリックメニュー（コピー/切り取り/貼り付け）
  const ctxMenu = document.getElementById('ctxMenu');
  function showCtxMenu(x, y) {
    if (!ctxMenu) return;
    // 全画面中はフルスクリーン要素の中に入れないと前面に出ない（top layer 対策）
    const host = document.fullscreenElement || document.body;
    if (ctxMenu.parentNode !== host) host.appendChild(ctxMenu);
    ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - 170)) + 'px';
    ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - 230)) + 'px';
    ctxMenu.classList.remove('hidden');
  }
  function hideCtxMenu() {
    if (ctxMenu) ctxMenu.classList.add('hidden');
  }
  function attachClipboardMenu() {
    if (!ctxMenu) return;
    ctxMenu.addEventListener('click', async (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      hideCtxMenu();
      if (act === 'copy') send({ t: 'edit', a: 'copy' }); // ホストで Ctrl+C → 結果はクリップボード同期で戻る
      else if (act === 'cut') send({ t: 'edit', a: 'cut' });
      else if (act === 'paste') {
        let text = null;
        try {
          if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
        } catch {}
        if (text) send({ t: 'text', s: text }); // 自分のクリップボードを相手に入力
        else send({ t: 'edit', a: 'paste' }); // 取得不可ならホスト側 Ctrl+V
      } else if (act === 'text') {
        openTextDialog();
      }
    });
    // 右クリックでメニュー表示（gate やレターボックス上でも効くよう document 全体に）。
    document.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.id === 'textInput') return; // テキスト入力欄はブラウザ標準メニューに任せる
      e.preventDefault();
      if (!controlEnabled) return; // 閲覧のみ：操作メニュー（コピー/貼り付け/テキスト入力）は出さない
      showCtxMenu(e.clientX, e.clientY);
    });
    document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
    window.addEventListener('blur', hideCtxMenu);
  }

  /* ---------- 画面上キーバー（スマホ用の特殊キー/修飾キー） ---------- */
  const keybar = document.getElementById('keybar');
  const kbBtn = document.getElementById('kbBtn');
  const sticky = { ctrl: false, alt: false, shift: false };
  const MOD = {
    ctrl: { code: 'ControlLeft', key: 'Control' },
    alt: { code: 'AltLeft', key: 'Alt' },
    shift: { code: 'ShiftLeft', key: 'Shift' },
  };
  function clearSticky() {
    sticky.ctrl = sticky.alt = sticky.shift = false;
    if (keybar) keybar.querySelectorAll('button.active').forEach((b) => b.classList.remove('active'));
  }
  // 修飾キー（あれば）で挟んで1キーを押下→離す。修飾はワンショット。
  function sendKey(code, key) {
    if (!controlEnabled) return;
    const mods = { ctrl: sticky.ctrl, alt: sticky.alt, shift: sticky.shift, meta: false };
    const held = ['ctrl', 'alt', 'shift'].filter((m) => sticky[m]);
    for (const m of held) send({ t: 'k', down: true, code: MOD[m].code, key: MOD[m].key, mods });
    send({ t: 'k', down: true, code, key, mods });
    send({ t: 'k', down: false, code, key, mods });
    for (const m of held.reverse()) send({ t: 'k', down: false, code: MOD[m].code, key: MOD[m].key, mods });
    clearSticky();
  }
  function attachKeybar() {
    if (!keybar || !kbBtn) return;
    kbBtn.onclick = () => {
      const host = document.fullscreenElement || document.body; // 全画面でも前面に出す
      if (keybar.parentNode !== host) host.appendChild(keybar);
      keybar.classList.toggle('hidden');
    };
    keybar.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (!b) return;
      if (b.dataset.mod) { sticky[b.dataset.mod] = !sticky[b.dataset.mod]; b.classList.toggle('active', sticky[b.dataset.mod]); return; }
      if (b.dataset.act === 'text') { openTextDialog(); return; }
      if (b.dataset.act === 'close') { keybar.classList.add('hidden'); return; }
      if (b.dataset.code) sendKey(b.dataset.code, b.dataset.key || b.dataset.code);
    });
    document.addEventListener('fullscreenchange', () => {
      const host = document.fullscreenElement || document.body;
      if (keybar.parentNode !== host) host.appendChild(keybar);
    });
  }

  // クライアント側ローカルカーソル（VNC風）：マウス位置に自前カーソルを即時描画して操作感を滑らかに。
  const localCursor = document.getElementById('localCursor');
  let cursorActive = false;
  function setLocalCursor(on) {
    cursorActive = on;
    stage.classList.toggle('local-cursor', on); // ON時はブラウザ標準カーソルを隠す
    if (on) {
      stage.style.cursor = ''; // ホスト形状の残りインラインを解除（オーバーレイ用）
      video.style.cursor = '';
    } else if (localCursor) {
      localCursor.style.display = 'none';
    }
  }
  // ホストのカーソル形状を反映：受信したら標準カーソルでその形を表示（SVGオーバーレイより正確）
  const CURSOR_CSS = {
    arrow: 'default', ibeam: 'text', hand: 'pointer', wait: 'wait', cross: 'crosshair',
    sizewe: 'ew-resize', sizens: 'ns-resize', sizenwse: 'nwse-resize', sizenesw: 'nesw-resize',
    sizeall: 'move', no: 'not-allowed', appstarting: 'progress', help: 'help', hidden: 'none',
  };
  function applyHostCursor(shape) {
    setLocalCursor(false); // SVGオーバーレイをやめてネイティブカーソルを使う
    const css = CURSOR_CSS[shape] || 'default';
    stage.style.cursor = css;
    video.style.cursor = css;
  }
  function moveLocalCursor(x, y) {
    if (!localCursor || !cursorActive) return;
    // transform で GPU 合成（再描画なしで滑らか）。tip(svg約1,1)を実カーソル位置に合わせる。
    localCursor.style.transform = 'translate3d(' + (x - 1) + 'px,' + (y - 1) + 'px,0)';
    localCursor.style.display = 'block';
  }
  function attachLocalCursor() {
    if (!localCursor) return;
    stage.addEventListener('pointermove', (e) => moveLocalCursor(e.clientX, e.clientY));
    stage.addEventListener('pointerenter', (e) => moveLocalCursor(e.clientX, e.clientY));
    stage.addEventListener('pointerleave', () => { localCursor.style.display = 'none'; });
    stage.addEventListener('pointerdown', () => {
      localCursor.classList.add('click');
      setTimeout(() => localCursor.classList.remove('click'), 140);
    });
    // 全画面中は全画面要素の中に入れないと前面に出ない
    document.addEventListener('fullscreenchange', () => {
      const host = document.fullscreenElement || document.body;
      if (localCursor.parentNode !== host) host.appendChild(localCursor);
    });
  }

  let hasFocus = false;
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  gate.onclick = () => {
    gate.classList.add('hidden');
    hasFocus = true;
    video.focus();
    if (!isTouch) setLocalCursor(true); // PCのみVNC風ローカルカーソル（スマホは指がポインタなので不要）
  };
  video.tabIndex = 0;
  video.addEventListener('focus', () => (hasFocus = true));
  video.addEventListener('blur', () => (hasFocus = false));

  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen();
  };

  function teardown() {
    try { pc && pc.close(); } catch {}
    try { ws && ws.close(); } catch {}
    stage.classList.add('hidden');
    toolbar.classList.add('hidden');
    setLocalCursor(false);
    resetZoom();
    if (localMedia) { localMedia.getTracks().forEach((t) => t.stop()); localMedia = null; }
    vCamOn = false; vMicOn = false;
    const te = tilesEl(); if (te) te.innerHTML = '';
    rosterStreams.clear(); pendingStreams.clear();
  }

  // ホストからの操作可否通知。閲覧のみ時は入力送信を止め、バッジ表示と見た目を切り替える。
  function applyMode(m) {
    controlEnabled = !(m && m.readonly);
    const badge = document.getElementById('badge');
    if (controlEnabled) {
      if (badge) { badge.textContent = '● 操作中'; badge.classList.remove('readonly'); }
      document.body.classList.remove('view-only');
    } else {
      if (badge) { badge.textContent = '● 閲覧のみ'; badge.classList.add('readonly'); }
      document.body.classList.add('view-only');
      gate.classList.add('hidden'); // 「クリックして操作を開始」ゲートは不要
      hasFocus = false;
      setLocalCursor(false); // 操作用ローカルカーソルを消す
      hideCtxMenu();
      if (keybar) keybar.classList.add('hidden'); // 閲覧のみ：キーバーも隠す
      clearSticky();
    }
  }

  attachInput();
  attachTextDialog();
  attachClipboardMenu();
  attachKeybar();
  attachModeBtn();
  attachCallButtons();
  attachLocalCursor();
  connect();
})();
