# CLAUDE.md

PAssist — アカウント不要で、単一ウィンドウをブラウザから共有・遠隔操作するツール。
(host: Electron アプリ / server: シグナリングサーバ)

## Git のルール

- **コミットに Claude / Anthropic を共同作成者として含めない。**
  - `Co-Authored-By: Claude ...` などのトレーラーを付けないこと。
  - PR 本文に「🤖 Generated with Claude Code」等の Claude 由来の署名を入れないこと。
  - author / committer も実ユーザーのみとし、Claude を contributor として記載しない。
- コミットメッセージは作業内容のみを簡潔に記述する。
