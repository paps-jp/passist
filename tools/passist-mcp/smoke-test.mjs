// passist-mcp を spawn して MCP プロトコルで list_windows を呼ぶ簡易テスト。
// node smoke-test.mjs で実行。 PAssist 本体が起動している必要がある。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, [path.join(__dirname, 'passist-mcp.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PASSIST_CLIENT_LABEL: 'SmokeTest',
    PASSIST_CLIENT_EXE: 'C:\\Test\\fake-claude.exe', // pre-granted consent
  },
});

child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  while (true) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else {
        console.log('[notification]', JSON.stringify(msg).slice(0, 100));
      }
    } catch (e) {
      console.log('[unparseable]', line.slice(0, 200));
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const req = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(req) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); }
    }, 15000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  console.log('=== initialize ===');
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  console.log('server:', init.result.serverInfo, 'protocol:', init.result.protocolVersion);

  notify('notifications/initialized');

  console.log('\n=== tools/list ===');
  const tools = await send('tools/list');
  console.log('tool count:', tools.result.tools.length);
  for (const t of tools.result.tools) console.log('  -', t.name, ':', t.description.slice(0, 60));

  console.log('\n=== tools/call: list_windows ===');
  const r = await send('tools/call', { name: 'list_windows', arguments: {} });
  const text = r.result.content && r.result.content[0] && r.result.content[0].text;
  const parsed = JSON.parse(text);
  if (parsed.error) {
    console.log('ERROR:', parsed.error);
  } else {
    console.log('windows:', parsed.windows.length);
    parsed.windows.slice(0, 3).forEach((w, i) => console.log(`  ${i + 1}.`, w.title));
  }

  console.log('\n=== tools/call: get_share_state ===');
  const r2 = await send('tools/call', { name: 'get_share_state', arguments: {} });
  console.log(r2.result.content[0].text);

  child.stdin.end();
  setTimeout(() => process.exit(0), 200);
} catch (e) {
  console.error('FAILED:', e.message);
  child.kill();
  process.exit(1);
}
