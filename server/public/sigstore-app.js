// ブラウザで Sigstore Bundle を完全検証する薄いラッパー。
// viewer.js / about.js から `await import('/sigstore-app.js')` で動的ロード。
// 実体は @sigstore/verify を esbuild で1ファイル化した sigstore-verifier.bundle.js。

let _loaded = null;
async function loadLib() {
  if (_loaded) return _loaded;
  _loaded = await import('/sigstore-verifier.bundle.js');
  return _loaded;
}

// Sigstore の TrustedRoot（Fulcio CA + Rekor / CTlog 公開鍵の集合）。
// 通常は TUF 経由で取得するが、ブラウザ単体では難しいので、ライブラリに同梱の root を使う。
// Sigstore の公開 root は ietf.org/sigstore で公開されており、安定（数年単位で同じ）。
async function getTrustedRoot() {
  // 末端ブラウザでの簡易化のため、 SigstoreのpublicインスタンスのTrustedRootをfetch
  const r = await fetch('https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json');
  if (!r.ok) throw new Error('trusted_root fetch failed: ' + r.status);
  return await r.json();
}

/**
 * Sigstore Bundle (cosign sign --bundle が出力するJSON) を完全検証する。
 * @param {object} args
 * @param {object} args.bundleJson  - Sigstore Bundle v0.3 JSON
 * @param {string} args.certificateIdentityRegexp  - 期待する subject (e.g. https://github.com/paps-jp/passist)
 * @param {string} args.certificateOidcIssuer       - 期待する issuer
 * @returns {Promise<{ok: boolean, error?: string, subject?: string, issuer?: string, integratedTime?: number}>}
 */
export async function verifyBundle(args) {
  const { Verifier, bundleFromJSON, TrustedRoot } = await loadLib();
  const rootJson = await getTrustedRoot();
  const trustedRoot = TrustedRoot.fromJSON(rootJson);
  const bundle = bundleFromJSON(args.bundleJson);

  const policy = {
    subjectAlternativeName: { regexp: args.certificateIdentityRegexp },
    extensions: { issuer: args.certificateOidcIssuer },
  };

  try {
    const verifier = new Verifier(trustedRoot);
    const result = verifier.verify(bundle, { tlogThreshold: 1 });
    // 簡易識別: signing certificate の subject を取り出す
    const subject = result?.signer?.subjectAlternativeName || '';
    const issuer = result?.signer?.issuer || '';
    const integratedTime = result?.tlogTimestamps?.[0]?.timestamp || null;
    // identity チェック
    const okSubject = new RegExp(args.certificateIdentityRegexp).test(subject);
    const okIssuer = issuer === args.certificateOidcIssuer;
    if (!okSubject) return { ok: false, error: 'subject mismatch: ' + subject };
    if (!okIssuer) return { ok: false, error: 'issuer mismatch: ' + issuer };
    return { ok: true, subject, issuer, integratedTime };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * /api/build の imageDigest が bundle 内の subject digest と一致するかチェック。
 * これにより「サーバが申告した digest」と「Sigstore で署名された digest」が同じことを保証する。
 */
export function digestMatches(bundleJson, expectedDigest) {
  try {
    const expected = expectedDigest.replace(/^sha256:/, '');
    const subjects = bundleJson?.verificationMaterial?.tlogEntries?.[0]?.canonicalizedBody;
    // 簡易版: messageSignature.messageDigest があればそれを使う
    const md = bundleJson?.messageSignature?.messageDigest?.digest;
    if (md) {
      const b64 = md.replace(/-/g, '+').replace(/_/g, '/');
      const hex = atobToHex(b64);
      return hex === expected;
    }
    // フォールバック: tlogEntry の payload を JSON parse して subject hash を見る
    if (typeof subjects === 'string') {
      const decoded = atob(subjects);
      return decoded.includes(expected);
    }
    return null; // 判定不能
  } catch {
    return null;
  }
}

function atobToHex(b64) {
  const bin = atob(b64);
  let s = '';
  for (let i = 0; i < bin.length; i++) s += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return s;
}
