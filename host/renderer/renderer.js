/* ホスト側レンダラ（Chromium）。WebRTC の offer 側。
 * - 開いているウィンドウ一覧を表示 → 1つ選択 → そのウィンドウだけをキャプチャ
 * - シグナリングサーバに接続して共有URLを発行
 * - ビューア接続を承認したら映像トラックを送出、入力は DataChannel で受信して注入へ転送 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let cfg, ws, pc, dc, stream;

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
    // ホストのクリップボード変更をクライアントへ転送（接続中のみ）
    window.host.onClipHost((text) => {
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ t: 'clip', s: text }));
    });
    // ホストのカーソル形状をクライアントへ転送（接続中のみ）→ ローカルカーソルの形に反映
    window.host.onCursorShape((shape) => {
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ t: 'cursor', s: shape }));
    });
    $('reload').onclick = loadWindows;
    $('back').onclick = () => {
      sessionStorage.setItem('passist_skip', '1'); // 手動で戻る時は自動再開しない
      location.reload();
    };
    $('copy').onclick = copyUrl;
    $('reissue').onclick = reissue;
    $('approve').onclick = onApprove;
    $('deny').onclick = () => {
      sendWs({ type: 'host:deny' });
      $('request').classList.add('hidden');
      $('trustChk').checked = false;
    };
    $('trustLink').onclick = issueTrustLink;
    $('copyTrust').onclick = () => copyField('trustUrl', 'copyTrust');
    refreshTrustInfo();
    $('end').onclick = () => {
      sendWs({ type: 'host:end' });
      window.host.settingsSet({ activeShareName: '' }); // 終了＝次回からの自動再開を解除
      stopWatch();
      closePeer();
      setStatus('セッションを終了しました');
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
    try {
      stream = await capture();
    } catch (e) {
      if (opts.auto) {
        showResume(w); // 自動再開でキャプチャ不可（ユーザー操作要求等）→ 再開ボタンを提示
        return;
      }
      alert('キャプチャを開始できませんでした: ' + e.message);
      return;
    }
    hideWatch();
    $('preview').srcObject = stream;
    $('picker').classList.add('hidden');
    $('session').classList.remove('hidden');
    startSignaling();
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
    ws = new WebSocket(cfg.signalWs);
    ws.onopen = () => sendWs({ type: 'host:create', publicBaseUrl: $('publicBase').value.trim() || undefined });
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => setStatus('サーバとの接続が切断されました');
    ws.onerror = () => setStatus('サーバに接続できません: ' + cfg.signalWs);
  }
  const sendWs = (o) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

  function onMsg(msg) {
    switch (msg.type) {
      case 'session':
        $('url').value = msg.viewerUrl;
        if (msg.pin) {
          $('pin').textContent = 'PIN: ' + msg.pin;
          $('pin').classList.remove('hidden');
        }
        setStatus('待機中。URLを共有してください（有効期限あり）。');
        break;
      case 'viewer:request':
        handleViewerRequest(msg.auth);
        break;
      case 'viewer:joined':
        $('request').classList.add('hidden');
        startPeer();
        break;
      case 'viewer:left':
        setStatus('利用者が切断しました');
        closePeer();
        break;
      case 'signal':
        handleSignal(msg.data);
        break;
      case 'expired':
        setStatus('有効期限切れ。「別のウィンドウを選ぶ」から再発行してください');
        closePeer();
        break;
    }
  }

  function reissue() {
    // 既存接続を畳んで新しいセッションURLを発行
    closePeer();
    try { ws && ws.close(); } catch {}
    startSignaling();
  }

  // 信頼済みクレデンシャル提示時は自動承認（ダイアログを出さない）。それ以外は承認ダイアログ。
  async function handleViewerRequest(auth) {
    if (auth) {
      const res = await window.host.trustCheck(auth);
      if (res && res.trusted) {
        sendWs({ type: 'host:approve' });
        setStatus('信頼済み端末を自動承認しました' + (res.label ? '（' + res.label + '）' : ''));
        return;
      }
    }
    $('request').classList.remove('hidden');
    setStatus('接続リクエストがあります');
  }

  async function onApprove() {
    // 「この端末を信頼」がオンなら新しいクレデンシャルを発行してビューアへ渡す
    let issue = null;
    if ($('trustChk').checked) issue = await window.host.trustIssue('承認時に信頼');
    sendWs({ type: 'host:approve', issue });
    $('request').classList.add('hidden');
    $('trustChk').checked = false;
    refreshTrustInfo();
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

  async function startPeer() {
    closePeer(); // 再接続時の取りこぼし防止：既存接続を確実に解放してから作る
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    dc = pc.createDataChannel('input');
    dc.onopen = () => {
      window.host.focusTarget(); // 操作開始時に対象ウィンドウを前面へ
      window.host.cursorTrack(true); // ホストのカーソル形状追跡を開始
    };
    dc.onmessage = (e) => {
      try {
        window.host.sendInput(JSON.parse(e.data));
      } catch {}
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendWs({ type: 'signal', data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      const st = pc && pc.connectionState;
      setStatus('接続状態: ' + st);
      if (st === 'failed' || st === 'closed') closePeer(); // 死んだ接続を確実に解放（リーク防止）
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: 'signal', data: { sdp: pc.localDescription } });
  }

  async function handleSignal(data) {
    if (!pc) return;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp); // ビューアからの answer
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn('addIceCandidate', err);
      }
    }
  }

  function closePeer() {
    // ハンドラを外してから閉じる（閉じた後のコールバックで古い参照を触らない＝リーク/誤動作防止）
    if (dc) {
      try { dc.onopen = null; dc.onmessage = null; dc.close(); } catch {}
      dc = null;
    }
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.ontrack = null;
        pc.close();
      } catch {}
      pc = null;
    }
    $('request').classList.add('hidden');
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
})();
