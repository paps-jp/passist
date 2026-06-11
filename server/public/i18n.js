// 軽量 i18n。
// 言語選択: localStorage('passist-lang') > navigator.language > 'en'
// マークアップ:
//   <span data-i18n="lp.title">フォールバック</span>      // textContent を翻訳で上書き
//   <span data-i18n-html="lp.hero.sub"></span>             // innerHTML (HTML タグ可)
//   <input data-i18n-attr="placeholder:input.search">      // 任意属性。 複数は "a1:k1;a2:k2"
//   <html lang="ja" data-i18n-title="lp.docTitle">         // document.title を翻訳
//   window.t('verify.success') / window.setLang('en')      // 関数 API
// DOMContentLoaded で自動適用。 動的追加は applyI18n(rootElement) を呼ぶ。
(function () {
  'use strict';
  const navRaw = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  const navLang = String(navRaw).toLowerCase().split('-')[0];
  let stored = null;
  try { stored = (typeof localStorage !== 'undefined') ? localStorage.getItem('passist-lang') : null; } catch {}
  const lang = (stored === 'ja' || stored === 'en') ? stored : (navLang === 'ja' ? 'ja' : 'en');

  const M = {
    ja: {
      // === 共通 ===
      'lang.ja': '日本語',
      'lang.en': 'English',

      // === LP: docs/index.html ===
      'lp.docTitle': 'PAssist — ブラウザだけで1ウィンドウを共有・遠隔操作',
      'lp.h1': 'PAssist — ブラウザだけで1ウィンドウを共有・遠隔操作',
      'lp.logoAlt': 'PAssist ロゴ',
      'lp.tagline': 'ブラウザだけで、1つのウィンドウを共有・遠隔操作。',
      'lp.sub': 'アカウント不要。 相手は<strong>QRコードを読み取るだけ</strong>（またはURLを開くだけ）で、 すぐに操作を開始。 デスクトップ全体は決して映りません。',
      'lp.cta.download': 'Windows版をダウンロード',
      'lp.cta.docs': 'ドキュメント',
      'lp.cta.github': 'GitHub',
      'lp.meta': '無料・オープンソース ／ <b>Windows 10 / 11（64bit）</b> ／ インストール不要のポータブル版',
      'lp.about.title': 'PAssist とは',
      'lp.about.lead': 'PAssist は Windows 向けのリモート操作ツールです。 共有するのは<strong>選んだ 1 つのウィンドウだけ</strong>。 操作する相手は<strong>ブラウザを開くだけ</strong>（インストール・アカウント不要）で、 映像と操作は WebRTC で暗号化されて流れます。',
      'lp.feat1.title': '1ウィンドウだけ共有',
      'lp.feat1.desc': '選んだ1つのウィンドウのみ。 デスクトップや他の画面は構造的に映りません。',
      'lp.feat2.title': '相手はブラウザだけ',
      'lp.feat2.desc': 'インストールもアカウントも不要。 送られたURLを開くだけで操作を開始できます。',
      'lp.feat3.title': '検証に基づく安全性 →',
      'lp.feat3.desc': 'WebRTC で映像はP2P＆DTLS-SRTP暗号化。 さらに Reproducible Build + Cosign 署名で「サーバが公開コードと同じ」を数学的に検証可能。',
      'lp.feat4.title': 'ホスト承認制',
      'lp.feat4.desc': 'あなたが許可するまで何も映りません。 信頼した端末は次回から自動接続も可能。',
      'lp.feat5.title': '脱出キーをブロック',
      'lp.feat5.desc': 'Win / Alt+Tab / Alt+F4 などを遮断。 操作は対象ウィンドウの中だけに限定。',
      'lp.feat6.title': '一時利用',
      'lp.feat6.desc': 'セッションは期限付き（既定30分）。 期限切れで自動的に失効します。 無期限にも設定できます。',
      'lp.how.title': '使い方は 3 ステップ',
      'lp.how.lead': '共有する人（ホスト）の操作はこれだけ。 下は実際のアプリ画面です（デモ表示・IP や実URLは含みません）。',
      'lp.step1.alt': '共有する画面を1つ選ぶ',
      'lp.step1.title': 'ウィンドウを選ぶ',
      'lp.step1.desc': 'PAssist を起動し、 共有したいウィンドウを 1 つクリックして選びます。',
      'lp.step2.alt': 'リンクとQRコードを送る',
      'lp.step2.title': 'リンク／QR を送る',
      'lp.step2.desc': '自動発行された共有URL（QRコードも可）を相手に送ります。',
      'lp.step3.alt': '許可すると相手がブラウザで操作',
      'lp.step3.title': '許可すると操作開始',
      'lp.step3.desc': '接続リクエストを「許可」すると、 相手はブラウザでそのウィンドウを操作できます。',
      'lp.guestNote': '操作する人（ゲスト）は、 送られた URL を<strong>ブラウザで開くだけ</strong>。 インストールもログインも要りません。',
      'lp.dl.title': 'ダウンロード',
      'lp.dl.lead': '下のボタンから最新版の実行ファイルを入手できます。',
      'lp.dl.btn': 'PAssist.exe をダウンロード',
      'lp.dl.latest': '最新版 <b>v0.1.0</b>',
      'lp.dl.os': '<b>Windows 10 / 11</b>（64bit）',
      'lp.dl.size': '約 <b>91 MB</b>',
      'lp.dl.portable': 'インストール不要（ポータブル）',
      'lp.dl.warn': '⚠ 現在この exe は<strong>コード署名をしていない</strong>ため、 初回起動時に Windows SmartScreen が「Windows によって PC が保護されました」と表示することがあります。 利用する場合は <strong>「詳細情報」→「実行」</strong> を選んでください。',
      'lp.dl.allReleases': 'すべてのリリース',
      'lp.dl.source': 'ソースコード（GitHub）',
      'lp.more.title': 'もっと詳しく',
      'lp.more.lead': '仕組み・セキュリティ・インターネット公開・設定など。',
      'lp.more.docs.title': 'ドキュメント',
      'lp.more.docs.desc': '概要・アーキテクチャ・セキュリティ・環境変数・ビルドまで網羅。',
      'lp.more.usage.title': '使い方ガイド',
      'lp.more.usage.desc': 'ホスト／ゲストの手順、 タスクトレイ常駐の使い方。',
      'lp.more.public.title': 'インターネット公開',
      'lp.more.public.desc': 'UPnP 自動公開／Cloudflare トンネルでの https 公開。',
      'lp.more.github.title': 'GitHub リポジトリ',
      'lp.more.github.desc': 'ソースコード・Issue・最新の開発状況。',
      'lp.more.stats.title': '運用統計',
      'lp.more.stats.desc': 'リアルタイム接続数と24時間サマリ（匿名集計・自動更新）。',
      'lp.bg.title': '開発の背景',
      'lp.bg.lead': 'PAssist は、 NPO「ぱっぷす」の支援活動の中から生まれたツールです。',
      'lp.bg.p1': '特定非営利活動法人ぱっぷす（PAPS）は、 性的な画像や動画の拡散、 セクストーション（性的脅迫）、 リベンジポルノなどのデジタル性暴力被害を受けた方々への相談支援を行うNPO法人です（<a href="https://paps.jp" target="_blank" rel="noopener">https://paps.jp</a>）。',
      'lp.bg.p2': 'ぱっぷすの支援活動では、 相談者への遠隔サポートや、 スタッフ同士の技術支援、 セキュリティの確保のために、 画面共有やリモート操作が必要になる場面があります。 しかし、 市販のツールでは、 支援現場で求められる要件やセキュリティ上の要請に十分対応できないことも多く、 ぱっぷすでは必要な機能を備えたツールを独自に開発してきました。',
      'lp.bg.p3': 'また、 ぱっぷすは、 ライブチャットやSNS、 動画配信サービスなどのオンラインプラットフォーム上で発生するデジタル性暴力の相談支援を数多く行っており、 インターネット上での情報流通やネットワーク技術、 オンラインサービスの仕組みに関する知見を蓄積してきました。 こうした支援現場で培われた経験と技術的知見も、 PAssistの開発に活かされています。',
      'lp.bg.p4': 'PAssistは、 そのような支援活動の中から生まれたツールの一つです。 Windows上の特定のウィンドウを共有し、 遠隔から閲覧・操作できるようにすることで、 相談支援やチーム内での協働を円滑に行うことを目的としています。',
      'lp.bg.p5': 'また、 ぱっぷすではオープンソースの理念を重視しています。 支援活動のために開発したツールのうち、 他の団体や個人、 さまざまな業務・教育・支援の現場でも活用できるものについては、 今後も積極的に公開していきたいと考えています。',
      'lp.bg.p6': 'PAssistが、 さまざまな支援活動や日々の業務を支えるツールとして活用されることを願っています。',
      'lp.bg.papsLink': '特定非営利活動法人ぱっぷす（PAPS）— paps.jp →',
      'lp.footer': 'PAssist — 単一ウィンドウ・ブラウザ完結・アカウント不要のリモート操作',

      // === ビューア (server/public/viewer.html + viewer.js) ===
      'viewer.docTitle': 'PAssist — リモート操作',
      'viewer.status.prepare': '接続を準備しています…',
      'viewer.status.reconnect': '接続が切れました。 再接続を試みています…（{n}/{max}）',
      'viewer.status.reconnectFail': '接続が切断されました。 ページを再読み込みして接続し直してください。',
      'viewer.status.connecting': '接続中… 映像を待っています',
      'viewer.status.unstable': '接続が不安定です ({state})',
      'viewer.status.expired': '有効期限が切れました',
      'viewer.pin.label': 'PIN を入力してください',
      'viewer.pin.btn': '接続',
      'viewer.gate': 'タップ／クリックして操作を開始',
      'viewer.toolbar.modeScroll': 'スクロール',
      'viewer.toolbar.modeMouse': 'マウス',
      'viewer.toolbar.modePan': '画面移動',
      'viewer.toolbar.kb': '⌨ キー',
      'viewer.toolbar.fs': '全画面',
      'viewer.toolbar.aboutTitle': 'バージョン情報・接続の安全性',
      'viewer.badge.active': '● 操作中',
      'viewer.badge.viewOnly': '● 閲覧のみ',
      'viewer.keybar.text': 'Aa 文字入力',
      'viewer.keybar.close': '✕ 閉じる',
      'viewer.ctx.copy': 'コピー',
      'viewer.ctx.cut': '切り取り',
      'viewer.ctx.paste': '貼り付け',
      'viewer.ctx.text': 'テキスト入力…',
      'viewer.textDialog.label': 'テキスト入力（日本語可・Enter で挿入 / Shift+Enter で改行）',
      'viewer.textDialog.cancel': '閉じる',
      'viewer.textDialog.insert': '挿入',
      'viewer.textInputPh.loading': '現在の値を取得しています…',
      'viewer.textInputPh.failed': '取得に失敗しました。 新規入力 → 挿入で上書きされます。',
      'viewer.textInputPh.file': 'ホストのクリップボードにファイル等があるため現在値を取得しませんでした。 新規入力で上書きされます。',
      'viewer.textInputPh.skipped': '現在値の取得をスキップしました（{reason}）。 新規入力で上書きされます。',
      'viewer.about.title': 'PAssist について',
      'viewer.about.viewerLabel': 'PAssist ブラウザビューア',
      'viewer.about.desc': 'アカウント不要のリモート操作ツール。 映像と操作は<strong>あなたのブラウザとホストPCで直接</strong>暗号化通信されます。',
      'viewer.about.verifyHeading': '🔐 サーバの真正性（Sigstore Rekor で検証）',
      'viewer.about.verifyLoading': '確認中…',
      'viewer.about.cryptoHeading': '🔒 接続の暗号化（WebRTC）',
      'viewer.about.cryptoBefore': '接続後に表示されます。',
      'viewer.about.licenseHeading': '📜 ライセンス',
      'viewer.about.license': 'MIT License',
      'viewer.about.copyright': '© 2026 特定非営利活動法人ぱっぷす (PAPS)',
      'viewer.about.linkHome': 'ホームページ',
      'viewer.about.linkGithub': 'GitHub',
      'viewer.about.linkVerify': '安全性の検証について',
      'viewer.about.closeAria': '閉じる',
      'viewer.populateLoadingVerify': 'Sigstore Rekor に問い合わせ中…',
      'viewer.populateLoadingCrypto': '接続状態を取得中…',
      'viewer.renderVerifyFail': '✗ ブラウザ検証失敗',
      'viewer.renderMerkleProof': 'Merkle proof',
      'viewer.renderDigestMatch': 'digest 一致',
      'viewer.renderIdentityMatch': 'identity 一致',
      'viewer.renderBundleFail': '⚠ 検証準備に失敗',
      'viewer.renderNotReleased': 'ℹ このサーバはまだ署名版をリリースしていません',
      'viewer.renderDevServer': '開発中・テスト中のサーバの可能性があります。 本番運用には署名版 (v0.2.x 以降のリリース) の使用を推奨します。',
      'viewer.renderSeeGithub': 'GitHub で公開コードを見る →',
      'viewer.renderFetchFail': '⚠ サーバ情報の取得に失敗しました',
      'viewer.renderUnknownError': '不明なエラー',
      'viewer.renderNotConnected': '接続が確立していません。 映像表示後にもう一度開いてください。',
      'viewer.renderSend': '送信',
      'viewer.renderRecv': '受信',
      'viewer.unsetValue': '(未公開)',

      // === 既存: 検証 / about / 暗号化 ===
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
      'about.lead': 'ブラウザだけで、 選んだ1ウィンドウを共有・遠隔操作。 映像と操作は WebRTC（DTLS-SRTP / AES-128-GCM）で暗号化されます。',
      'about.tech': '技術情報',
      'about.license': '著作権・ライセンス',
      'about.licenseDesc': '使う・改変・再配布・商用利用すべて自由です。 再配布の際は著作権表示と MIT ライセンス全文を含めてください。',
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
      'lang.ja': '日本語',
      'lang.en': 'English',

      // === LP: docs/index.html ===
      'lp.docTitle': 'PAssist — Share & remote-control one window, browser-only',
      'lp.h1': 'PAssist — share and remote-control a single window from a browser',
      'lp.logoAlt': 'PAssist logo',
      'lp.tagline': 'Share & remote-control one window — straight from a browser.',
      'lp.sub': 'No account required. Your guest just <strong>scans a QR code</strong> (or opens a URL) to start operating right away. The full desktop is never visible.',
      'lp.cta.download': 'Download for Windows',
      'lp.cta.docs': 'Documentation',
      'lp.cta.github': 'GitHub',
      'lp.meta': 'Free & open source · <b>Windows 10 / 11 (64-bit)</b> · Portable, no install',
      'lp.about.title': 'About PAssist',
      'lp.about.lead': 'PAssist is a remote-control tool for Windows. You share <strong>only one window of your choice</strong>. Your guest <strong>just opens a browser</strong> — no install, no account — and video and input flow through end-to-end encrypted WebRTC.',
      'lp.feat1.title': 'Single-window sharing',
      'lp.feat1.desc': 'Only the window you pick. The desktop and other windows are structurally invisible.',
      'lp.feat2.title': 'Guest needs only a browser',
      'lp.feat2.desc': 'No install, no account. Your guest opens the URL and starts operating.',
      'lp.feat3.title': 'Cryptographic verification →',
      'lp.feat3.desc': 'Video flows end-to-end via WebRTC (DTLS-SRTP). Reproducible Build + Cosign signing lets you mathematically verify that the server matches the public source.',
      'lp.feat4.title': 'Host approval',
      'lp.feat4.desc': 'Nothing is shown until you approve. Trusted devices can auto-reconnect next time.',
      'lp.feat5.title': 'Escape keys blocked',
      'lp.feat5.desc': 'Win / Alt+Tab / Alt+F4 are blocked. Input stays inside the shared window.',
      'lp.feat6.title': 'Time-limited sessions',
      'lp.feat6.desc': 'Sessions expire (30 minutes by default). You can also set them to no expiry.',
      'lp.how.title': 'Three steps to share',
      'lp.how.lead': "That is all the host has to do. The screenshots below are the actual app (demo view — no real IPs or URLs).",
      'lp.step1.alt': 'Pick one window to share',
      'lp.step1.title': 'Pick a window',
      'lp.step1.desc': 'Launch PAssist and click the window you want to share.',
      'lp.step2.alt': 'Send the link or QR code',
      'lp.step2.title': 'Send the link / QR',
      'lp.step2.desc': 'Send the auto-generated URL (QR code also available) to your guest.',
      'lp.step3.alt': 'Once approved, the guest can operate from a browser',
      'lp.step3.title': 'Approve to start',
      'lp.step3.desc': 'Approve the connection request — your guest can then operate the window from their browser.',
      'lp.guestNote': 'The guest just <strong>opens the URL in a browser</strong>. No install or login required.',
      'lp.dl.title': 'Download',
      'lp.dl.lead': 'Grab the latest portable executable below.',
      'lp.dl.btn': 'Download PAssist.exe',
      'lp.dl.latest': 'Latest <b>v0.1.0</b>',
      'lp.dl.os': '<b>Windows 10 / 11</b> (64-bit)',
      'lp.dl.size': 'Approx <b>91 MB</b>',
      'lp.dl.portable': 'Portable, no install required',
      'lp.dl.warn': '⚠ This exe is <strong>not yet code-signed</strong>, so Windows SmartScreen may show a "Windows protected your PC" warning the first time you run it. Choose <strong>"More info" → "Run anyway"</strong> to proceed.',
      'lp.dl.allReleases': 'All releases',
      'lp.dl.source': 'Source code (GitHub)',
      'lp.more.title': 'Learn more',
      'lp.more.lead': 'Architecture, security, internet exposure, configuration.',
      'lp.more.docs.title': 'Documentation',
      'lp.more.docs.desc': 'Overview, architecture, security, environment variables, building.',
      'lp.more.usage.title': 'Usage guide',
      'lp.more.usage.desc': 'Host and guest steps, system-tray usage.',
      'lp.more.public.title': 'Internet exposure',
      'lp.more.public.desc': 'UPnP auto-exposure / HTTPS via Cloudflare Tunnel.',
      'lp.more.github.title': 'GitHub repository',
      'lp.more.github.desc': 'Source code, issues, current development.',
      'lp.more.stats.title': 'Live stats',
      'lp.more.stats.desc': 'Realtime connection count and 24-hour summary (anonymous aggregate, auto-refresh).',
      'lp.bg.title': 'Background',
      'lp.bg.lead': 'PAssist was built out of the support work of the non-profit PAPS.',
      'lp.bg.p1': 'PAPS (Specified Non-profit Organization PAPS) is a Japanese non-profit that supports victims of digital sexual violence — non-consensual distribution of sexual images and videos, sextortion, and revenge porn (<a href="https://paps.jp" target="_blank" rel="noopener">https://paps.jp</a>).',
      'lp.bg.p2': 'Our support work often requires screen sharing or remote operation — to assist clients remotely, help staff with technical issues, and maintain security. Off-the-shelf tools rarely meet the requirements of front-line support work or the security demands of handling sensitive cases, so PAPS has built its own tools to fill those gaps.',
      'lp.bg.p3': 'We also handle many cases of digital sexual violence on live-chat, social, and video platforms, and have accumulated practical know-how about information flow online, network technology, and the inner workings of online services. That field-tested experience informs how PAssist was designed.',
      'lp.bg.p4': 'PAssist is one of the tools born from that work. By sharing a single Windows window and allowing remote viewing and control, it aims to make consultation support and team collaboration smoother.',
      'lp.bg.p5': 'PAPS values the open-source ethos. When tools we build for our own support work look useful to other organizations, individuals, or daily operations / education / advocacy work, we plan to keep releasing them publicly.',
      'lp.bg.p6': 'We hope PAssist can be a useful tool that supports a wide range of advocacy work and everyday operations.',
      'lp.bg.papsLink': 'Specified Non-profit Organization PAPS — paps.jp →',
      'lp.footer': 'PAssist — single-window, browser-based, account-free remote control',

      // === Viewer (server/public/viewer.html + viewer.js) ===
      'viewer.docTitle': 'PAssist — Remote control',
      'viewer.status.prepare': 'Preparing the connection…',
      'viewer.status.reconnect': 'Disconnected. Reconnecting… ({n}/{max})',
      'viewer.status.reconnectFail': 'Disconnected. Please reload the page to reconnect.',
      'viewer.status.connecting': 'Connecting… waiting for video',
      'viewer.status.unstable': 'Connection is unstable ({state})',
      'viewer.status.expired': 'Session expired',
      'viewer.pin.label': 'Enter the PIN',
      'viewer.pin.btn': 'Connect',
      'viewer.gate': 'Tap / click to start operating',
      'viewer.toolbar.modeScroll': 'Scroll',
      'viewer.toolbar.modeMouse': 'Mouse',
      'viewer.toolbar.modePan': 'Pan',
      'viewer.toolbar.kb': '⌨ Keys',
      'viewer.toolbar.fs': 'Full-screen',
      'viewer.toolbar.aboutTitle': 'About / connection security',
      'viewer.badge.active': '● Operating',
      'viewer.badge.viewOnly': '● View only',
      'viewer.keybar.text': 'Aa Text input',
      'viewer.keybar.close': '✕ Close',
      'viewer.ctx.copy': 'Copy',
      'viewer.ctx.cut': 'Cut',
      'viewer.ctx.paste': 'Paste',
      'viewer.ctx.text': 'Text input…',
      'viewer.textDialog.label': 'Text input (multilingual OK · Enter to insert / Shift+Enter for newline)',
      'viewer.textDialog.cancel': 'Close',
      'viewer.textDialog.insert': 'Insert',
      'viewer.textInputPh.loading': 'Fetching the current value…',
      'viewer.textInputPh.failed': 'Fetch failed. New input → Insert will overwrite.',
      'viewer.textInputPh.file': 'Host clipboard contains a file/etc., so the current value was not fetched. New input will overwrite.',
      'viewer.textInputPh.skipped': 'Current value fetch was skipped ({reason}). New input will overwrite.',
      'viewer.about.title': 'About PAssist',
      'viewer.about.viewerLabel': 'PAssist browser viewer',
      'viewer.about.desc': 'A remote-control tool that needs no account. Video and input are encrypted <strong>directly between your browser and the host PC</strong>.',
      'viewer.about.verifyHeading': '🔐 Server integrity (verified via Sigstore Rekor)',
      'viewer.about.verifyLoading': 'Verifying…',
      'viewer.about.cryptoHeading': '🔒 Connection encryption (WebRTC)',
      'viewer.about.cryptoBefore': 'Shown after the connection is established.',
      'viewer.about.licenseHeading': '📜 License',
      'viewer.about.license': 'MIT License',
      'viewer.about.copyright': '© 2026 Specified Non-profit Organization PAPS',
      'viewer.about.linkHome': 'Homepage',
      'viewer.about.linkGithub': 'GitHub',
      'viewer.about.linkVerify': 'About the verification',
      'viewer.about.closeAria': 'Close',
      'viewer.populateLoadingVerify': 'Querying Sigstore Rekor…',
      'viewer.populateLoadingCrypto': 'Fetching connection state…',
      'viewer.renderVerifyFail': '✗ Browser verification failed',
      'viewer.renderMerkleProof': 'Merkle proof',
      'viewer.renderDigestMatch': 'digest match',
      'viewer.renderIdentityMatch': 'identity match',
      'viewer.renderBundleFail': '⚠ Verification setup failed',
      'viewer.renderNotReleased': 'ℹ This server has not released a signed version yet',
      'viewer.renderDevServer': 'This may be a development or test server. For production use, the signed release (v0.2.x or later) is recommended.',
      'viewer.renderSeeGithub': 'See the public source on GitHub →',
      'viewer.renderFetchFail': '⚠ Failed to fetch server info',
      'viewer.renderUnknownError': 'unknown error',
      'viewer.renderNotConnected': 'Not connected yet. Reopen after the video appears.',
      'viewer.renderSend': 'Sent',
      'viewer.renderRecv': 'Recv',
      'viewer.unsetValue': '(not published)',

      // === Existing: verify / about / crypto ===
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
      'about.licenseDesc': 'Free to use, modify, redistribute, and use commercially. Just keep the copyright notice and MIT license text when redistributing.',
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
    return d[key] !== undefined ? d[key] : (M.en[key] !== undefined ? M.en[key] : key);
  }

  function applyI18n(root) {
    const r = root || document;
    if (r === document && document.documentElement && document.documentElement.dataset && document.documentElement.dataset.i18nTitle) {
      const v = t(document.documentElement.dataset.i18nTitle);
      if (v) document.title = v;
    }
    for (const el of r.querySelectorAll('[data-i18n]')) {
      const k = el.dataset.i18n;
      const v = t(k);
      if (v && v !== k) el.textContent = v;
    }
    for (const el of r.querySelectorAll('[data-i18n-html]')) {
      const k = el.dataset.i18nHtml;
      const v = t(k);
      if (v && v !== k) el.innerHTML = v;
    }
    for (const el of r.querySelectorAll('[data-i18n-attr]')) {
      const pairs = el.dataset.i18nAttr.split(';');
      for (const pair of pairs) {
        const idx = pair.indexOf(':');
        if (idx < 0) continue;
        const attr = pair.slice(0, idx).trim();
        const k = pair.slice(idx + 1).trim();
        const v = t(k);
        if (v && v !== k) el.setAttribute(attr, v);
      }
    }
  }

  function setLang(newLang) {
    if (newLang !== 'ja' && newLang !== 'en') return;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('passist-lang', newLang); } catch {}
    if (typeof location !== 'undefined' && location.reload) location.reload();
  }

  function getLang() { return lang; }

  if (typeof window !== 'undefined') {
    window.t = t;
    window.applyI18n = applyI18n;
    window.setLang = setLang;
    window.getLang = getLang;
    window.__passistLang = lang;
    if (typeof document !== 'undefined') {
      if (document.documentElement) document.documentElement.lang = lang;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => applyI18n());
      } else {
        applyI18n();
      }
    }
  }
})();
