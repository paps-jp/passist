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

    // 4. image digest があれば cosign verify を自動実行
    if (!b.imageDigest) {
      $('cosignResult').innerHTML = `<div class="row"><span class="badge warn">未署名</span><span class="muted">このサーバは開発版で、署名済 image を公開していません。</span></div>`;
      return;
    }
    $('cosignResult').innerHTML = `<div class="loading-row"><div class="spinner"></div><span>cosign verify を実行中… (Sigstore Rekor の透明性ログで暗号学的に検証します)</span></div>`;
    const v = await window.about.cosignVerify(b.registry, b.imageDigest);
    renderCosignResult(v, b);
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
      // cosign verify 成功 → 公開コードからビルド・署名されたことを Sigstore Rekor で確認
      const summary = pickCosignSummary(v.parsed);
      target.innerHTML = `
        <div class="row">
          <span class="badge ok">✓ 検証成功</span>
          <span class="label">このサーバが動かしている image は、公開コードから GitHub Actions でビルド・署名されたことを暗号学的に確認しました。</span>
        </div>
        ${summary ? `<div class="kv" style="margin-top:6px">${summary}</div>` : ''}
        <details>
          <summary>cosign verify の出力（詳細）</summary>
          <pre>${escHtml(v.stderr || '')}${v.stderr && v.stdout ? '\n' : ''}${escHtml(v.stdout || '')}</pre>
        </details>
        <p class="muted" style="margin-top:6px">数学的根拠：SHA-256 衝突困難性 + Ed25519/ECDSA 署名 + Sigstore Rekor (Merkle tree)。</p>
      `;
    } else if (v.reason === 'no_cosign') {
      target.innerHTML = `
        <div class="row">
          <span class="badge warn">cosign 未インストール</span>
          <span class="label">この PC に <code>cosign</code> コマンドがありません。</span>
        </div>
        <p class="muted">手動で検証する場合は <button data-cosign-install>Sigstore cosign のダウンロードページ</button> を開いてください。</p>
        <details open>
          <summary>手動で実行するコマンド</summary>
          <pre>cosign verify ${escHtml(b.registry)}@${escHtml(b.imageDigest)} \\
  --certificate-identity-regexp 'https://github.com/paps-jp/passist' \\
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'</pre>
        </details>
      `;
      const dl = target.querySelector('[data-cosign-install]');
      if (dl) dl.onclick = () => window.about.openExternal('https://docs.sigstore.dev/cosign/system_config/installation/');
    } else {
      target.innerHTML = `
        <div class="row">
          <span class="badge err">✗ 検証失敗</span>
          <span class="label">${escHtml(v.error || v.reason || '不明なエラー')}</span>
        </div>
        ${v.stderr ? `<details open><summary>cosign のエラー出力</summary><pre>${escHtml(v.stderr)}</pre></details>` : ''}
        <p class="muted">ネットワーク制限・Sigstore の一時障害・rekor との通信不良などの可能性があります。</p>
      `;
    }
  }

  // cosign の JSON 出力(配列) から表示用 1 件を取り出して整形
  function pickCosignSummary(parsed) {
    if (!parsed || !Array.isArray(parsed) || !parsed.length) return '';
    const e = parsed[0] || {};
    const opt = (e.optional || e.Optional) || {};
    const subject = opt['Subject'] || opt['subject'] || opt['Bundle']?.['payload']?.['subject'] || '';
    const issuer = opt['Issuer'] || opt['issuer'] || '';
    const integratedTime = opt['IntegratedTime'] || opt['integratedTime'] || '';
    const rows = [];
    if (subject) rows.push(`<b>署名者</b><code>${escHtml(subject)}</code>`);
    if (issuer) rows.push(`<b>発行者</b><code>${escHtml(issuer)}</code>`);
    if (integratedTime) {
      const ts = Number(integratedTime);
      const date = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : String(integratedTime);
      rows.push(`<b>署名時刻</b><span>${escHtml(date)}</span>`);
    }
    return rows.join('');
  }

  init().catch((e) => {
    $('serverInfo').innerHTML = `<span class="err-text">初期化エラー: ${escHtml(e.message)}</span>`;
  });
})();
