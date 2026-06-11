'use strict';
// about.html の動的部分: アプリ情報取得 → サーバ /api/build 取得 → cosign verify 自動実行 → 結果表示
(() => {
  const $ = (id) => document.getElementById(id);

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function init() {
    // 1. アプリ情報を取得して上部 + 技術情報セクションに反映
    const info = await window.about.getInfo();
    $('appVersion').textContent = info.version;
    if (info.iconDataUrl) $('logoImg').src = info.iconDataUrl;
    $('techInfo').innerHTML = `
      <b>Electron</b><code>${escHtml(info.electron)}</code>
      <b>Chromium</b><code>${escHtml(info.chrome)}</code>
      <b>Node.js</b><code>${escHtml(info.node)}</code>
      <b>V8</b><code>${escHtml(info.v8)}</code>
      <b>Platform</b><code>${escHtml(info.platform)} ${escHtml(info.arch)}</code>
      <b>シグナリング</b><code>${escHtml(info.signalWs)}</code>
    `;

    // 2. リンクボタンに openExternal を配線
    document.querySelectorAll('button[data-href]').forEach((b) => {
      b.onclick = () => window.about.openExternal(b.dataset.href);
    });

    // 3. シグナリングサーバの /api/build を取得 → サーバ情報セクションに反映
    const sv = await window.about.fetchServer(info.signalWs);
    if (!sv.ok) {
      $('serverInfo').innerHTML = `<span class="warn-text">⚠ サーバ情報を取得できませんでした: ${escHtml(sv.error || sv.reason || '不明')}</span>`;
      $('cosignResult').innerHTML = '';
      return;
    }
    const b = sv.data || {};
    renderServerInfo(b);

    // 4. bundle URL があれば、ブラウザ単独で Sigstore Bundle を完全検証（自前SHA-256 Merkle proof verify）
    if (!b.imageDigest || !b.bundleUrl) {
      $('cosignResult').innerHTML = `<div class="row"><span class="badge warn">未署名</span><span class="muted">このサーバは開発版で、署名済 Bundle を公開していません。</span></div>`;
      return;
    }
    $('cosignResult').innerHTML = `<div class="loading-row"><div class="spinner"></div><span>Sigstore Bundle を取得して自前検証中… (SHA-256 Merkle inclusion proof + identity 確認)</span></div>`;
    const v = await runBrowserVerify(info.signalWs, b);
    renderCosignResult(v, b);
  }

  // sigverify.js (window.__passistSigVerify) を使ってブラウザ単独で完全検証する。
  // 1) /api/cosign/bundle?tag=... で signaling 中継 → GitHub Release から bundle.json 取得
  // 2) RFC 6962 Merkle inclusion proof を SHA-256 で自前検証
  // 3) bundle の subject digest と /api/build の imageDigest が一致するかチェック
  // 4) certificate の identity (subject URI) が paps-jp/passist のworkflowかチェック
  async function runBrowserVerify(signalWs, build) {
    try {
      if (!window.__passistSigVerify) return { ok: false, reason: 'lib_missing', error: 'sigverify.js が読み込まれていません' };
      const wsUrl = new URL(signalWs);
      const httpProto = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
      const apiBase = `${httpProto}//${wsUrl.host}`;
      const bRes = await fetch(apiBase + build.bundleUrl);
      if (!bRes.ok) return { ok: false, reason: 'bundle_fetch_failed', error: 'HTTP ' + bRes.status };
      const bundle = await bRes.json();
      const result = await window.__passistSigVerify.verifyBundle(
        bundle, build.imageDigest, build.certificateIdentityRegexp, build.certificateOidcIssuer
      );
      return result;
    } catch (e) {
      return { ok: false, reason: 'exception', error: e.message };
    }
  }

  function renderServerInfo(b) {
    $('serverInfo').innerHTML = `
      <div class="kv">
        <b>commit</b><code>${escHtml(b.commit || '(未公開)')}</code>
        <b>image digest</b><code>${escHtml(b.imageDigest || '(未公開)')}</code>
        <b>built at</b><span>${escHtml(b.builtAt || '(未公開)')}</span>
        <b>registry</b><code>${escHtml(b.registry || '')}</code>
      </div>
    `;
  }

  function renderCosignResult(v, b) {
    const target = $('cosignResult');
    if (v.ok) {
      const ts = v.integratedTime ? new Date(v.integratedTime * 1000).toISOString() : '';
      target.innerHTML = `
        <div class="row">
          <span class="badge ok">✓ ブラウザで完全検証成功</span>
          <span class="label">このサーバが動かしている image は、公開コードから GitHub Actions でビルド・署名されたことを<strong>このウィンドウ単独で</strong>暗号学的に確認しました。</span>
        </div>
        <div class="kv" style="margin-top:6px">
          ${v.subject ? '<b>署名者</b><code>' + escHtml(v.subject) + '</code>' : ''}
          ${v.issuer ? '<b>発行者</b><code>' + escHtml(v.issuer) + '</code>' : ''}
          ${ts ? '<b>署名時刻</b><span>' + escHtml(ts) + '</span>' : ''}
          ${v.logIndex ? '<b>log index</b><code>' + escHtml(v.logIndex) + '</code>' : ''}
          ${v.rootHash ? '<b>root hash</b><code>' + escHtml(v.rootHash) + '</code>' : ''}
        </div>
        <p class="muted" style="margin-top:6px">検証内容: ①Sigstore Bundle 取得 ②SHA-256 で RFC 6962 Merkle inclusion proof 検証 ③申告 digest と bundle の image digest 一致 ④certificate の identity が github.com/paps-jp/passist の release ワークフローと一致。</p>
        <p class="muted" style="margin-top:4px">数学的根拠：SHA-256 衝突困難性 + Sigstore Rekor 公開transparency log。</p>
      `;
    } else {
      const chk = v.checks || {};
      target.innerHTML = `
        <div class="row">
          <span class="badge err">✗ 検証失敗</span>
          <span class="label">${escHtml(v.error || v.reason || '不明なエラー')}</span>
        </div>
        ${chk.merkleProof || chk.digestMatch || chk.identityMatch ? `
        <div class="kv" style="margin-top:6px">
          <b>Merkle proof</b><span>${chk.merkleProof?.ok ? '✓' : '✗ ' + escHtml(chk.merkleProof?.error || '')}</span>
          <b>digest 一致</b><span>${chk.digestMatch?.ok ? '✓' : '✗ got=' + escHtml(chk.digestMatch?.got || '')}</span>
          <b>identity 一致</b><span>${chk.identityMatch?.ok ? '✓' : '✗ uri=' + escHtml(chk.identityMatch?.uri || '')}</span>
        </div>` : ''}
        <details open>
          <summary>手動で再確認するコマンド</summary>
          <pre>cosign verify ${escHtml(b.registry)}@${escHtml(b.imageDigest)} \\
  --certificate-identity-regexp 'https://github.com/paps-jp/passist' \\
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'</pre>
        </details>
      `;
    }
  }

  init().catch((e) => {
    $('serverInfo').innerHTML = `<span class="err-text">初期化エラー: ${escHtml(e.message)}</span>`;
  });
})();
