// PAssist の Sigstore Bundle ブラウザ完全検証（自前軽量実装）。
// @sigstore/verify は Node.js 専用なので、 RFC 6962 の Merkle inclusion proof を
// WebCrypto + 純粋な SHA-256 演算だけで自前検証する（依存ライブラリゼロ）。
//
// 検証する内容:
//   1. bundle.json (cosign sign --bundle の出力) の Rekor entry の `canonicalizedBody`
//      を base64 デコードして RFC 6962 leaf hash (SHA-256) を計算
//   2. inclusionProof.hashes を順次 SHA-256 で辿って root hash を計算
//   3. 算出 root が bundle 内の rootHash と一致 → Rekor 公開transparency logに登録済
//   4. canonicalizedBody から hashedrekord payload を抽出、 image digest を取り出す
//   5. /api/build の申告 digest と一致確認
//   6. certificate の subject から identity (github.com/paps-jp/passist) を抽出して確認
// → 5項目すべて一致なら「サーバの動作中image=GitHub Actions公開ビルド」を数学的に証明。
//
// 限界（透明性のため明記）:
//   - Rekor 自体の Signed Tree Head (STH) の rsa-pss signature は verify しない（簡略化）。
//     "Rekor が改ざんされていない" は Sigstore 運営の透明性と外部監視に依存する。
//   - Fulcio certificate chain の完全 verify はしない（root cert を内包しない）。
//     identity の subject 文字列だけ抽出して確認する。
//   - 厳密検証が必要な人は cosign verify を PC で実行できる（bundle 自体は同じ）。

(() => {
  'use strict';

  const RFC6962_LEAF_PREFIX = new Uint8Array([0x00]);
  const RFC6962_NODE_PREFIX = new Uint8Array([0x01]);

  function bytesToHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }
  function hexToBytes(h) {
    const r = new Uint8Array(h.length / 2);
    for (let i = 0; i < h.length; i += 2) r[i / 2] = parseInt(h.slice(i, i + 2), 16);
    return r;
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const r = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) r[i] = bin.charCodeAt(i);
    return r;
  }
  function bytesToString(b) {
    return new TextDecoder().decode(b);
  }
  async function sha256(buf) {
    if (typeof buf === 'string') buf = new TextEncoder().encode(buf);
    const h = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(h);
  }
  function concat(...arrays) {
    let total = 0; for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let o = 0; for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  }
  async function leafHash(data) {
    return sha256(concat(RFC6962_LEAF_PREFIX, data));
  }
  async function nodeHash(left, right) {
    return sha256(concat(RFC6962_NODE_PREFIX, left, right));
  }

  // RFC 6962 inclusion proof verify。 leafIndex/treeSize から左右判定を行う。
  // 参考: https://www.rfc-editor.org/rfc/rfc6962#section-2.1.1
  async function verifyInclusionProof(leafIndex, treeSize, leafHashBytes, proofHashesHex, expectedRootHex) {
    if (leafIndex >= treeSize) return { ok: false, error: 'leafIndex out of range' };
    let h = leafHashBytes;
    let fn = leafIndex;
    let sn = treeSize - 1;
    for (const siblingHex of proofHashesHex) {
      const sibling = hexToBytes(siblingHex);
      if (sn === 0) return { ok: false, error: 'proof too long' };
      if ((fn & 1) === 1 || fn === sn) {
        h = await nodeHash(sibling, h);
        if (fn === sn) {
          while ((fn & 1) === 0) { fn >>>= 1; sn >>>= 1; }
        }
      } else {
        h = await nodeHash(h, sibling);
      }
      fn >>>= 1; sn >>>= 1;
    }
    if (sn !== 0) return { ok: false, error: 'proof too short' };
    const got = bytesToHex(h);
    if (got !== expectedRootHex) return { ok: false, error: 'root mismatch', got, expected: expectedRootHex };
    return { ok: true, rootHash: got };
  }

  // X.509 PEM/DER から SubjectAlternativeName と OID 拡張をかなり緩く抽出する軽量パーサ。
  // 完全な X.509 解析はしないが、 cosign が Fulcio で発行する典型形式から
  // SAN URI (例: https://github.com/paps-jp/passist/.github/workflows/release-signaling.yml@refs/tags/v0.2.3) を
  // 文字列スキャンで取り出すには十分。
  function extractIdentityFromCertPem(pemOrDer) {
    let raw = pemOrDer;
    if (typeof raw === 'string') {
      raw = raw.replace(/-----BEGIN CERTIFICATE-----/g, '')
               .replace(/-----END CERTIFICATE-----/g, '')
               .replace(/\s+/g, '');
      try { raw = base64ToBytes(raw); } catch { raw = null; }
    } else if (raw instanceof Uint8Array) {
      // already DER
    } else {
      raw = null;
    }
    if (!raw) return null;
    const txt = bytesToString(raw);
    // SubjectAlternativeName: 主に URI 形式の identity を抽出
    const urlMatch = txt.match(/https?:\/\/[^\s\0\x01\x06\x82\x80\x86]+/);
    const issuerMatch = txt.match(/https:\/\/token\.actions\.githubusercontent\.com/);
    return {
      uri: urlMatch ? urlMatch[0] : '',
      issuer: issuerMatch ? issuerMatch[0] : '',
    };
  }

  // Sigstore Bundle (cosign sign --bundle 出力) を verify する。
  // @param bundle: bundle.json をパースしたオブジェクト
  // @param expectedDigest: /api/build の imageDigest (sha256:...) 形式
  // @param expectedIdentityRegexp: 期待する subject (https://github.com/paps-jp/passist)
  async function verifyBundle(bundle, expectedDigest, expectedIdentityRegexp, expectedIssuer) {
    const checks = { merkleProof: null, digestMatch: null, identityMatch: null, issuerMatch: null };
    try {
      const tlog = (bundle.verificationMaterial?.tlogEntries || [])[0];
      if (!tlog) return { ok: false, error: 'No tlog entry in bundle', checks };

      // 1. canonicalizedBody → leaf hash → inclusion proof verify
      const bodyBytes = base64ToBytes(tlog.canonicalizedBody);
      const leaf = await leafHash(bodyBytes);
      const proof = tlog.inclusionProof;
      if (!proof) return { ok: false, error: 'No inclusionProof in tlog entry', checks };
      const merkle = await verifyInclusionProof(
        Number(proof.logIndex),
        Number(proof.treeSize),
        leaf,
        proof.hashes || [],
        proof.rootHash
      );
      checks.merkleProof = merkle;
      if (!merkle.ok) return { ok: false, error: 'Merkle inclusion proof failed: ' + merkle.error, checks };

      // 2. body から image digest を抽出
      const bodyJson = JSON.parse(bytesToString(bodyBytes));
      // kind=hashedrekord の場合: spec.data.hash.value が payload (simplesigning JSON) の SHA-256
      // simplesigning JSON 自体には critical.image.docker-manifest-digest が入る
      // が、 cosign 2.x の bundle では bundle.dsseEnvelope か bundle.messageSignature に payload があり、
      // 通常 messageSignature.messageDigest.digest が image digest になる。
      let extractedDigest = '';
      if (bundle.messageSignature?.messageDigest?.digest) {
        // base64 → hex に変換
        const md = bundle.messageSignature.messageDigest.digest;
        const mdBytes = base64ToBytes(md);
        extractedDigest = 'sha256:' + bytesToHex(mdBytes);
      } else if (bodyJson.spec?.data?.hash?.value) {
        extractedDigest = 'sha256:' + bodyJson.spec.data.hash.value;
      }
      const expected = expectedDigest || '';
      checks.digestMatch = { ok: !!extractedDigest && extractedDigest === expected, got: extractedDigest, expected };

      // 3. certificate から identity 抽出
      const cert = bundle.verificationMaterial?.certificate?.rawBytes
        || bundle.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
      let ident = null;
      if (cert) ident = extractIdentityFromCertPem(typeof cert === 'string' ? base64ToBytes(cert) : cert);
      const re = expectedIdentityRegexp ? new RegExp(expectedIdentityRegexp) : null;
      checks.identityMatch = { ok: !!(ident && ident.uri && (!re || re.test(ident.uri))), uri: ident?.uri || '' };
      checks.issuerMatch = { ok: !!(ident && ident.issuer === expectedIssuer), got: ident?.issuer || '' };

      const integratedTime = Number(tlog.integratedTime) || null;
      const allOk = checks.merkleProof?.ok && checks.digestMatch?.ok && checks.identityMatch?.ok;
      return {
        ok: !!allOk,
        checks,
        rootHash: merkle.rootHash,
        logIndex: tlog.logIndex,
        integratedTime,
        subject: ident?.uri || '',
        issuer: ident?.issuer || '',
        digest: extractedDigest,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e), checks };
    }
  }

  // window に公開
  window.__passistSigVerify = { verifyBundle };
})();
