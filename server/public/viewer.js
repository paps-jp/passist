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
  // accepted で signaling から受け取る TURN サーバ（NAT越え失敗時の中継用）。
  // 形式: { urls, username, credential }。なければ null＝STUN のみで P2P を試みる。
  let turnFromServer = null;
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

  // WebSocket 自動再接続（指数バックオフ）。
  // ホストが意図的にセッションを終了したケース(ended/denied/expired)は再接続しない。
  // 信頼クレデンシャル(cred)があれば再接続後の join で自動承認される＝映像はすぐ復旧する。
  let shouldReconnect = true;       // ended/denied/expired/teardown で false に
  let reconnectAttempt = 0;          // バックオフ用カウンタ
  let reconnectTimer = null;         // 再接続のタイマー（多重起動防止）
  const MAX_RECONNECT = 8;           // 最大試行回数（〜約2分）
  function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) return;
    if (reconnectAttempt >= MAX_RECONNECT) {
      setStatus('接続が切断されました。ページを再読み込みして接続し直してください。');
      return;
    }
    const delay = Math.min(30000, 500 * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    setStatus(`接続が切れました。再接続を試みています…（${reconnectAttempt}/${MAX_RECONNECT}）`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    try { if (ws) { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; ws.close(); } } catch {}
    try { if (pc) { pc.close(); pc = null; } } catch {} // 古いピアを必ず閉じてから張り直す
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { reconnectAttempt = 0; join(); };
    ws.onmessage = (e) => onSignal(JSON.parse(e.data));
    ws.onclose = () => scheduleReconnect(); // 切断＝自動再接続
    ws.onerror = () => { /* onclose も呼ばれるので集約 */ };
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
        // signaling から TURN credentials が配布されていれば iceServers に追加（NAT越え強化）
        if (msg.turn && msg.turn.urls && msg.turn.username && msg.turn.credential) turnFromServer = msg.turn;
        setStatus('接続中… 映像を待っています');
        startPeer();
        break;
      case 'denied': shouldReconnect = false; setStatus(msg.message); teardown(); break;
      case 'ended': shouldReconnect = false; setStatus(msg.message); teardown(); break;
      case 'expired': shouldReconnect = false; setStatus('有効期限が切れました'); teardown(); break;
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

  // iceServers を動的に構築。STUNは常時、TURNは accepted で配布があれば追加。
  function buildIceServers() {
    const list = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (turnFromServer) list.push(turnFromServer);
    return list;
  }

  function startPeer() {
    pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      stage.classList.remove('hidden');
      toolbar.classList.remove('hidden');
      setStatus('', false);
      resetZoom(); // 新しい映像はズーム等倍から
    };
    pc.ondatachannel = (e) => {
      dc = e.channel; // ホストが作成した 'input' チャネル
      dc.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.t === 'clip' && typeof m.s === 'string') onHostClip(m.s); // ホストのクリップボードを同期
          else if (m && m.t === 'cursor' && typeof m.s === 'string') applyHostCursor(m.s); // カーソル形状を反映
          else if (m && m.t === 'mode') applyMode(m); // 操作可否（閲覧のみ）の通知
          else if (m && m.t === 'fieldtext') onFieldText(typeof m.s === 'string' ? m.s : '', m.aborted || null); // テキスト編集モード: 現在値受信
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

  async function handleSignal(data) {
    if (!pc) return;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn('addIceCandidate', err);
      }
    }
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
      // クリック完了後、カーソルが「ibeam(テキスト入力)」ならテキスト編集ダイアログを開く
      if (e.button === 0 && hostCursorShape === 'ibeam') setTimeout(openTextEditMode, 120);
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
        if (p) {
          send({ t: 'm', x: p.x, y: p.y }); send({ t: 'd', b: 0 }); send({ t: 'u', b: 0 });
          // タップ完了後、カーソルが「ibeam(テキスト入力)」ならテキスト編集ダイアログを開く
          if (hostCursorShape === 'ibeam') setTimeout(openTextEditMode, 120);
        }
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
    textOverwriteMode = false; // どのルートで閉じてもモードをリセット
    if (fieldReadTimer) { clearTimeout(fieldReadTimer); fieldReadTimer = null; }
  }
  function submitText() {
    const t = textInput.value;
    if (textOverwriteMode) {
      // テキスト編集モード: 全選択→Unicode 入力で「上書き」（空でも全削除として送る）
      send({ t: 'replace', s: t });
    } else if (t) {
      send({ t: 'text', s: t });
    }
    textOverwriteMode = false;
    textInput.value = '';
    closeTextDialog();
  }

  // ホストのカーソルが「ibeam」のときにタップ/クリック → 現在の値を取得して編集ダイアログを開く
  let hostCursorShape = 'arrow';
  let textOverwriteMode = false;  // true なら「挿入」は replace で送る
  let fieldReadTimer = null;       // 値取得タイムアウト
  function setHostCursorShape(s) { hostCursorShape = s || 'arrow'; }
  function openTextEditMode() {
    if (!controlEnabled) return;
    if (textDialog && !textDialog.classList.contains('hidden')) return; // 既に開いていれば二重起動しない
    textOverwriteMode = true;
    openTextDialog();
    textInput.value = '';
    textInput.placeholder = '現在の値を取得しています…';
    send({ t: 'readtext' }); // ホストへ値要求
    if (fieldReadTimer) clearTimeout(fieldReadTimer);
    fieldReadTimer = setTimeout(() => {
      textInput.placeholder = '取得に失敗しました。新規入力 → 挿入で上書きされます。';
      fieldReadTimer = null;
    }, 1800);
  }
  function onFieldText(s, aborted) {
    if (!textOverwriteMode) return; // 編集モードでないなら無視（誤配信対策）
    if (fieldReadTimer) { clearTimeout(fieldReadTimer); fieldReadTimer = null; }
    if (aborted === 'clipboard-has-files') {
      // ホスト側のクリップボードにファイル等が入っていて、復元すると壊れるため取得をスキップ。
      textInput.value = '';
      textInput.placeholder = 'ホストのクリップボードにファイル等があるため現在値を取得しませんでした。新規入力で上書きされます。';
    } else if (aborted) {
      textInput.value = '';
      textInput.placeholder = '現在値の取得をスキップしました（' + aborted + '）。新規入力で上書きされます。';
    } else {
      textInput.value = s;
      textInput.placeholder = '';
    }
    try { textInput.focus(); textInput.select(); } catch {} // 全選択でそのまま打ち替え可能
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
    setHostCursorShape(shape); // テキスト編集モード(ibeam検知)で利用
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
    shouldReconnect = false; // 明示的撤収＝自動再接続を止める
    clearReconnect();
    try { pc && pc.close(); pc = null; } catch {}
    try { ws && ws.close(); } catch {}
    stage.classList.add('hidden');
    toolbar.classList.add('hidden');
    setLocalCursor(false);
    resetZoom();
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

  /* ---------- バージョン情報モーダル + サーバ検証(B) + 暗号化情報(D) ---------- */
  // B: サーバ /api/build から「動かしている image の commit / digest」を取得して表示する。
  //   - digest は Cosign 署名対象。利用者は cosign で「公開ソースからビルドされた」を完全検証可能。
  //   - ブラウザだけで完全検証する API（Rekor index）は image digest 直接検索に対応していないため、
  //     ここでは「サーバ申告を可視化＋外部検証リンク」を提供する（search.sigstore.dev / cosign コマンド）。
  // D: getStats() で DTLS state / 暗号アルゴリズム / 経路(P2P or TURN中継)を可視化。
  async function verifyServerCode() {
    try {
      const build = await fetch('/api/build', { cache: 'no-store' }).then((r) => r.json());
      if (!build) return { state: 'error', error: 'no response' };
      if (!build.imageDigest || !build.bundleUrl) return { state: 'no-attest', build };
      // ブラウザ自前 verify: sigverify.js が SHA-256 Merkle proof + payload を独立に検証
      if (!window.__passistSigVerify) return { state: 'lib-missing', build, error: 'sigverify.js not loaded' };
      const [bRes, sRes] = await Promise.all([
        fetch(build.bundleUrl),
        build.signatureUrl ? fetch(build.signatureUrl) : Promise.resolve(null),
      ]);
      if (!bRes.ok) return { state: 'bundle-fail', build, error: 'HTTP ' + bRes.status };
      const bundle = await bRes.json();
      const signatureArtifact = sRes && sRes.ok ? await sRes.json() : null;
      const v = await window.__passistSigVerify.verifyBundle(
        bundle, build.imageDigest, build.certificateIdentityRegexp, build.certificateOidcIssuer, signatureArtifact
      );
      return { state: v.ok ? 'verified' : 'verify-fail', build, verify: v };
    } catch (e) {
      return { state: 'error', error: e.message };
    }
  }

  async function getCryptoInfo() {
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      const out = { dtlsState: '-', dtlsCipher: '-', srtpCipher: '-', iceState: pc.iceConnectionState || '-', route: '-', bytesSent: 0, bytesReceived: 0, localCandidate: '-', remoteCandidate: '-' };
      let selectedPairId = null;
      for (const s of stats.values()) {
        if (s.type === 'transport') {
          out.dtlsState = s.dtlsState || out.dtlsState;
          out.dtlsCipher = s.dtlsCipher || s.tlsVersion || out.dtlsCipher;
          out.srtpCipher = s.srtpCipher || out.srtpCipher;
          out.bytesSent = s.bytesSent || 0;
          out.bytesReceived = s.bytesReceived || 0;
          selectedPairId = s.selectedCandidatePairId || selectedPairId;
        }
      }
      for (const s of stats.values()) {
        if (s.type === 'candidate-pair' && ((selectedPairId && s.id === selectedPairId) || s.nominated)) {
          const local = stats.get(s.localCandidateId);
          const remote = stats.get(s.remoteCandidateId);
          out.localCandidate = local ? local.candidateType : out.localCandidate;
          out.remoteCandidate = remote ? remote.candidateType : out.remoteCandidate;
          const isRelay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
          out.route = isRelay ? 'TURN 中継経由' : 'P2P 直接接続';
          break;
        }
      }
      return out;
    } catch { return null; }
  }

  const aboutModal = document.getElementById('aboutModal');
  const aboutBtn = document.getElementById('aboutBtn');
  function openAbout() {
    if (!aboutModal) return;
    const host = document.fullscreenElement || document.body;
    if (aboutModal.parentNode !== host) host.appendChild(aboutModal);
    aboutModal.classList.remove('hidden');
    populateAbout();
  }
  function closeAbout() { if (aboutModal) aboutModal.classList.add('hidden'); }
  async function populateAbout() {
    const sv = document.getElementById('srvVerify');
    const ci = document.getElementById('cryptoInfo');
    if (sv) sv.innerHTML = 'Sigstore Rekor に問い合わせ中…';
    if (ci) ci.innerHTML = '接続状態を取得中…';
    // B: サーバ検証
    const v = await verifyServerCode();
    if (sv) sv.innerHTML = renderVerify(v);
    // D: 暗号化情報
    const c = await getCryptoInfo();
    if (ci) ci.innerHTML = renderCrypto(c);
  }
  function renderVerify(v) {
    const b = v.build || {};
    const commit = b.commit || '(未公開)';
    const digest = b.imageDigest || '(未公開)';
    const registry = b.registry || 'ghcr.io/paps-jp/passist-signaling';
    const src = b.sourceUrl || 'https://github.com/paps-jp/passist';
    const builtAt = b.builtAt || '';
    const tag = b.tag || '';
    const head = (label, klass) => `<div><span class="${klass}">${label}</span></div>`;
    const kv = `<div class="kv">
        ${tag ? '<b>tag</b><code>' + tag + '</code>' : ''}
        <b>commit</b><code>${commit}</code>
        <b>digest</b><code>${digest}</code>
        ${builtAt ? '<b>built at</b><span>' + builtAt + '</span>' : ''}
        <b>registry</b><code>${registry}</code>
      </div>`;
    const digestNoPrefix = (digest || '').replace(/^sha256:/, '');
    if (v.state === 'verified') {
      const vr = v.verify || {};
      const ts = vr.integratedTime ? new Date(vr.integratedTime * 1000).toISOString() : '';
      return head('✓ ブラウザで完全検証成功', 'ok')
        + '<div style="margin-top:4px">SHA-256 Merkle inclusion proof + 申告digest一致 + identity一致を <strong>このブラウザ単独で</strong> 確認しました。</div>'
        + kv
        + `<div class="kv" style="margin-top:6px">
            <b>署名者</b><code>${vr.subject || ''}</code>
            <b>発行者</b><code>${vr.issuer || ''}</code>
            ${ts ? '<b>署名時刻</b><span>' + ts + '</span>' : ''}
            <b>log index</b><code>${vr.logIndex || ''}</code>
            <b>root hash</b><code>${vr.rootHash || ''}</code>
          </div>`
        + `<div style="margin-top:8px"><a href="https://search.sigstore.dev/?hash=sha256:${vr.checks?.payloadHashMatch?.got || ''}" target="_blank" rel="noopener">🔍 Sigstore で署名を検索 →</a> ・ <a href="${src}/releases/tag/${tag}" target="_blank" rel="noopener">GitHub Release</a> ・ <a href="${src}/actions" target="_blank" rel="noopener">ビルドログ</a></div>`;
    }
    if (v.state === 'verify-fail') {
      const vr = v.verify || {};
      const chk = vr.checks || {};
      return head('✗ ブラウザ検証失敗', 'ng')
        + `<div style="margin-top:4px">${vr.error || ''}</div>`
        + `<div class="kv" style="margin-top:6px">
            <b>Merkle proof</b><span>${chk.merkleProof?.ok ? '✓' : '✗ ' + (chk.merkleProof?.error || '')}</span>
            <b>digest 一致</b><span>${chk.digestMatch?.ok ? '✓' : '✗ got=' + (chk.digestMatch?.got || '')}</span>
            <b>identity 一致</b><span>${chk.identityMatch?.ok ? '✓' : '✗ uri=' + (chk.identityMatch?.uri || '')}</span>
          </div>`
        + kv;
    }
    if (v.state === 'bundle-fail' || v.state === 'lib-missing') {
      return head('⚠ 検証準備に失敗: ' + v.state, 'warn')
        + `<div>${v.error || ''}</div>`
        + kv;
    }
    if (v.state === 'no-attest') {
      return head('ℹ このサーバはまだ署名版をリリースしていません', 'warn')
        + `<div class="kv"><b>commit</b><code>${commit}</code></div>`
        + '<div style="margin-top:8px">開発中・テスト中のサーバの可能性があります。本番運用には署名版（v0.2.x以降のリリース）の使用を推奨します。</div>'
        + `<div style="margin-top:6px"><a href="${src}" target="_blank" rel="noopener">GitHub で公開コードを見る →</a></div>`;
    }
    return head('⚠ サーバ情報の取得に失敗しました', 'ng') + `<div>${v.error || '不明なエラー'}</div>`;
  }
  function renderCrypto(c) {
    if (!c) return '接続が確立していません。映像表示後にもう一度開いてください。';
    const fmtKB = (n) => (n / 1024).toFixed(1) + ' KiB';
    return `<div class="kv">
        <b>状態</b><span>DTLS: ${c.dtlsState} / ICE: ${c.iceState}</span>
        <b>暗号</b><span>${c.dtlsCipher !== '-' ? c.dtlsCipher : 'DTLS-SRTP / AES-128-GCM'}${c.srtpCipher !== '-' ? ' + SRTP ' + c.srtpCipher : ''}</span>
        <b>経路</b><span>${c.route}（local=${c.localCandidate} / remote=${c.remoteCandidate}）</span>
        <b>転送量</b><span>送信 ${fmtKB(c.bytesSent)} / 受信 ${fmtKB(c.bytesReceived)}</span>
      </div>
      <div style="margin-top:8px;color:#9fb0c6;font-size:11.5px">鍵交換は ECDHE（前方秘匿性）で行われ、鍵はあなたのブラウザとホストPCにしか存在しません。サーバが盗聴しても解読はできません。</div>`;
  }
  function attachAbout() {
    if (aboutBtn) aboutBtn.onclick = openAbout;
    if (aboutModal) {
      const cb = document.getElementById('aboutClose');
      if (cb) cb.onclick = closeAbout;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aboutModal.classList.contains('hidden')) closeAbout(); });
    }
  }

  attachInput();
  attachTextDialog();
  attachClipboardMenu();
  attachKeybar();
  attachModeBtn();
  attachLocalCursor();
  attachAbout();
  connect();
})();
