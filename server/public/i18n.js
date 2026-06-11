// 軽量 i18n。navigator.language から ja / en を自動選択する（その他は en）。
// 使い方: window.t('verify.success') → "数学的に検証成功" (ja) / "Cryptographically verified" (en)
(function () {
  'use strict';
  const langRaw = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  const lang = String(langRaw).toLowerCase().split('-')[0];
  const M = {
    ja: {
      'verify.heading': 'サーバの真正性',
      'verify.success': '数学的に検証成功',
      'verify.successDesc': 'このサーバの image は、 公開コードから GitHub Actions でビルド・署名されたものです。',
      'verify.failed': '検証失敗',
      'verify.details': '詳細',
      'verify.signer': '署名者',
      'verify.issuer': '発行者',
      'verify.signedAt': '署名時刻',
      'verify.logIndex': 'Rekor index',
      'verify.rootHash': 'Merkle root',
      'verify.method': '検証方法：Sigstore Rekor の公開ログを SHA-256 で照合（@sigstore/verify 等のライブラリ非依存）',
      'verify.notReleased': 'このサーバはまだ署名版をリリースしていません',
      'verify.fetchError': 'サーバ情報の取得に失敗しました',
      'about.title': 'PAssist について',
      'about.lead': 'ブラウザだけで、選んだ1ウィンドウを共有・遠隔操作。 映像と操作は WebRTC（DTLS-SRTP / AES-128-GCM）で暗号化されます。',
      'about.tech': '技術情報',
      'about.license': '著作権・ライセンス',
      'about.licenseDesc': '使う・改変・自社サービス運用は商用含めて自由。 PAssist と競合する製品としての提供のみご遠慮ください。',
      'about.links': 'リンク',
      'about.homepage': 'ホームページ',
      'about.releases': 'リリース',
      'about.security': '安全性の検証',
      'crypto.heading': '接続の暗号化（WebRTC）',
      'crypto.state': '状態',
      'crypto.cipher': '暗号',
      'crypto.route': '経路',
      'crypto.bytes': '転送量',
      'crypto.note': '鍵交換は ECDHE（前方秘匿性）で行われ、 鍵はあなたのブラウザとホストPCにしか存在しません。 サーバが盗聴しても解読はできません。',
      'crypto.routeP2P': 'P2P 直接接続',
      'crypto.routeTurn': 'TURN 中継経由',
    },
    en: {
      'verify.heading': 'Server Integrity',
      'verify.success': 'Cryptographically verified',
      'verify.successDesc': 'This server image was built and signed by the public GitHub Actions workflow.',
      'verify.failed': 'Verification failed',
      'verify.details': 'Details',
      'verify.signer': 'Signer',
      'verify.issuer': 'Issuer',
      'verify.signedAt': 'Signed at',
      'verify.logIndex': 'Rekor index',
      'verify.rootHash': 'Merkle root',
      'verify.method': 'Method: SHA-256 cross-check against the public Sigstore Rekor log (no @sigstore/verify dependency).',
      'verify.notReleased': 'This server has not released a signed version yet',
      'verify.fetchError': 'Failed to fetch server info',
      'about.title': 'About PAssist',
      'about.lead': 'Share one window from your browser. Video and input are encrypted via WebRTC (DTLS-SRTP / AES-128-GCM).',
      'about.tech': 'Technical info',
      'about.license': 'Copyright & License',
      'about.licenseDesc': 'Free to use, modify, and run as your own service (commercial OK). Only re-selling as a competing product is restricted.',
      'about.links': 'Links',
      'about.homepage': 'Homepage',
      'about.releases': 'Releases',
      'about.security': 'Verification page',
      'crypto.heading': 'Connection Encryption (WebRTC)',
      'crypto.state': 'State',
      'crypto.cipher': 'Cipher',
      'crypto.route': 'Route',
      'crypto.bytes': 'Bytes',
      'crypto.note': 'Key exchange uses ECDHE (forward secrecy). Keys exist only on your browser and the host PC; even the server cannot decrypt.',
      'crypto.routeP2P': 'P2P direct',
      'crypto.routeTurn': 'via TURN relay',
    },
  };
  function t(key) {
    const d = M[lang] || M.en;
    return d[key] || M.en[key] || key;
  }
  if (typeof window !== 'undefined') {
    window.t = t;
    window.__passistLang = lang;
  }
})();
