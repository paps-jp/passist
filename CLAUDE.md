# CLAUDE.md

PAssist — アカウント不要で、単一ウィンドウをブラウザから共有・遠隔操作するツール。
(host: Electron アプリ / server: シグナリングサーバ)

## 構成

- `host/` — Electron アプリ（Windows）。`PAssist.exe` を配布。
- `server/` — シグナリングサーバ（Node.js + ws + express）。Docker image を GHCR で配布。
- `docs/` — GitHub Pages（`paps-jp.github.io/passist/`）。LP・ドキュメント・統計・検証手順。
- `deploy/` — `docker-compose.yml`（Caddy + signaling + coturn）と VPS bootstrap。

## Git のルール

- **コミットに Claude / Anthropic を共同作成者として含めない。**
  - `Co-Authored-By: Claude ...` などのトレーラーを付けないこと。
  - PR 本文に「🤖 Generated with Claude Code」等の Claude 由来の署名を入れないこと。
  - author / committer も実ユーザーのみとし、Claude を contributor として記載しない。
- コミットメッセージは作業内容のみを簡潔に記述する。

## i18n（多言語化）

ユーザー向け表示文言は `ja` / `en` の 2 言語で提供する。複数セッションで並行作業しても整合性が崩れないよう、運用ルールを明文化しておく。

### 辞書ファイル

| ファイル | 対象 |
|---|---|
| `host/renderer/i18n.js` | ホスト Electron アプリの全画面（about, picker, session, settings 等） |
| `server/public/i18n.js`（または同等） | viewer（ブラウザ側） |
| `docs/i18n.js` | GitHub Pages（LP, stats, docs, verification, privacy） |

各辞書は **`ja: { ... }` と `en: { ... }` を両方持つ**構造。

### 文言追加・変更のルール

1. **新規キー追加時は ja / en 両方に同時追加する**。片方だけだとフォールバックでキーがそのまま表示され、不格好になる。
2. HTML には `data-i18n="key"`（textContent 置換）、`data-i18n-html="key"`（innerHTML 置換）、`data-i18n-attr="attrName:key"`（属性置換）で参照する。動的に組み立てる文言は `tr('key', { var: value })` を使い、テンプレ `{var}` を変数で置換する。
3. **CSP の制約**でインライン `onclick` は使えない。`addEventListener` で接続すること（言語切替ボタン等）。
4. **動的文言（`tr()` 呼び出し）を追加した時は、必ず ja / en 両方の辞書にキーを追加した上でコミットする**。CI で構文チェックは通っても i18n キー不足は実行時にしか分からない。

### 翻訳の方針

- 英語は**簡潔・明瞭**に。1〜2 文で完結させる。
- 絵文字（⚙ / ✓ / ⚠ / 📷 等）は ja / en で同じものを使う（ブランド統一）。
- パスやコード（`turn:turn.example.com:3478` 等）は両言語で同じ。

## バージョンと配布

- 配布バージョンは `host/package.json` の `version` を Single Source of Truth とする。
- Electron の `app.getVersion()` がこの値を返し、About モーダルに表示される。
- **リリース手順**:
  1. `host/package.json` の `version` を上げる（例: 0.2.7.4 → 0.2.7.5）。
  2. `host/renderer/i18n.js` の `lp.dl.latest`（ja / en）の表記も同時に更新する。
  3. ビルドして検証 → `git tag vX.Y.Z` → `git push origin vX.Y.Z` で署名ワークフロー起動。
  4. `gh release upload` で Windows 配布物を差し替え。
- リリースタグ・配布物・`package.json` の **3 つを必ず一致**させる（過去に乖離して about 画面が古い版を表示していた事例あり）。

## 依存バージョン管理

- **lock ファイル必須**: `server/package-lock.json` と `host/package-lock.json` を必ずコミット。
- インストールは **`npm ci`**（lock 厳守）。`npm install` で依存を増減した時のみ lock 更新。
- **完全ピン**（具体的バージョン）:
  - `electron`, `electron-builder` — メジャー更新で API 破壊が定期的に起きるため。
  - `@nut-tree-fork/nut-js` — Win32 オートメーション。互換性は手動確認。
- **`^`（patch/minor 自動）**: 上記以外（koffi, qrcode, sharp, express, ws 等）。
- **`.github/dependabot.yml`** が月次で update PR を作成。`electron` 系のメジャーは ignore。
- 配布 exe で実際に使われているバージョンを `host/package.json` に反映する（リリース時の検証根拠）。

## テスト

- 軽量CI（`.github/workflows/test.yml`）が push/PR で:
  1. `node --check` で全 `.js` の構文チェック（host/server/viewer）。
  2. `cd server && node --test test-util.js test-stats.js test-audit.js`（ピュア関数の単体テスト）。
  3. `cd server && node test-signaling.js`（in-process でシグナリングを検証）。
  4. `npm audit --omit=dev`（脆弱性アドバイザリ）。
- 新機能には可能ならピュア関数の単体テストを追加（標準 `node --test`、追加依存ゼロ）。
- WebRTC メディア・Win32 API・キャプチャは実機検証マトリクスで確認（自動化困難）。

## ログ運用（中央サーバ）

匿名集計（公開）と監査ログ（非公開）の **2 系統** を分けて運用する。プライバシーポリシーは `docs/privacy.html`、利用者が確認できる場所はビューア「PAssist について」モーダル → 「プライバシーポリシー」。

### `server/stats.js` — 匿名集計（公開）

- 個人を特定する情報（IP / token / UA / 拒否相手）は**一切記録しない**。
- 出力: `data/stats.json`、API: `GET https://passist.paps.jp/api/stats`（CORS `*`）、ダッシュボード: `https://paps-jp.github.io/passist/stats.html`。
- 保持: 直近 24h ローリング + 日次サマリ 30 日。

### `server/audit.js` — 監査ログ（非公開）

- 発信者情報開示請求（プロバイダ責任制限法）と不正利用調査のため、**接続元 IP / User-Agent / イベント種別 / セッショントークン** を記録する。
- 出力: `data/audit/YYYY-MM-DD.jsonl`（JSON Lines、append-only、UTC 日付）。
- 公開しない（HTTP API も無し）。VPS ファイルシステム権限のみで保護。
- 保持: 既定 **365 日**。環境変数 `PASSIST_AUDIT_RETENTION_DAYS` で変更可。期限切れは毎日自動削除。
- 保存場所の上書き（テスト用）: `PASSIST_AUDIT_DIR`。
- 記録しないもの: WebRTC メディア・DataChannel・入力イベント・クリップボード（そもそも P2P でサーバを通らない）。

### IP 取得方針

- Caddy リバースプロキシ越しを想定し、`X-Forwarded-For` ヘッダの**最左**を採用、無ければ `socket.remoteAddress`。
- IPv4-mapped IPv6 (`::ffff:192.0.2.1`) は IPv4 に正規化。
- 偽装対策: Caddy 以外を経由する経路を作らないこと（`deploy/docker-compose.yml` で signaling は Caddy 配下のみ公開）。

### 開示請求対応

- 受付窓口は `docs/privacy.html` 記載の PAPS お問い合わせ先。
- 開示判断は運営者（PAPS）が法令と本ポリシーに基づき行う。
- 開示にあたっては、最小限の情報（請求対象のセッション token に該当する IP / タイムスタンプのみ）を提供することを基本とする。
- 提供前にログをアーカイブして証跡を残す（手動）。

## リリース

### signaling サーバ（自動・署名済み）

`v*` タグを push すると `.github/workflows/release-signaling.yml` が起動し:

1. Reproducible Build（`SOURCE_DATE_EPOCH = git commit時刻`）で Docker image を構築。
2. **GHCR** (`ghcr.io/paps-jp/passist-signaling:<tag>`) に push。
3. **SLSA provenance + SBOM** を attestation として image に添付（mode=max）。
4. **Cosign keyless 署名**（GitHub OIDC → Sigstore Fulcio で短期証明書発行 → Rekor の透明性ログに公開記録）。秘密鍵は運営者が保持しない＝鍵漏洩リスクなし。

リリース手順:
```bash
git tag vX.Y.Z
git push origin vX.Y.Z
# あとは workflow が全部やる。Actions の Summary に検証コマンドが出力される。
```

### host (PAssist.exe)（半手動）

現状は手動ビルド＋GitHub Releases へアップロード:

```bash
# 1) 事前確認: PAssist プロセスが起動中だと dist/PAssist.exe がロックされてビルド失敗する
powershell -NoProfile -Command "Get-Process -Name PAssist -ErrorAction SilentlyContinue | Stop-Process"

# 2) ビルド（electron-builder portable）
cd host && npm run dist
# → dist/PAssist.exe が生成される

# 3) 検証: asar 内の renderer.js / settings.js / viewer.html がコミット内容と一致しているか確認
node -e "const a=require('./host/node_modules/@electron/asar'); console.log(a.extractFile('dist/win-unpacked/resources/app.asar','main.js').toString().includes('computeSignalWs'))"

# 4) 既存リリース(v0.1.0等)に差し替えアップロード
gh release upload v0.1.0 dist/PAssist.exe --clobber

# 5) sha256 を release notes に記録
sha256sum dist/PAssist.exe
gh release view v0.1.0 --json assets --jq '.assets[] | {name,size,digest,updatedAt}'
```

## 検証（誰でも実行可能）

### signaling コンテナの真正性

`paps-jp/passist-signaling` image がこのリポジトリの該当タグから作られたことを Sigstore で検証:

```bash
cosign verify ghcr.io/paps-jp/passist-signaling:vX.Y.Z \
  --certificate-identity-regexp 'https://github.com/paps-jp/passist' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

### ビューア（ブラウザ）からの検証

`viewer.html` の「ℹ︎」→「PAssist について」モーダルが Rekor を非同期で照会して、現在繋がっている signaling コンテナの署名と GitHub のソースコードの一致を表示する（`docs/verification.html` に詳細）。

### ホスト exe（暫定）

現状は GitHub Releases の sha256 と GitHub Actions ビルド成果物の一致でしか検証できない。将来的に:

- exe の `SHA256SUMS` を `cosign sign-blob`（keyless）で署名し release に添付する自動化を入れる（TODO）。
- EV Code Signing 証明書による Authenticode 署名は導入コスト高（SmartScreen 即時通過のため将来検討）。

## サーバ運用（passist.paps.jp）

- VPS で `deploy/docker-compose.yml` を起動: Caddy が自動 TLS、signaling は GHCR から pull、coturn は同居。
- `.env` に `DOMAIN=passist.paps.jp` と `ICE_TURN_*`（TURN 認証）を設定。
- VPS 構成スクリプト: `deploy/bootstrap.sh`（UFW・Docker 導入・`.env` 雛形生成）。
- アップデート: `docker compose pull && docker compose up -d`。

## ブラウザ向けトップ・統計

- ユーザー向けトップは GitHub Pages `https://paps-jp.github.io/passist/`。
- 統計ダッシュボードも GitHub Pages の `stats.html` で公開。`fetch('https://passist.paps.jp/api/stats')` で取得（CORS `*`）。
- `passist.paps.jp/` および `/stats` はサーバ側で **301 で GitHub Pages にリダイレクト**。viewer (`/s/:token`) と API (`/api/stats`) のみサーバが提供。
