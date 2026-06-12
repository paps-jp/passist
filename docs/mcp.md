# PAssist MCP 統合 設計ドキュメント

> Status: 検討中 (実装未着手)
> Author: ぱっぷす / Claude Code セッション
> Last update: 2026-06-12

## 決定事項ログ

| 日付 | 論点 | 決定 |
|---|---|---|
| 2026-06-12 | `passist-mcp install` を一般ユーザーに公開するか | **公開する**。 PAssist インストーラに「AI アシスタント連携を有効にする」 オプションを設け、 開発者ツールだけでなく一般ユーザーも GUI でセットアップできるようにする (詳細: §7) |
| 2026-06-12 | 特定 AI ベンダーを UI で明示するか | **明示しない**。 表記は **「MCP 対応 AI アシスタント」**・「AI クライアント」 等の汎用語に統一する。 具体的プロダクト名 (Claude Desktop, Cursor, Cline 等) はドキュメントの「対応クライアント例」 リストにのみ出す |
| 2026-06-12 | ユーザー同意のタイミング | **MCP 接続時 (just-in-time consent)**。 install 時のチェックボックスや初回起動時のお知らせは行わず、 各 MCP クライアントからの**初回 API 呼び出し時**に PAssist 側で同意ダイアログを表示する。 設定ファイルの編集 (silent) はインストール時 / クライアント検出時に行い、 機能ゲートは consent で行う。 同意は **per-client** (Claude Desktop と Cursor で別個に同意) |

未決議点 (要 ぱっぷす理事会):

- AI 操作中の被害者 (ビューア) への通知有無
- 監査ログ保持期間 (既定 30 日と開示請求対応の整合)
- `set_access_mode: 'token'` への移行確認の要否

## 用語

| 用語 | 意味 |
|---|---|
| **MCP** | Model Context Protocol。 AI クライアントが外部ツールを呼ぶための標準プロトコル (2024 年に Anthropic がオープン化、 現在は OpenAI / 各エディタが採用)。 仕様: <https://modelcontextprotocol.io> |
| **MCP サーバ** | ツールを公開する側 (PAssist 側)。 本ドキュメントの `passist-mcp` |
| **MCP クライアント** | ツールを呼ぶ側 (AI アシスタント本体)。 ベンダー非依存 |

### 確認済み対応クライアント (2026-06 時点)

- Claude Desktop (Anthropic)
- Claude Code (Anthropic CLI)
- Cursor (エディタ)
- Cline (VS Code 拡張)
- Continue (VS Code / JetBrains 拡張)
- Zed (エディタ)
- OpenAI Agents SDK (Python)
- 他、 仕様準拠の任意のクライアント

## 0. ねらい

PAssist を **AI エージェントから自然言語で操作可能**にする。 例:

> ユーザー: 「VS Code の画面を山田さんに共有して。 1 時間だけ。」
>
> AI アシスタント (MCP クライアント) が PAssist の MCP ツールを順に呼び:
>
> 1. `list_windows()` → "VS Code - main.js" を発見
> 2. `start_share({ titleMatch: "VS Code", ttlMinutes: 60 })` → 共有URL+QR を取得
> 3. ユーザーに「共有URL を生成しました。 こちらをコピーして山田さんに送ってください: …」 と提示

MCP は仕様公開された標準プロトコルなので、 **特定のベンダー・特定の AI に依存しない**。 Claude Desktop / Claude Code / Cursor / Cline / OpenAI Agents SDK など、 MCP 対応の任意のクライアントから同じツール群を呼べる。

## 1. 全体構成

```
                  ┌─────────────────────────────┐
                  │  MCP クライアント             │
                  │  (Claude Desktop / Cursor /   │
                  │   Cline / OpenAI Agents 等)   │
                  └──────────────┬──────────────┘
                                 │ MCP (stdio: stdin/stdout)
                                 ▼
                  ┌─────────────────────────────┐
                  │  passist-mcp                │
                  │  (Node.js, @paps-jp/passist-mcp)│
                  │  ・ MCP プロトコル実装         │
                  │  ・ ツール → HTTP 翻訳        │
                  │  ・ token 読込・rate limit    │
                  └──────────────┬──────────────┘
                                 │ HTTP (127.0.0.1:8444)
                                 │ Authorization: Bearer <token>
                                 ▼
                  ┌─────────────────────────────┐
                  │  PAssist.exe (Electron host) │
                  │  ・ Local HTTP API           │
                  │  ・ 既存の renderer/signaling │
                  │  ・ Tray 通知                │
                  └──────────────┬──────────────┘
                                 │ WebRTC (DTLS-SRTP)
                                 ▼
                  ┌─────────────────────────────┐
                  │  ビューア (相手のブラウザ)     │
                  └─────────────────────────────┘
```

## 2. コンポーネント

### 2.1 PAssist 本体 (Electron host)

新規追加:
- `host/local-api.js` — `127.0.0.1:8444` で listen するローカル HTTP サーバ (express)
- `host/local-api-auth.js` — Bearer token 生成・回転・ファイル永続化
- `host/local-api-handlers/*` — エンドポイント実装 (`windows.js`, `share.js`, `viewers.js` 等)
- `host/main.js` への組み込み: アプリ起動時に Local API を listen 開始、 終了時に close

責務:
- ローカル HTTP API の提供 (REST)
- token 認証・loopback bind 強制
- 既存の renderer プロセス IPC との橋渡し (`ipcMain.handle`)
- Tray からの承認 UI 表示 (要 user confirmation な操作のみ)
- 監査ログ書き込み (`%APPDATA%\PAssist\mcp-audit.jsonl`)

### 2.2 passist-mcp (Node.js, 配布物)

- パッケージ名: `@paps-jp/passist-mcp`
- 配布: npm (`npm i -g @paps-jp/passist-mcp`) + PAssist インストーラ同梱
- 実装: `@modelcontextprotocol/sdk` の Node 版
- 通信: MCP は **stdio** で MCP クライアントと、 **HTTP** で PAssist 本体と

責務:
- MCP プロトコルの実装 (tools, resources, prompts)
- ツール呼び出しを Local HTTP API へ翻訳
- token をファイルから読み、 ヘッダ付与
- PAssist 不在時の明示エラー
- `passist-mcp install` で MCP クライアントの設定ファイルへ自動追加

### 2.3 トークン管理

| 項目 | 値 |
|---|---|
| 保存先 (Windows) | `%APPDATA%\PAssist\local-api-token` |
| 保存先 (将来 Mac) | `~/Library/Application Support/PAssist/local-api-token` |
| 内容 | ランダム 32 バイトの hex (64 文字) |
| 生成タイミング | PAssist 起動時。 既存トークンは破棄して上書き |
| パーミッション | Windows: ACL でユーザーのみ。 Mac: 0600 |
| 寿命 | PAssist プロセス終了で無効 |

`passist-mcp` は MCP リクエストのたびにこのファイルを読み直すので、 PAssist を再起動すると自動的に新トークンに追従する。

## 3. Local HTTP API 仕様

Base URL: `http://127.0.0.1:8444`
Auth: `Authorization: Bearer <token>`
全レスポンスは JSON (Content-Type: `application/json; charset=utf-8`)

### 3.1 GET `/api/local/windows`

共有可能なウィンドウ一覧。

**Response 200**:
```json
{
  "windows": [
    {
      "id": "hwnd:0x00120304",
      "title": "main.js - PAssist - VS Code",
      "app": "Code.exe",
      "preview": "data:image/png;base64,...",
      "size": { "w": 1920, "h": 1080 }
    }
  ]
}
```

`preview` は **省略可** (large response 抑制)。 `?preview=1` で要求。

### 3.2 POST `/api/local/share/start`

共有を開始。

**Request**:
```json
{
  "windowId": "hwnd:0x00120304",
  "titleMatch": "VS Code",
  "accessMode": "approve",
  "maxViewers": 1,
  "ttlMinutes": 30,
  "readonly": false
}
```

- `windowId` または `titleMatch` のどちらかを指定 (両方なら `windowId` 優先)
- `titleMatch` は部分一致 (大小区別なし)。 マッチ複数なら `AMBIGUOUS_WINDOW` エラー
- 残りはオプション。 既定値:
  - `accessMode`: `'approve'`
  - `maxViewers`: 1
  - `ttlMinutes`: 30
  - `readonly`: false

**Response 200**:
```json
{
  "url": "https://passist.paps.jp/s/qMISbS41M9BwcNUPo76l8w",
  "shortUrl": "qMISbS41M9BwcNUPo76l8w",
  "qrPng": "data:image/png;base64,...",
  "pin": "123456",
  "sharedWindow": {
    "id": "hwnd:0x00120304",
    "title": "main.js - PAssist - VS Code"
  },
  "expiresAt": "2026-06-12T07:30:00Z"
}
```

`pin` は `accessMode === 'pin'` のときのみ。

**Errors**:
- 400 `WINDOW_NOT_FOUND` — 指定 ID/title に該当なし
- 409 `AMBIGUOUS_WINDOW` — title 部分一致で複数候補
- 409 `ALREADY_SHARING` — 既存セッションあり (`switch_window` を使え)
- 422 `VALIDATION` — args 不正

### 3.3 GET `/api/local/share`

現在の共有状態。 未共有時は `active: false`。

**Response 200** (共有中):
```json
{
  "active": true,
  "url": "https://passist.paps.jp/s/...",
  "sharedWindow": { "id": "...", "title": "..." },
  "accessMode": "approve",
  "maxViewers": 1,
  "readonly": false,
  "expiresAt": "2026-06-12T07:30:00Z",
  "viewers": [
    { "id": "v1", "joinedAt": "2026-06-12T06:35:00Z", "mode": "operate" }
  ],
  "pending": [
    { "id": "v2", "requestedAt": "2026-06-12T06:40:00Z" }
  ]
}
```

`viewers[].ip` は **既定で含まない** (privacy)。 `?include=ip` でホスト同意済みの場合のみ含める。

### 3.4 POST `/api/local/share/end`

共有を終了。

**Response 200**: `{ "ok": true }`

### 3.5 POST `/api/local/share/switch-window`

現在の共有を維持したままウィンドウだけ差し替え (`replaceTrack`)。 URL は変えない。

**Request**: `{ "windowId": "..." }` または `{ "titleMatch": "..." }`

**Response 200**: `{ "ok": true, "sharedWindow": {...} }`

### 3.6 POST `/api/local/share/set-readonly`

全員を閲覧のみに切替。

**Request**: `{ "on": true }`

**Response 200**: `{ "ok": true }`

### 3.7 POST `/api/local/share/set-access-mode`

アクセスモードを変更。

**Request**: `{ "mode": "approve" | "pin" | "invite" | "token" }`

**Response 200**: `{ "ok": true, "pin": "654321" }` (`mode === 'pin'` のとき)

### 3.8 POST `/api/local/share/invite-link`

招待リンク発行。

**Request**: `{ "label": "山田さん" }`

**Response 200**:
```json
{
  "url": "https://passist.paps.jp/s/...#k=clientId.secret",
  "clientId": "..."
}
```

### 3.9 POST `/api/local/viewers/approve`

待機中ビューアを承認。 **必ず Tray 確認が走る** (自動承認させない)。

**Request**: `{ "viewerId": "v2", "trust": false }`

**Response 200**: `{ "ok": true, "confirmed": true }`
**Response 202**: `{ "ok": false, "confirmed": false, "reason": "user_declined" }`
**Response 408**: `{ "ok": false, "confirmed": false, "reason": "user_timeout" }` (30s 待っても応答なし)

Tray 通知の内容例: 「Claude が "山田さん" の接続承認をリクエストしています。 [許可] [拒否]」

### 3.10 POST `/api/local/viewers/deny`

待機中ビューアを拒否。 こちらは確認不要 (拒否は安全側)。

**Request**: `{ "viewerId": "v2" }`

**Response 200**: `{ "ok": true }`

### 3.11 GET `/api/local/audit`

最近 100 件の MCP API 呼び出しログ。

**Response 200**:
```json
{
  "entries": [
    {
      "ts": "2026-06-12T06:30:00Z",
      "method": "POST",
      "path": "/api/local/share/start",
      "args": { "titleMatch": "VS Code" },
      "result": "200",
      "callerProcess": "passist-mcp"
    }
  ]
}
```

## 4. MCP ツール表面

`passist-mcp` が MCP クライアントに公開するもの。 命名は **MCP の慣例 (snake_case)** に従う。

### 4.1 Tools

| ツール名 | 引数スキーマ (要約) | 動作 |
|---|---|---|
| `list_windows` | なし | GET `/windows` |
| `start_share` | `{ window, accessMode?, maxViewers?, ttlMinutes?, readonly? }` | POST `/share/start` |
| `get_share_state` | なし | GET `/share` |
| `end_share` | なし | POST `/share/end` |
| `switch_window` | `{ window }` | POST `/share/switch-window` |
| `set_access_mode` | `{ mode }` | POST `/share/set-access-mode` |
| `set_readonly` | `{ on }` | POST `/share/set-readonly` |
| `issue_invite_link` | `{ label }` | POST `/share/invite-link` |
| `approve_pending_viewer` | `{ viewerId, trust? }` | POST `/viewers/approve` |
| `deny_pending_viewer` | `{ viewerId }` | POST `/viewers/deny` |
| `get_recent_activity` | なし | GET `/audit` |

各ツールの `description` は **AI が選びやすい説明文**にする (これが大事)。

例 (`start_share` の description):
```
特定のウィンドウを共有してビューア URL を発行する。 ウィンドウは
window 引数で指定する (ID または タイトル部分一致)。 accessMode が
"approve" なら相手の接続にホスト承認が要る (既定・最も安全)、
"pin" なら 6 桁 PIN、 "invite" なら事前リンクのみ、 "token" は誰でも
URL だけで繋がる (注意)。
```

### 4.2 Resources

| URI | 内容 |
|---|---|
| `passist://state` | 現在の共有状態 (JSON, `get_share_state` 同等) |
| `passist://windows` | 現在共有可能なウィンドウ一覧 |
| `passist://audit` | 最近の操作履歴 |

Resources は Claude が**ツール呼び出しなしで参照できる**ので、 「いま共有中？」 に対し低コストで答えられる。

### 4.3 Prompts

| 名前 | 内容 |
|---|---|
| `share-focused` | フォーカス中のウィンドウを共有 (`list_windows` から focused を抽出 → `start_share`) |
| `end-now` | 即座に共有を終了 |
| `who-is-watching` | 現在の接続状況を要約 |

これらは MCP クライアントのプロンプト一覧 (Claude Desktop なら `/` メニュー) に出る。

## 5. セキュリティ

### 5.1 ネットワーク
- HTTP API は `127.0.0.1` のみ bind (`0.0.0.0` 禁止)
- ポート 8444 (既存 8443 と別)
- HTTPS は不要 (loopback)

### 5.2 認証
- Bearer token (32 バイト hex)
- PAssist 起動ごとに rotate
- ファイル ACL でユーザーのみ read
- API 呼び出し失敗 5 回連続で **30 秒間 ban** (brute-force 防止)

### 5.3 ユーザー確認が要る操作

以下は API リクエストだけでは確定せず、 **PAssist の UI/Tray でユーザーが明示承認**するまで完了しない:

- **クライアント単位の初回接続** (just-in-time consent。 §7.1 参照)
- `approve_pending_viewer` (誰を入れるかは絶対に AI 任せにしない)
- `set_access_mode` を `'token'` に変える (緩い設定への移行は確認)

確認 UI:
- Tray アイコンから ballon 通知
- クリックで PAssist ウィンドウが前面化、 承認パネル表示
- 30 秒応答なしで自動拒否

### 5.4 監査

- 全 API 呼び出しを `%APPDATA%\PAssist\mcp-audit.jsonl` に追記
- PAssist UI の 「設定 → AI 操作履歴」 で閲覧可能
- ファイル肥大化対策: 7 日でローテーション、 30 日で削除

### 5.5 機微情報の流出抑止
- viewer の IP / UA は**既定で返さない**
- ウィンドウのスクリーンショット (`preview`) は要求された時のみ
- 招待リンク (`issue_invite_link`) はクライアント側に secret も渡るので、 **MCP ログには secret を残さない** (URL は黒塗り)

## 6. UX 詳細

### 6.1 PAssist が起動していないとき

`passist-mcp` は HTTP 接続失敗時、 ユーザーに次のメッセージを返す:

> PAssist が起動していません。 スタートメニューから PAssist を起動してから、 もう一度同じ依頼をしてください。 (自動起動を有効にするには PAssist の設定 → 「AI アシスタント連携」 タブ → 「自動起動」 を ON)

将来オプション (`passist-mcp` の設定): `autoStart=true` で `PAssist.exe` をバックグラウンド起動。 既定 false。

### 6.2 共有中に別ウィンドウを Claude が指定したとき

`start_share` の既存セッション競合は **`switch_window` を勧めるエラー**で返す:

```
{ "error": { "code": "ALREADY_SHARING", "message": "既に \"X\" を共有中です。 ウィンドウを差し替えるには switch_window を使ってください。", "currentWindow": "X" } }
```

Claude は自然に `switch_window` に切り替える。

### 6.3 ストリーム中の通知

PAssist Tray アイコンに以下を表示:
- 通常: 緑チェック
- AI 操作直後 (10 秒間): 🤖 マーク + ツールチップ「Claude が X をしました」
- 承認待ち: 黄色ベル

## 7. インストール

`passist-mcp` は **一般ユーザーに公開する** (決定事項: 2026-06-12)。 npm に技術的な知識がないユーザーでも、 PAssist の GUI 操作だけで AI 連携を有効化できる。

UI 上は特定 AI ベンダーを明示しない (決定事項: 2026-06-12)。 「**MCP 対応の AI アシスタント**」 などの汎用語で表現し、 PAssist が対応 MCP クライアントを自動検出して当該の設定ファイルを編集する形にする。

同意は **MCP の初回接続時** に PAssist 側のダイアログで取る (just-in-time consent、 決定事項: 2026-06-12)。 install 時のチェックボックスや初回起動時のお知らせは行わない。

### 7.1 一般ユーザー向け (推奨パス)

#### A. PAssist インストール / 起動時のサイレント準備

ユーザーは何も操作不要。 PAssist は起動時に背景で以下を実行:

1. `%LOCALAPPDATA%\PAssist\mcp\passist-mcp.exe` を展開 (Node Single Executable Application で同梱)
2. インストール済みの MCP クライアントを **自動検出** (Claude Desktop / Claude Code / Cursor / Cline 等の既知の設定ファイル位置を走査)
3. 検出したクライアントごとに設定ファイルに `passist` MCP サーバを silently 登録 (既存設定はマージ・衝突時は skip + 監査ログ記録)
4. ただし **token ファイルは未生成**。 この時点で AI から呼ばれても認証エラーで返る

UI には何も出さない (install 時のチェックボックスもトーストも無し)。

#### B. 初回 MCP 接続時の同意ダイアログ (核となる UX)

ユーザーが AI に「画面を共有して」 等と依頼 → AI が passist-mcp を spawn → PAssist Local API に接続 → **PAssist 側で同意ダイアログ表示**:

```
🤖 AI アシスタントから接続要求

  クライアント: Claude Desktop
  プロセスパス: %APPDATA%\Claude\Claude.exe
  最初の要求: list_windows (共有可能なウィンドウ一覧)

  このアシスタントに PAssist の操作を許可しますか?

  許可した場合のアシスタントの能力:
   ・ 共有可能なウィンドウ一覧の取得
   ・ ウィンドウ共有の開始 / 切替 / 終了
   ・ 共有状態 (URL・接続中の人数) の参照
  ※ 接続承認 / 招待リンク発行は別途毎回確認が出ます

  [今回だけ許可]  [このクライアントは常に許可]  [拒否]
```

要素:
- **3 択** (iOS 慣習): 「今回だけ」 / 「常に許可」 / 「拒否」
- どのクライアントか明示 (実行ファイルパスまで)
- 最初の要求内容を表示 (透明性)
- 何ができるようになるか箇条書き (危険操作は別途確認、 を強調)

同意の保存:
- **「常に許可」**: per-client (claude-desktop, cursor, cline, …) ごとに `mcp-consents.json` に永続化
- **「今回だけ」**: 当該プロセスが切断するまでメモリ内のみ
- **「拒否」**: 当該クライアントは以降ブロック (PAssist 側で error 返却)。 設定タブで取消可能

複数の MCP クライアントがある場合は **クライアント別に個別同意**: Claude Desktop で同意しても Cursor の初回接続では再度ダイアログが出る。

#### C. PAssist 設定モーダルからあとで管理

⚙ 設定 → 「**AI アシスタント連携**」 タブ:

```
許可済み AI クライアント:
  ✅ Claude Desktop (常に許可・3 日前に同意)  [取消]
  ⬜ Cursor (未接続)
  ❌ Cline (拒否・1 日前)  [拒否を解除]

検出済み MCP クライアント設定:
  ✅ Claude Desktop (passist 登録済み)
  ✅ Cursor (passist 登録済み)
  ⬜ Continue (検出: 設定ファイル未編集)
  [手動で設定ファイルを開く]   [連携を解除する]

連携有効時に PAssist がサポートする機能:
 ・ MCP プロトコル (Anthropic 公開仕様)
 ・ stdio 経由・ローカルホストのみ
 ・ 操作履歴は設定 → 監査ログで確認可能
```

ここからは以下が可能:
- 過去の許可を取消す (per-client)
- 拒否を解除する (再度初回接続で同意ダイアログが出るようになる)
- 連携自体を解除 (passist エントリを各 MCP クライアント設定から削除)
- 動作テスト (passist-mcp.exe を試験起動 → `initialize` レスポンスを確認)

### 7.2 対応 MCP クライアントの自動検出ロジック

PAssist が認識する設定ファイル位置 (Windows):

| クライアント | 設定ファイル | キー |
|---|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| Claude Code | `%USERPROFILE%\.claude.json` (or `~/.claude/settings.json`) | `mcpServers` |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` | `mcpServers` |
| Cline (VS Code) | VS Code 設定経由 (拡張機能管理画面に誘導) | — |
| Continue | `%USERPROFILE%\.continue\config.json` | `mcpServers` |
| 他 | `passist-mcp install --target <name>` で個別指定可能 | — |

`passist-mcp install` は **存在する設定ファイルのみ編集**し、 存在しないクライアントは無視 (ユーザーが対応クライアントを追加インストール後、 再度実行すれば自動取り込み)。

### 7.3 開発者向け (手動)

npm パッケージとしても並行配布する (CI / コントリビューター用):

```bash
npm i -g @paps-jp/passist-mcp
passist-mcp install                            # 検出した全クライアントに追加
passist-mcp install --target claude-desktop    # 個別指定
passist-mcp install --target cursor
passist-mcp uninstall                          # 全削除
passist-mcp list                               # 検出状況だけ表示
```

`install` は `--dry-run` と編集前バックアップ (`<config>.bak.YYYYMMDDhhmmss`) を持つ。

### 7.4 MCP クライアント設定例

自動編集で挿入される項目 (どのクライアントでも `mcpServers` キーにマージ):

```json
{
  "mcpServers": {
    "passist": {
      "command": "C:\\Users\\<user>\\AppData\\Local\\PAssist\\mcp\\passist-mcp.exe",
      "args": [],
      "env": {
        "PASSIST_API_URL": "http://127.0.0.1:8444",
        "PASSIST_TOKEN_FILE": "%APPDATA%\\PAssist\\local-api-token"
      }
    }
  }
}
```

### 7.5 アンインストール

PAssist 本体のアンインストール時:
- 検出済みの全 MCP クライアント設定から `passist` エントリを削除
- `%LOCALAPPDATA%\PAssist\mcp\` を削除
- 各設定ファイル自体は残す (他の MCP サーバ設定を消さないため)

PAssist は残したまま連携だけ解除する場合:
- 設定モーダル → 「連携を解除する」 → 上記と同じ削除を実行

### 7.6 一般公開にあたっての UX 配慮

- インストーラ上のチェックは **既定 OFF**。 ユーザーが意識して選ぶ
- 「これは何？」 をクリックすると説明モーダル (リスク・有効化される機能・解除方法) が出る
- ベンダー名 (Claude / OpenAI 等) は LP / 設定画面では明示せず、 「対応クライアント一覧」 ボタンの先でのみ表示
- 連携有効時の最初の MCP 呼び出しは必ずトレイ通知で確認 (§5.3 既定方針と同じ)
- 設定モーダル「AI アシスタント連携」 タブには常に「最近 7 日の AI 操作履歴」 を可視化 (§5.4 監査ログ参照)
- LP の DL ページに「AI アシスタント連携対応」 と銘打つ。 紹介リンクは [`docs/mcp.html`](mcp.html) (一般ユーザー向け解説、 後日作成)

## 8. エラー応答仕様

すべてのエラーは以下の構造:

```json
{
  "error": {
    "code": "WINDOW_NOT_FOUND",
    "message": "ヒューマンリーダブルな日本語/英語メッセージ",
    "details": { "...": "任意の追加情報" }
  }
}
```

主要エラーコード:

| code | HTTP | 意味 |
|---|---|---|
| `AUTH_FAILED` | 401 | Bearer token 不一致 |
| `PASSIST_NOT_RUNNING` | (接続失敗) | API サーバに到達不能 |
| `WINDOW_NOT_FOUND` | 400 | 指定 ID / title 該当なし |
| `AMBIGUOUS_WINDOW` | 409 | title 部分一致で複数候補 |
| `ALREADY_SHARING` | 409 | 既存セッション存在 |
| `NO_ACTIVE_SHARE` | 404 | 共有していない状態で `end_share` 等 |
| `USER_DECLINED` | 202 | Tray 確認で拒否 |
| `USER_TIMEOUT` | 408 | Tray 確認で 30 秒応答なし |
| `RATE_LIMITED` | 429 | API レート超過 |
| `VALIDATION` | 422 | args 不正 |
| `INTERNAL` | 500 | 想定外 |

## 9. テスト戦略

### 9.1 ユニット (Node の標準 test runner)
- `local-api-auth.js`: token 生成・検証
- 各 handler のピュアロジック
- MCP→HTTP 変換 (passist-mcp 側)

### 9.2 統合 (Electron 環境)
- 起動・終了で token がローテートされること
- Loopback bind 強制 (`0.0.0.0` で listen していないこと)
- 承認系操作で UI confirmation が走ること

### 9.3 E2E (実 MCP クライアントで手動)

主要クライアントの通し動作確認マトリクス:

- Claude Desktop (Anthropic)
- Cursor
- Cline (VS Code)

各クライアントで:
- `list_windows` → `start_share` → ビューア接続 → `end_share` の通し検証
- 異常系: PAssist 落としてから MCP 呼び出し
- Privacy: viewer.ip がデフォルトで漏れないこと

## 10. ロードマップ

### Phase 1 — MVP (1〜2 週)
- Local HTTP API 基盤 (`/windows`, `/share/start`, `/share`, `/share/end`)
- `passist-mcp` 雛形 (4 ツールのみ)
- token 管理・loopback 強制
- 手動インストールドキュメント

### Phase 2 — 実用機能 (1〜2 週)
- `switch_window`, `set_access_mode`, `set_readonly`, `issue_invite_link`
- 承認系 (`approve_pending_viewer`, Tray confirmation)
- 監査ログ + UI 表示

### Phase 3 — 一般公開 (1〜2 週)
- PAssist インストーラ / 初期設定に「MCP 対応の AI アシスタントと連携する」 チェックボックスを追加 (§7.1.A)
- 設定モーダル「AI アシスタント連携」 タブを新設 (§7.1.B): 検出済みクライアント一覧・有効化/解除・動作テスト・最近 7 日の操作履歴
- 対応 MCP クライアントの自動検出ロジック (§7.2): Claude Desktop / Claude Code / Cursor / Cline / Continue の既知の設定ファイル位置を走査
- Node Single Executable Application で `passist-mcp.exe` を作成、 `%LOCALAPPDATA%\PAssist\mcp\` に同梱
- 各クライアント設定ファイルの自動編集ロジック (既存設定の保持・バックアップ・衝突確認)
- npm パッケージ `@paps-jp/passist-mcp` を並行公開 (CI / 開発者用、 `passist-mcp install --target <name>` で個別指定可)
- LP に「AI アシスタント連携対応」 セクション (ベンダー名は明示しない方針)、 ja / en 両対応 (i18n.js に `lp.mcp.*` キーを追加)
- 一般ユーザー向け解説ページ `docs/mcp.html` (`docs/mcp.md` を簡易化・i18n 対応)

### Phase 4 — 拡張 (将来)
- Resources / Prompts
- macOS 対応 (host-mac の成熟後)
- viewer 側からの安全な情報取得 API (例: 「今接続している相手の表示名は？」)

## 11. 範囲外 (本ドキュメントでは扱わない)

- AI による画面内容の理解・判断 (別ドキュメント候補: 「AI 連携 拡張案: 画面理解」)
- 音声・字幕の通訳機能
- ビューア側の AI 連携 (今は host 側のみ)
- 自動共有判断 (AI が勝手に画面を見て選ぶ)

## 12. 参考

- Model Context Protocol 仕様: <https://modelcontextprotocol.io>
- `@modelcontextprotocol/sdk` (Node): <https://github.com/modelcontextprotocol/typescript-sdk>
- MCP クライアント別 設定ファイル仕様:
  - Claude Desktop: <https://docs.claude.com/en/docs/claude-code/mcp>
  - Cursor: <https://docs.cursor.com/context/model-context-protocol>
  - Cline: <https://docs.cline.bot/mcp/configuring-mcp-servers>
  - OpenAI Agents SDK: <https://openai.github.io/openai-agents-python/mcp/>
- 既存 PAssist 構成: [`docs/docs.html`](docs.html), [`docs/verification.html`](verification.html)

## 13. 次のアクション

このドキュメントへのコメントを集めたら:

1. ぱっぷす理事会で承認可否 (機微データ取扱との整合性)
2. Phase 1 の Issue/PR を切る
3. `host/local-api.js` の最小実装に着手

---

**Feedback welcome**: 設計上の判断 (token 配布方法・確認 UI の粒度・MCP ツール命名等) について意見があれば GitHub Issue or PR に。
