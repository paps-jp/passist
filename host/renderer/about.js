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

    // 4. tag と bundleUrl があれば、ブラウザ完全検証（Sigstore Bundle + @sigstore/verify）
    if (!b.imageDigest || !b.bundleUrl) {
      $('cosignResult').innerHTML = `<div class="row"><span class="badge warn">未署名</span><span class="muted">このサーバは開発版で、署名済 Bundle を公開していません。</span></div>`;
      return;
    }
    $('cosignResult').innerHTML = `<div class="loading-row"><div class="spinner"></div><span>Sigstore Bundle を取得して検証中… (証明書チェーン + Rekor inclusion proof + identity 確認)</span></div>`;
    const v = await runBrowserVerify(info.signalWs, b);
    renderCosignResult(v, b);
  }

  // ブラウザ単独で Sigstore Bundle を完全検証する。
  // 1) サーバ中継 /api/cosign/bundle?tag=... で GitHub Release から bundle.json を取得
  // 2) @sigstore/verify (bundleされた sigstore-app.js) で証明書/署名/Rekor を検証
  // 3) bundle 内の subject digest が /api/build の imageDigest と一致するか確認
  async function runBrowserVerify(signalWs, build) {
    try {
      const wsUrl = new URL(signalWs);
      const httpProto = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
      const apiBase = `${httpProto}//${wsUrl.host}`;
      // 1. Bundle 取得
      const bRes = await fetch(apiBase + build.bundleUrl);
      if (!bRes.ok) return { ok: false, reason: 'bundle_fetch_failed', error: 'HTTP ' + bRes.status };
      const bundleJson = await bRes.json();
      // 2. ライブラリロード（動的 import）
      const lib = await import(apiBase + '/sigstore-app.js');
      // 3. 完全検証
      const result = await lib.verifyBundle({
        bundleJson,
        certificateIdentityRegexp: build.certificateIdentityRegexp,
        certificateOidcIssuer: build.certificateOidcIssuer,
      });
      if (!result.ok) return { ok: false, reason: 'verify_failed', error: result.error };
      // 4. digest 一致確認（bundleの subject と /api/build の申告が同じか）
      const match = lib.digestMatches(bundleJson, build.imageDigest);
      if (match === false) return { ok: false, reason: 'digest_mismatch', error: 'bundle subject != server reported digest' };
      return { ok: true, subject: result.subject, issuer: result.issuer, integratedTime: result.integratedTime, digestVerified: match };
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
          <span class="label">このサーバが動かしている image は、公開コードから GitHub Actions でビルド・署名されたことを<strong>このブラウザ単独で</strong>暗号学的に確認しました。</span>
        </div>
        <div class="kv" style="margin-top:6px">
          ${v.subject ? `<b>署名者</b><code>${escHtml(v.subject)}</code>` : ''}
          ${v.issuer ? `<b>発行者</b><code>${escHtml(v.issuer)}</code>` : ''}
          ${ts ? `<b>署名時刻</b><span>${escHtml(ts)}</span>` : ''}
          ${v.digestVerified === true ? `<b>digest 一致</b><span class="ok-text">✓ サーバ申告と Sigstore 署名が一致</span>` : ''}
        </div>
        <p class="muted" style="margin-top:6px">検証内容: ① Fulcio root CA で certificate chain ② SCT (Sigstore CT log) inclusion ③ signature (ECDSA P-256) ④ Rekor entry の Merkle inclusion proof ⑤ identity = github.com/paps-jp/passist の release workflow</p>
      `;
    } else {
      target.innerHTML = `
        <div class="row">
          <span class="badge err">✗ 検証失敗</span>
          <span class="label">${escHtml(v.error || v.reason || '不明なエラー')}</span>
        </div>
        <p class="muted">サーバ申告と Sigstore 公開ログが矛盾している、または通信エラー・ライブラリのロード失敗の可能性があります。</p>
        <details>
          <summary>手動で検証するコマンド</summary>
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
