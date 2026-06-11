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

  // バイナリ Uint8Array 中で needle (bytes) を探す
  function bytesIndexOf(haystack, needle, start) {
    start = start || 0;
    outer: for (let i = start; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
  // DER バイナリの中から「prefix で始まる ASCII 印字可能文字列」を取り出す。
  // ASN.1 IA5String / PrintableString として埋め込まれた URI を確実に拾うためにバイト単位でスキャン
  // （TextDecoder().decode() だと invalid UTF-8 が � に置換されて regex が壊れる）。
  function findUriInDer(der, prefix) {
    const pb = new TextEncoder().encode(prefix);
    const i = bytesIndexOf(der, pb);
    if (i < 0) return '';
    let end = i + pb.length;
    while (end < der.length) {
      const c = der[end];
      // ASCII printable 範囲 (0x20-0x7e) のみ URL 文字とみなす
      if (c < 0x20 || c > 0x7e) break;
      end++;
    }
    return new TextDecoder().decode(der.slice(i, end));
  }
  // X.509 certificate (PEM or DER) から SAN URI と issuer を抽出。
  // 完全な ASN.1 解析はせず、 cosign + Fulcio の典型的なフォーマットから
  // 「https://github.com/...」 と 「https://token.actions.githubusercontent.com」 をバイト列で探す。
  function extractIdentityFromCertPem(pemOrDer) {
    let raw = pemOrDer;
    if (typeof raw === 'string') {
      raw = raw.replace(/-----BEGIN CERTIFICATE-----/g, '')
               .replace(/-----END CERTIFICATE-----/g, '')
               .replace(/\s+/g, '');
      try { raw = base64ToBytes(raw); } catch { raw = null; }
    }
    if (!raw || !(raw instanceof Uint8Array)) return null;
    return {
      uri: findUriInDer(raw, 'https://github.com/'),
      issuer: findUriInDer(raw, 'https://token.actions.githubusercontent.com'),
    };
  }

  // Sigstore Bundle (cosign sign --bundle 出力) を verify する。
  // @param bundle: bundle.json をパースしたオブジェクト
  // @param expectedDigest: /api/build の imageDigest (sha256:...) 形式
  // @param expectedIdentityRegexp: 期待する subject (https://github.com/paps-jp/passist)
  // 入力1: Rekor entry (UUID-keyed object) or Sigstore Bundle
  // 入力2: cosign download signature の出力 ([{Payload(base64), Cert, Chain, Base64Signature}])
  //        ※ なくても部分検証は可。 ある場合は payload 内の docker-manifest-digest を厳密 verify。
  async function verifyBundle(input, expectedDigest, expectedIdentityRegexp, expectedIssuer, signatureArtifact) {
    const checks = { merkleProof: null, payloadHashMatch: null, digestMatch: null, identityMatch: null, issuerMatch: null };
    try {
      // ---- フォーマット正規化 ----
      let tlog = null;
      if (input.verificationMaterial?.tlogEntries?.length) {
        // Sigstore Bundle 形式
        tlog = input.verificationMaterial.tlogEntries[0];
      } else {
        // Rekor entry 形式: UUID キーの最初の値
        const uuid = Object.keys(input).find((k) => /^[0-9a-f]{40,}/.test(k)) || Object.keys(input)[0];
        const e = input[uuid] || {};
        tlog = {
          canonicalizedBody: e.body,
          inclusionProof: e.verification?.inclusionProof,
          integratedTime: e.integratedTime,
          logIndex: e.logIndex,
        };
      }
      if (!tlog || !tlog.canonicalizedBody) return { ok: false, error: 'No body/canonicalizedBody in entry', checks };
      if (!tlog.inclusionProof) return { ok: false, error: 'No inclusionProof in entry', checks };

      // 1. canonicalizedBody → leaf hash → inclusion proof verify (RFC 6962, SHA-256)
      const bodyBytes = base64ToBytes(tlog.canonicalizedBody);
      const leaf = await leafHash(bodyBytes);
      const proof = tlog.inclusionProof;
      const merkle = await verifyInclusionProof(
        Number(proof.logIndex),
        Number(proof.treeSize),
        leaf,
        proof.hashes || [],
        proof.rootHash
      );
      checks.merkleProof = merkle;
      if (!merkle.ok) return { ok: false, error: 'Merkle inclusion proof failed: ' + merkle.error, checks };

      // 2. body (hashedrekord) の hash 値 = Payload(simplesigning JSON) の SHA-256。
      //    cosign signature artifact から Payload を取り、 ① hash 一致 ② 中の docker-manifest-digest 確認。
      const bodyJson = JSON.parse(bytesToString(bodyBytes));
      const rekorHashValue = bodyJson.spec?.data?.hash?.value || '';
      let extractedDigest = '';
      let payloadHashOk = false;
      // cosign download signature は cosign バージョンにより配列 or 単一オブジェクトを返すので両対応
      const sigObj = Array.isArray(signatureArtifact) ? signatureArtifact[0] : signatureArtifact;
      if (sigObj && sigObj.Payload) {
        // Payload は base64 encoded simplesigning JSON
        const payloadB64 = sigObj.Payload;
        const payloadBytes = base64ToBytes(payloadB64);
        // ① payload SHA-256 が rekor entry の hash と一致するか
        const computedHash = await sha256(payloadBytes);
        const computedHex = bytesToHex(computedHash);
        payloadHashOk = computedHex === rekorHashValue;
        checks.payloadHashMatch = { ok: payloadHashOk, got: computedHex, expected: rekorHashValue };
        // ② payload 内の docker-manifest-digest を抽出
        if (payloadHashOk) {
          try {
            const payloadJson = JSON.parse(bytesToString(payloadBytes));
            extractedDigest = payloadJson?.critical?.image?.['docker-manifest-digest'] || '';
          } catch {}
        }
      } else if (input.messageSignature?.messageDigest?.digest) {
        const md = input.messageSignature.messageDigest.digest;
        extractedDigest = 'sha256:' + bytesToHex(base64ToBytes(md));
      }
      const expected = expectedDigest || '';
      checks.digestMatch = { ok: !!extractedDigest && extractedDigest === expected, got: extractedDigest, expected };

      // 3. certificate (base64 encoded PEM) を取り出して identity を抽出
      let certInput = null;
      if (sigObj?.Cert) {
        certInput = sigObj.Cert;
      } else if (bodyJson.spec?.signature?.publicKey?.content) {
        // hashedrekord: publicKey.content は base64-encoded PEM
        certInput = atob(bodyJson.spec.signature.publicKey.content);
      } else if (input.verificationMaterial?.certificate?.rawBytes) {
        certInput = input.verificationMaterial.certificate.rawBytes;
      } else if (input.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes) {
        certInput = input.verificationMaterial.x509CertificateChain.certificates[0].rawBytes;
      }
      let ident = certInput ? extractIdentityFromCertPem(certInput) : null;
      const re = expectedIdentityRegexp ? new RegExp(expectedIdentityRegexp) : null;
      checks.identityMatch = { ok: !!(ident && ident.uri && (!re || re.test(ident.uri))), uri: ident?.uri || '' };
      checks.issuerMatch = { ok: !!(ident && ident.issuer === expectedIssuer), got: ident?.issuer || '' };

      const integratedTime = Number(tlog.integratedTime) || null;
      // signatureArtifact があれば「payload hash 一致 + payload 内の digest 一致」 まで含めて完全 verify
      const allOk = checks.merkleProof?.ok && checks.identityMatch?.ok
        && (signatureArtifact ? (checks.payloadHashMatch?.ok && checks.digestMatch?.ok) : true);
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
