#!/usr/bin/env node
// passist-mcp — MCP server bridging AI assistants (Claude Desktop, Cursor, Cline 等)
// to PAssist's Local HTTP API at 127.0.0.1:8444.
//
// 配置:
//   AI クライアント (Claude Desktop / Cursor 等)
//      ↕ MCP (stdio: stdin/stdout)
//   passist-mcp.js (このファイル)  ← AI クライアントが child_process として spawn
//      ↕ HTTP (Bearer token)
//   PAssist.exe (host) の Local HTTP API (127.0.0.1:8444)
//
// 環境変数:
//   PASSIST_API_URL   — Local API のベース URL (既定: http://127.0.0.1:8444)
//   PASSIST_TOKEN_FILE — token ファイルのパス (既定: %APPDATA%\PAssist\local-api-token)
//   PASSIST_CLIENT_LABEL — クライアント識別子の上書き (任意)
//
// PAssist が起動していない場合は MCP の initialize は成功するが、 各ツール呼び出しで
// "PASSIST_NOT_RUNNING" エラーを返す (ユーザーに「PAssist を起動してください」 と伝えられる)。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// --- 設定 ---
const API_URL = (process.env.PASSIST_API_URL || 'http://127.0.0.1:8444').replace(/\/$/, '');

// PAssist の userData ディレクトリ名は環境で異なる:
//  - production (PAssist.exe portable):  %APPDATA%\PAssist\
//  - dev (`npm start`, electron が name フィールドを使う):  %APPDATA%\passist-host\
// 起動時に存在する方を採用し、 どちらにも無ければ PASSIST_TOKEN_FILE を要求するエラーを返す。
function candidateTokenFiles() {
  if (process.env.PASSIST_TOKEN_FILE) return [process.env.PASSIST_TOKEN_FILE];
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return [
      path.join(base, 'PAssist', 'local-api-token'),       // production
      path.join(base, 'passist-host', 'local-api-token'),  // dev (npm start)
    ];
  }
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    return [path.join(base, 'PAssist', 'local-api-token'), path.join(base, 'passist-host', 'local-api-token')];
  }
  const base = path.join(os.homedir(), '.config');
  return [path.join(base, 'PAssist', 'local-api-token'), path.join(base, 'passist-host', 'local-api-token')];
}

const TOKEN_FILE_CANDIDATES = candidateTokenFiles();

function readToken() {
  for (const f of TOKEN_FILE_CANDIDATES) {
    try {
      return fs.readFileSync(f, 'utf8').trim();
    } catch {}
  }
  return null;
}

// --- 親プロセス検出 (consent ダイアログでユーザーに「どのクライアントが要求しているか」 を見せる) ---
function detectParentExe() {
  const ppid = process.ppid;
  if (!ppid) return '';
  try {
    if (process.platform === 'win32') {
      // wmic は Win11 で deprecated だが多くの環境でまだ動く。 失敗時は PowerShell にフォールバック。
      try {
        const out = execSync(`wmic process where ProcessId=${ppid} get ExecutablePath /value`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /ExecutablePath=(.+)/.exec(out);
        if (m && m[1].trim()) return m[1].trim();
      } catch {}
      try {
        const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${ppid}).Path"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (out.trim()) return out.trim();
      } catch {}
    } else if (process.platform === 'linux') {
      return fs.readlinkSync(`/proc/${ppid}/exe`);
    } else if (process.platform === 'darwin') {
      const out = execSync(`ps -p ${ppid} -o comm=`, { encoding: 'utf8' });
      return out.trim();
    }
  } catch {}
  return '';
}

const PARENT_EXE = process.env.PASSIST_CLIENT_EXE || detectParentExe();
const CLIENT_LABEL = process.env.PASSIST_CLIENT_LABEL || (PARENT_EXE ? path.basename(PARENT_EXE, path.extname(PARENT_EXE)) : `pid-${process.ppid}`);

// --- HTTP クライアント (Local API 呼び出し) ---
async function callApi(method, urlPath, body) {
  const token = readToken();
  if (!token) {
    const e = new Error(`PASSIST_NOT_RUNNING: token file not found in any of [${TOKEN_FILE_CANDIDATES.join(', ')}]. Please start PAssist.`);
    e.code = 'PASSIST_NOT_RUNNING';
    throw e;
  }
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      'X-PAssist-Client-Exe': PARENT_EXE,
      'X-PAssist-Client-Label': CLIENT_LABEL,
      'X-PAssist-Client-Pid': String(process.ppid || ''),
    },
  };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(API_URL + urlPath, opts);
  } catch (e) {
    const err = new Error(`PASSIST_NOT_RUNNING: ${e.message}. Is PAssist running?`);
    err.code = 'PASSIST_NOT_RUNNING';
    throw err;
  }
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(parsed && parsed.error ? (parsed.error.message || parsed.error.code) : `HTTP ${res.status}`);
    err.code = parsed && parsed.error ? parsed.error.code : `HTTP_${res.status}`;
    err.details = parsed && parsed.error ? parsed.error.details : null;
    throw err;
  }
  return parsed;
}

// --- MCP ツール定義 ---
const TOOLS = [
  {
    name: 'list_windows',
    description: 'PAssist で共有可能なウィンドウの一覧を取得する。 タイトル・アプリ名を返す。 共有先 (相手) には何も影響しない。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_share',
    description: '指定したウィンドウの画面共有を開始し、 ビューア URL を返す。 windowId (list_windows の id) または titleMatch (タイトル部分一致) のどちらかを必須指定。 既定の accessMode は "approve" (相手の接続にホスト承認が必要 = 最も安全)。',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'list_windows が返した id。 完全一致。' },
        titleMatch: { type: 'string', description: 'ウィンドウタイトルの部分一致。 複数マッチでエラーになる。' },
        accessMode: { type: 'string', enum: ['approve', 'pin', 'invite', 'token'], description: 'approve=ホスト承認 / pin=PIN / invite=招待リンク / token=URLのみ (緩い)' },
        maxViewers: { type: 'integer', minimum: 1, maximum: 4, description: '同時接続できるビューア数 (1〜4)' },
        ttlMinutes: { type: 'integer', description: 'セッション有効期限 (分)。 0 = 無期限。 既定 30 分。' },
        readonly: { type: 'boolean', description: 'true で全員閲覧のみに固定' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_share_state',
    description: '現在の共有状態を取得する。 共有中なら url / 接続中ビューア / 承認待ちビューア / アクセスモード / 期限を返す。 共有していなければ active: false を返す。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'end_share',
    description: '現在の画面共有を終了する。 共有中でなければエラー (NO_ACTIVE_SHARE)。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// --- MCP サーバ起動 ---
const server = new Server(
  { name: 'passist', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    if (name === 'list_windows') {
      result = await callApi('GET', '/api/local/windows');
    } else if (name === 'start_share') {
      result = await callApi('POST', '/api/local/share/start', args || {});
    } else if (name === 'get_share_state') {
      result = await callApi('GET', '/api/local/share');
    } else if (name === 'end_share') {
      result = await callApi('POST', '/api/local/share/end', {});
    } else {
      throw new Error('unknown tool: ' + name);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code || 'INTERNAL', message: e.message, details: e.details || null } }, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// MCP プロセスは stdin が閉じるまで生きる (Claude Desktop が落ちれば一緒に終了)
