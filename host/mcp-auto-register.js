'use strict';
// MCP クライアント設定ファイルの自動検出・登録・無効化。
//
// 役割:
//   - PAssist 起動時に既知の MCP クライアント (Claude Desktop / Claude Code /
//     Cursor / Continue 等) を検出し、 passist エントリを silently 追加する。
//   - 既存設定は保持・マージし、 書き換え前にバックアップを作成する。
//   - ユーザが設定タブから無効化したクライアントは、 disabled リストに記録され、
//     以降の自動登録対象外になる (再有効化はリストから外す)。
//
// 状態ファイル:
//   %APPDATA%\passist-host\mcp-disabled-clients.json
//     = ["cursor", "cline"] のような文字列配列。 含まれる id は自動登録しない。

const fs = require('fs');
const path = require('path');
const os = require('os');

// === 既知の MCP クライアント定義 ===
// 各 entry: id / name / configPath / mcpServersKey
// 既知パスは Windows ベース。 macOS / Linux 対応は将来。
function knownClients() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      configPath: path.join(appdata, 'Claude', 'claude_desktop_config.json'),
      key: 'mcpServers',
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      // Claude Code は ~/.claude.json (新) と ~/.claude/settings.json (旧) の 2 系統を見る
      configPath: path.join(home, '.claude.json'),
      altConfigPaths: [path.join(home, '.claude', 'settings.json')],
      key: 'mcpServers',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      key: 'mcpServers',
    },
    {
      id: 'continue',
      name: 'Continue',
      configPath: path.join(home, '.continue', 'config.json'),
      key: 'mcpServers',
    },
  ];
}

// === 状態管理: 無効化リスト ===
let stateFile = null;

function init(userDataDir) {
  stateFile = path.join(userDataDir, 'mcp-disabled-clients.json');
}

function loadDisabled() {
  try {
    if (!stateFile || !fs.existsSync(stateFile)) return [];
    const arr = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveDisabled(list) {
  try {
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn('[mcp-auto-register] 無効化リスト保存失敗:', e.message);
  }
}

// === JSON 読み書きユーティリティ ===
function readJsonSafe(file) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1); // BOM 除去
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function backup(file) {
  try {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const bak = `${file}.bak.${ts}`;
    fs.copyFileSync(file, bak);
    return bak;
  } catch {
    return null;
  }
}

// 実際にコンフィグが存在するパスを返す (alt も含めて先に見つかったもの)
function effectivePath(client) {
  if (fs.existsSync(client.configPath)) return client.configPath;
  for (const p of client.altConfigPaths || []) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// === passist エントリの生成 ===
// dev mode (`npm start`): ユーザ環境の node + リポジトリ内の script を使う
// production (PAssist.exe portable): PAssist.exe 自身を Node ランタイムとして再利用する。
//   - ELECTRON_RUN_AS_NODE=1 を付けて Electron バイナリを呼ぶと GUI を開かず Node プロセスになる
//   - 利点: ユーザに Node.js のインストールを要求しない、 passist-mcp.exe (Phase 3) を待たなくてよい
//   - 同梱物: host/package.json の extraResources で tools/passist-mcp と
//     その node_modules を resources/passist-mcp/ に展開する
function buildPassistEntry({ appPath, isPackaged, resourcesPath, execPath }) {
  if (isPackaged) {
    const scriptPath = path.join(resourcesPath, 'passist-mcp', 'passist-mcp.js');
    return {
      command: execPath,
      args: [scriptPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PASSIST_API_URL: 'http://127.0.0.1:8444',
      },
    };
  }
  // 開発時: <project>/tools/passist-mcp/passist-mcp.js
  // appPath = <project>/host なので一つ上に上がる
  const scriptPath = path.join(appPath, '..', 'tools', 'passist-mcp', 'passist-mcp.js');
  return {
    command: 'node',
    args: [scriptPath],
    env: { PASSIST_API_URL: 'http://127.0.0.1:8444' },
  };
}

// === 検出 ===
function detectAll() {
  const out = [];
  for (const c of knownClients()) {
    const cfgPath = effectivePath(c);
    const exists = !!cfgPath;
    let configured = false;
    let configError = null;
    if (exists) {
      const data = readJsonSafe(cfgPath);
      if (data === null) configError = 'JSON 解析失敗';
      else if (data[c.key] && data[c.key].passist) configured = true;
    }
    out.push({
      id: c.id,
      name: c.name,
      configPath: c.configPath, // 主 path (検出に使った path ではなく仕様上の位置)
      effectivePath: cfgPath,
      exists,
      configured,
      configError,
    });
  }
  return out;
}

// === 個別の有効化 ===
function enableClient(clientId, passistEntry) {
  const c = knownClients().find((x) => x.id === clientId);
  if (!c) return { ok: false, error: 'unknown client' };
  // 設定ファイルの位置を決める: 既存があればそれ、 なければ主 path を新規作成
  let cfgPath = effectivePath(c);
  let created = false;
  if (!cfgPath) {
    cfgPath = c.configPath;
    try { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); } catch {}
    created = true;
  }
  let data = created ? {} : (readJsonSafe(cfgPath) || {});
  let bakPath = null;
  if (!created) bakPath = backup(cfgPath);
  if (!data[c.key]) data[c.key] = {};
  data[c.key].passist = passistEntry;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
  } catch (e) {
    return { ok: false, error: 'write failed: ' + e.message };
  }
  // 無効化リストから外す (再有効化扱い)
  const disabled = loadDisabled().filter((id) => id !== clientId);
  saveDisabled(disabled);
  return { ok: true, configPath: cfgPath, backupPath: bakPath, created };
}

// === 個別の無効化 ===
function disableClient(clientId) {
  const c = knownClients().find((x) => x.id === clientId);
  if (!c) return { ok: false, error: 'unknown client' };
  // 無効化リストに追加 (重複防止)
  const disabled = loadDisabled();
  if (!disabled.includes(clientId)) {
    disabled.push(clientId);
    saveDisabled(disabled);
  }
  // 設定ファイルから passist エントリを削除
  const cfgPath = effectivePath(c);
  if (!cfgPath) return { ok: true, removed: false };
  const data = readJsonSafe(cfgPath);
  if (!data || !data[c.key] || !data[c.key].passist) return { ok: true, removed: false };
  const bakPath = backup(cfgPath);
  delete data[c.key].passist;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
  } catch (e) {
    return { ok: false, error: 'write failed: ' + e.message };
  }
  return { ok: true, removed: true, backupPath: bakPath };
}

// === 起動時自動有効化 ===
// 各クライアントについて:
//   - configPath が存在しない → スキップ ('not-installed')
//   - 既に passist エントリあり → スキップ ('already-enabled')
//   - 無効化リストに含まれる → スキップ ('user-disabled')
//   - 上記いずれでもない → enableClient を呼ぶ ('enabled-now')
function autoEnableAll(passistEntry) {
  const disabled = loadDisabled();
  const results = [];
  for (const c of knownClients()) {
    const cfgPath = effectivePath(c);
    if (!cfgPath) {
      results.push({ id: c.id, name: c.name, status: 'not-installed' });
      continue;
    }
    const data = readJsonSafe(cfgPath);
    if (data && data[c.key] && data[c.key].passist) {
      results.push({ id: c.id, name: c.name, status: 'already-enabled' });
      continue;
    }
    if (disabled.includes(c.id)) {
      results.push({ id: c.id, name: c.name, status: 'user-disabled' });
      continue;
    }
    try {
      const r = enableClient(c.id, passistEntry);
      results.push({
        id: c.id,
        name: c.name,
        status: r.ok ? 'enabled-now' : 'error',
        error: r.error,
        backupPath: r.backupPath,
      });
    } catch (e) {
      results.push({ id: c.id, name: c.name, status: 'error', error: e.message });
    }
  }
  return results;
}

module.exports = {
  init,
  knownClients,
  detectAll,
  enableClient,
  disableClient,
  autoEnableAll,
  buildPassistEntry,
  loadDisabled,
};
