'use strict';
// about.html の動的部分: アプリ情報 → /api/build → bundle/signature 取得 → sigverify で完全検証
(() => {
  const $ = (id) => document.getElementById(id);
  const t = window.t || ((k) => k);

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  function applyStaticI18n() {
    document.title = t('about.title');
    $('aboutLead').textContent = t('about.lead');
    $('verifyHeading').textContent = '🔐 ' + t('verify.heading');
    $('techHeading').textContent = '🔧 ' + t('about.tech');
    $('licenseHeading').textContent = '📜 ' + t('about.license');
    $('licenseDesc').textContent = t('about.licenseDesc');
    $('serverDetailsLabel').textContent = t('verify.details');
    $('linkHomepage').textContent = t('about.homepage');
    $('linkReleases').textContent = t('about.releases');
    $('linkSecurity').textContent = t('about.security');
  }

  async function init() {
    applyStaticI18n();
    const info = await window.about.getInfo();
    $('appVersion').textContent = info.version;
    if (info.iconDataUrl) $('logoImg').src = info.iconDataUrl;
    $('techInfo').innerHTML = `
      <b>Electron</b><code>${escHtml(info.electron)}</code>
      <b>Chromium</b><code>${escHtml(info.chrome)}</code>
      <b>Node.js</b><code>${escHtml(info.node)}</code>
      <b>Platform</b><code>${escHtml(info.platform)} ${escHtml(info.arch)}</code>
    `;

    document.querySelectorAll('button[data-href]').forEach((b) => {
      b.onclick = () => window.about.openExternal(b.dataset.href);
    });

    const sv = await window.about.fetchServer(info.signalWs);
    if (!sv.ok) {
      $('cosignResult').innerHTML = `<div class="row"><span class="badge err">✗</span><span class="label">${t('verify.fetchError')}</span></div>`;
      return;
    }
    const b = sv.data || {};
    if (!b.imageDigest || !b.bundleUrl) {
      $('cosignResult').innerHTML = `<div class="row"><span class="badge warn">ℹ</span><span class="label">${t('verify.notReleased')}</span></div>`;
      $('serverInfo').innerHTML = renderServerInfo(b);
      return;
    }
    $('cosignResult').innerHTML = `<div class="loading-row"><div class="spinner"></div><span>verify…</span></div>`;
    const v = await runBrowserVerify(info.signalWs, b);
    $('cosignResult').innerHTML = renderResult(v, b);
    $('serverInfo').innerHTML = renderServerInfo(b);
  }

  function renderServerInfo(b) {
    return `<div class="kv">
      ${b.tag ? '<b>tag</b><code>' + escHtml(b.tag) + '</code>' : ''}
      <b>commit</b><code>${escHtml(short(b.commit, 12))}</code>
      <b>digest</b><code>${escHtml(short(b.imageDigest, 26))}</code>
      ${b.builtAt ? '<b>built</b><span>' + escHtml(b.builtAt) + '</span>' : ''}
    </div>`;
  }

  async function runBrowserVerify(signalWs, build) {
    try {
      if (!window.__passistSigVerify) return { ok: false, error: 'sigverify not loaded' };
      const wsUrl = new URL(signalWs);
      const httpProto = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
      const apiBase = `${httpProto}//${wsUrl.host}`;
      const [bRes, sRes] = await Promise.all([
        fetch(apiBase + build.bundleUrl),
        build.signatureUrl ? fetch(apiBase + build.signatureUrl) : Promise.resolve(null),
      ]);
      if (!bRes.ok) return { ok: false, error: 'HTTP ' + bRes.status };
      const bundle = await bRes.json();
      const signatureArtifact = sRes && sRes.ok ? await sRes.json() : null;
      return await window.__passistSigVerify.verifyBundle(
        bundle, build.imageDigest, build.certificateIdentityRegexp, build.certificateOidcIssuer, signatureArtifact
      );
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function renderResult(v, b) {
    if (v.ok) {
      const ts = v.integratedTime ? new Date(v.integratedTime * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
      return `
        <div class="row">
          <span class="badge ok">✓ ${escHtml(t('verify.success'))}</span>
          <span class="label">${escHtml(t('verify.successDesc'))}</span>
        </div>
        <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">${escHtml(t('verify.details'))}</summary>
          <div class="kv" style="margin-top:6px">
            ${v.subject ? '<b>' + escHtml(t('verify.signer')) + '</b><code>' + escHtml(short(v.subject, 80)) + '</code>' : ''}
            ${ts ? '<b>' + escHtml(t('verify.signedAt')) + '</b><span>' + escHtml(ts) + '</span>' : ''}
            ${v.logIndex ? '<b>' + escHtml(t('verify.logIndex')) + '</b><code>' + escHtml(v.logIndex) + '</code>' : ''}
          </div>
          <p class="muted" style="margin-top:6px">${escHtml(t('verify.method'))}</p>
        </details>
      `;
    }
    return `
      <div class="row">
        <span class="badge err">✗ ${escHtml(t('verify.failed'))}</span>
        <span class="label">${escHtml(v.error || '')}</span>
      </div>
    `;
  }

  init().catch((e) => {
    $('cosignResult').innerHTML = `<span class="err-text">${escHtml(e.message)}</span>`;
  });
})();
