# CLAUDE.md

PAssist — アカウント不要で、単一ウィンドウをブラウザから共有・遠隔操作するツール。
(host: Electron アプリ / server: シグナリングサーバ)

## 構成

- `host/` — Electron アプリ（Windows）。`PAssist.exe` を配布。
- `server/` — シグナリングサーバ（Node.js + ws + express）。Docker image を GHCR で配布。
- `docs/` — GitHub Pages（`paps-jp.github.io/passist/`）。LP・ドキュメント・統計・検証手順。
- `deploy/` — `docker-compose.yml`（Caddy + signaling + coturn）と VPS bootstrap。

## 検討中の設計

- `docs/mcp.md` — Claude (MCP クライアント) から PAssist を操作する仕組みの設計案。 Local HTTP API + `passist-mcp` (npm) で「画面 X を相手に共有して」 を自然言語化する。 未着手・要レビュー。

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
- **`host/package.json` の `version` は必ず semver にする**。 electron-builder は 4 桁版 (`0.2.7.5`) を `Invalid version` で reject する。 4 桁的な細かい刻みが必要なら **pre-release 形式** で表現する（例: `0.2.7-5`）。 タグや LP の表示は `v0.2.7.5` のままで構わない（CI / `lp.dl.latest` 側で 4 桁表記を使い、 package.json だけ semver）。
- リリースタグ・配布物・`package.json` の **3 つを必ず一致**させる（過去に乖離して about 画面が古い版を表示していた事例あり）。

### `i18n.js` の 3 同期先

`i18n.js` は次の **3 ファイルがバイト単位で同一**でなければならない（差分は CI で検知されないが、 page によって表示文言が食い違うのを防ぐため）。

- `docs/i18n.js` — GitHub Pages 配信 (LP / docs / verification / stats)
- `host/renderer/i18n.js` — Electron host UI (PAssist.exe 同梱)
- `server/public/i18n.js` — viewer (signaling サーバ配信)

編集は `docs/i18n.js` を正本として行い、 必ず以下で 2 か所にコピー:

```bash
cp docs/i18n.js host/renderer/i18n.js && cp docs/i18n.js server/public/i18n.js
```

### リリース手順

1. **3 つのバージョン番号を同時に揃える** (必ずセット):
   - `host/package.json` の `"version"` (例: `"0.2.7-5"` → `"0.2.7-6"`)
   - `server/package.json` の `"version"` (同じ semver、 例: `"0.2.7-6"`)
   - `docs/i18n.js` の `lp.dl.latest` (ja / en 両方、 タグ表示形式: 例 `<b>v0.2.7.6</b>`)
2. `i18n.js` を 3 同期先にコピー (前項参照)。
3. コミット → タグ → push:
   ```bash
   git add host/package.json server/package.json docs/i18n.js host/renderer/i18n.js server/public/i18n.js
   git commit -m "chore: バージョンを v0.2.7.6 に bump"
   git tag v0.2.7.6
   git push origin main && git push origin v0.2.7.6
   ```
4. **v* タグ push により以下 3 ワークフローが並行起動** (3 つとも独立、 互いに gate しない):

   | ワークフロー | 成果物 | 平均所要 |
   |---|---|---|
   | `build-host` | `PAssist.exe`, `SHA256SUMS.txt` → Release に添付 | 約 3 分 |
   | `build-host-mac` | `PAssist-X.Y.Z-mac-arm64.zip`, `SHA256SUMS-mac.txt` → Release に添付 | 約 2 分 |
   | `release-signaling` | `ghcr.io/paps-jp/passist-signaling:vX.Y.Z` + Cosign 署名 + Rekor 記録 + bundle 添付 | 約 1 分 |

5. **完了確認**:
   ```bash
   gh run watch <run-id>                                  # 個別に監視
   gh run list --limit 5                                  # 一覧
   gh release view vX.Y.Z --json assets --jq '.assets[].name'  # 添付確認
   curl -sI -L https://github.com/paps-jp/passist/releases/latest/download/PAssist.exe \
     | grep -E "HTTP/|Location:"                          # DL URL 200 OK 確認
   ```
6. **VPS の signaling コンテナを反映**:
   ```bash
   ssh www@<vps-ip> 'cd /www/passist && docker compose pull && docker compose up -d'
   ```
   これで `passist.paps.jp/s/<token>` の viewer に新しいサーバが反映される。

### ダウンロード URL の方針

- LP / docs から exe をダウンロードさせる URL は **`https://github.com/paps-jp/passist/releases/latest/download/PAssist.exe`** に固定する。
- これは GitHub が「最新の非 pre-release タグ」 にリダイレクトする仕組みで、 タグ追加のたびに HTML を書き換える必要がない。
- ただし **「最新タグの Release に PAssist.exe が無い」** ケース（build-host CI 失敗、 タグ追加直後でビルドがまだ走っていない、 etc.）では、 上記 URL は 404 になる。

### build-host CI が失敗したときの復旧

1. **すぐに該当 Release を pre-release に降格**:
   ```bash
   gh release edit vX.Y.Z --prerelease
   ```
   こうすると GitHub の「Latest」 判定が **1 つ前の安定リリース**に戻り、 `releases/latest/download/PAssist.exe` も自動でそちらを指すようになる（公開ページの DL リンクが復活する）。
2. CI 失敗の原因を直して再タグ（例: `host/package.json` を semver に修正 → 新タグ `vX.Y.Z+1` を push）。
3. 新タグの `build-host` が成功し PAssist.exe が添付されたら、 `gh release edit vX.Y.Z+1 --latest` を明示しなくても自動的に「Latest」 に戻る（pre-release でなければ）。

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

## リリース（各ワークフローの中身）

実際のリリース実行手順は「### リリース手順」 (上方) を参照。 ここでは v* タグ push で並行起動する 3 ワークフローが**何をしているか**を記す。

### `.github/workflows/release-signaling.yml`

1. Reproducible Build（`SOURCE_DATE_EPOCH = git commit時刻`）で Docker image を構築。
2. **GHCR** (`ghcr.io/paps-jp/passist-signaling:<tag>`) に push。
3. **SLSA provenance + SBOM** を attestation として image に添付（mode=max）。
4. **Cosign keyless 署名**（GitHub OIDC → Sigstore Fulcio で短期証明書発行 → Rekor の透明性ログに公開記録）。 秘密鍵は運営者が保持しない＝鍵漏洩リスクなし。
5. Rekor entry / 署名 / 検証用 bundle を GitHub Release に添付（ブラウザ自前検証用）。

### `.github/workflows/build-host.yml`

Windows ランナーで `electron-builder portable` を実行し `PAssist.exe` (~91 MB) を作成、 `SHA256SUMS.txt` 付きで Release に添付。 `host/package.json` の `version` が semver でないとここで fail する (前述)。

将来的に **SignPath Foundation** によるコード署名連携を追加予定 (申請承認後)。 SmartScreen 警告を即時通過する。 ワークフロー末尾にコメントアウト済みのテンプレあり。

### `.github/workflows/build-host-mac.yml`

macOS ランナーで Mac arm64 zip を作成、 `SHA256SUMS-mac.txt` 付きで Release に添付。 公証/Gatekeeper 署名は未実装 (実機検証向け)。

### 緊急ローカルビルド (CI が落ちた等)

CI が機能しない場合の手動フォールバック (通常は不要):

```bash
powershell -NoProfile -Command "Get-Process -Name PAssist -ErrorAction SilentlyContinue | Stop-Process"
cd host && npm ci && npm run rebuild && npm run dist     # → dist/PAssist.exe
gh release upload vX.Y.Z dist/PAssist.exe --clobber
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

### server.js の重要な動作

- **WebSocket heartbeat**: 30 秒ごとに ping を送り、 pong が返らない接続は terminate する (`WS_HEARTBEAT_MS` で上書き可)。 ブラウザ閉じ・モバイル画面ロック等で TCP RST が来ないケースで viewer slot が永久占有されるのを防ぐ。 terminate により `ws.on('close')` 経由で `onClose()` が呼ばれ、 `s.viewers` / `s.pending` から viewerId が外れ `maxViewers` 枠が解放される。
- **maxViewers**: 既定 1, セッション作成時に host から指定可能 (1〜4)。 操作可は常に 1 人 (最初に accepted された viewer)、 他は閲覧のみ。
- **セッション復元**: host が切断しても session は即削除せず、 同じ token + hostSecret で戻れば既存セッションを引き継ぐ。 完全削除は `expiresAt` 期限切れか明示的な `host:end` のみ。

## ブラウザ向けトップ・統計

- ユーザー向けトップは GitHub Pages `https://paps-jp.github.io/passist/`。
- 統計ダッシュボードも GitHub Pages の `stats.html` で公開。`fetch('https://passist.paps.jp/api/stats')` で取得（CORS `*`）。
- `passist.paps.jp/` および `/stats` はサーバ側で **301 で GitHub Pages にリダイレクト**。viewer (`/s/:token`) と API (`/api/stats`) のみサーバが提供。
