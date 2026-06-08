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
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      stage.classList.remove('hidden');
      toolbar.classList.remove('hidden');
      setStatus('', false);
    };
    pc.ondatachannel = (e) => {
      dc = e.channel; // ホストが作成した 'input' チャネル
      dc.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.t === 'clip' && typeof m.s === 'string') onHostClip(m.s); // ホストのクリップボードを同期
          else if (m && m.t === 'cursor' && typeof m.s === 'string') applyHostCursor(m.s); // カーソル形状を反映
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
  function norm(e) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    const offX = (r.width - dispW) / 2;
    const offY = (r.height - dispH) / 2;
    const x = (e.clientX - r.left - offX) / dispW;
    const y = (e.clientY - r.top - offY) / dispH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function attachInput() {
    video.addEventListener('mousemove', (e) => {
      const p = norm(e);
      if (!p) return;
      pendingMove = p;
      if (!moveScheduled) {
        moveScheduled = true;
        requestAnimationFrame(flushMove);
      }
    });
    video.addEventListener('mousedown', (e) => {
      if (e.button === 2) return; // 右クリックはコピペのメニュー用（ホストへは送らない）
      const p = norm(e);
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
    ctxMenu.style.left = Math.min(x, window.innerWidth - 150) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - 130) + 'px';
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
      showCtxMenu(e.clientX, e.clientY);
    });
    document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
    window.addEventListener('blur', hideCtxMenu);
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
  gate.onclick = () => {
    gate.classList.add('hidden');
    hasFocus = true;
    video.focus();
    setLocalCursor(true); // 操作開始でローカルカーソルを有効化
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
  }

  attachInput();
  attachTextDialog();
  attachClipboardMenu();
  attachLocalCursor();
  connect();
})();
