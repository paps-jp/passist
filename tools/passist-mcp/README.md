# passist-mcp

PAssist を MCP (Model Context Protocol) 経由で AI アシスタントから操作するためのブリッジ。

> Status: Phase 1 MVP (実装中)。 設計詳細は [`docs/mcp.md`](../../docs/mcp.md) 参照。

## 概要

MCP 対応の AI アシスタント (Claude Desktop, Cursor, Cline 等) から、 自然言語で PAssist を操作できるようにする。

```
ユーザー: "VS Code の画面を相手に共有して"
   ↓
AI アシスタント: start_share({ titleMatch: "VS Code" }) を呼び出す
   ↓
passist-mcp: PAssist の Local API (127.0.0.1:8444) を Bearer 認証で呼ぶ
   ↓
PAssist: 初回なら同意ダイアログを表示 → 承認後にウィンドウを共有開始
   ↓
ユーザーに共有 URL を返す: https://passist.paps.jp/s/...
```

## 提供する MCP ツール (Phase 1)

| ツール名 | 機能 |
|---|---|
| `list_windows` | 共有可能なウィンドウの一覧 |
| `start_share` | 指定ウィンドウの共有を開始 (URL を返す) |
| `get_share_state` | 現在の共有状態 (URL・接続中ビューア・承認待ち) |
| `end_share` | 共有を終了 |

Phase 2 以降で `switch_window` / `set_access_mode` / `approve_pending_viewer` / `issue_invite_link` を追加予定。

## 同意モデル (just-in-time consent)

- インストール時の確認は無し
- AI アシスタントが最初にツールを呼んだ瞬間に PAssist 側で同意ダイアログが出る
- 同意は per-client (Claude Desktop と Cursor は別個に同意)
- 「今回だけ」 / 「常に許可」 / 「拒否」 の 3 択

## インストール (開発者向け・Phase 1)

```bash
# このディレクトリで:
npm install
npm link    # passist-mcp コマンドをグローバルに登録
```

または npm パッケージ化後:
```bash
npm i -g @paps-jp/passist-mcp
```

## MCP クライアント設定 (手動・Phase 1)

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "passist": {
      "command": "passist-mcp"
    }
  }
}
```

### Claude Code

`~/.claude.json` または `~/.claude/settings.json` の `mcpServers` に追加:

```json
{
  "mcpServers": {
    "passist": {
      "command": "passist-mcp"
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` に追加 (構造は同じ)。

Phase 3 で PAssist インストーラに自動編集機能を組み込む予定。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `PASSIST_API_URL` | `http://127.0.0.1:8444` | PAssist Local API のベース URL |
| `PASSIST_TOKEN_FILE` | OS 既定 (下表) | 認証 token を読み出すファイル |
| `PASSIST_CLIENT_LABEL` | 親プロセス名 | クライアント識別子 (consent ダイアログに表示) |

`PASSIST_TOKEN_FILE` の OS 別既定値:

| OS | パス |
|---|---|
| Windows | `%APPDATA%\PAssist\local-api-token` |
| macOS | `~/Library/Application Support/PAssist/local-api-token` |
| Linux | `~/.config/PAssist/local-api-token` |

## エラー

PAssist が起動していない場合:

```json
{ "error": { "code": "PASSIST_NOT_RUNNING", "message": "..." } }
```

AI アシスタントには「PAssist を起動してから再度お試しください」 と伝えること。

## セキュリティ

- HTTP は **127.0.0.1 のみ** で listen (外部からアクセス不可)
- Bearer token は PAssist 起動ごとにローテーション
- 機微操作 (`approve_pending_viewer` 等) は **PAssist 側で必ず追加の UI 確認**を要求する設計

詳細は [`docs/mcp.md` §5](../../docs/mcp.md#5-セキュリティ) を参照。

## ライセンス

MIT — 詳細は [リポジトリ LICENSE](../../LICENSE) 参照。
