'use strict';
// ルーターの UPnP IGD にポートを「自動で開ける/閉じる」（手動ポート転送が不要に）。
// PAssist では Web/シグナリングの TCP ポート(既定8443)を開けてインターネット公開する用途。
// Windows の HNetCfg.NATUPnP(COM) を PowerShell 経由で叩く（このPCで動作確認済み）。
const { execFile } = require('child_process');

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(((stderr || '') + (err.message || '')).trim()));
        resolve((stdout || '').trim());
      },
    );
  });
}

// 既定ゲートウェイを持つ IF の IPv4（Tailscale 等の余計な IF を避ける）
const INTERNAL_IP_EXPR =
  "(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null} | Select-Object -First 1).IPv4Address.IPAddress";

// 指定ポートを開ける。proto は 'TCP' または 'UDP'。戻り値: { externalIp, internal }
async function open(externalPort, { proto = 'TCP', internalPort = externalPort, description = 'PAssist' } = {}) {
  const p = parseInt(externalPort, 10);
  const ip = parseInt(internalPort, 10);
  const script = `
$ip = ${INTERNAL_IP_EXPR}
if (-not $ip) { Write-Error 'no LAN IPv4 with default gateway'; exit 1 }
$nat = New-Object -ComObject HNetCfg.NATUPnP
$coll = $nat.StaticPortMappingCollection
if ($null -eq $coll) { Write-Error 'UPnP IGD not available (router UPnP off?)'; exit 1 }
try { $coll.Remove(${p}, '${proto}') } catch {}
$m = $coll.Add(${p}, '${proto}', ${ip}, $ip, $true, '${description}')
Write-Output ("OK " + $m.ExternalIPAddress + " " + $ip + ":" + ${ip})
`;
  const out = await ps(script);
  const m = /^OK (\S+) (\S+)$/.exec(out);
  return { externalIp: m ? m[1] : null, internal: m ? m[2] : null, raw: out };
}

// 指定ポートのマッピングを閉じる
async function close(externalPort, { proto = 'TCP' } = {}) {
  const p = parseInt(externalPort, 10);
  const script = `
$nat = New-Object -ComObject HNetCfg.NATUPnP
$coll = $nat.StaticPortMappingCollection
if ($null -ne $coll) { try { $coll.Remove(${p}, '${proto}'); Write-Output 'REMOVED' } catch { Write-Output 'NONE' } } else { Write-Output 'NO-IGD' }
`;
  return await ps(script);
}

module.exports = { open, close };

// CLI:  node host/portmap.js <open|close> <port> [tcp|udp]
if (require.main === module) {
  const [cmd, portStr, protoArg] = process.argv.slice(2);
  const port = parseInt(portStr, 10);
  const proto = (protoArg || 'TCP').toUpperCase();
  if (cmd === 'open' && port) {
    open(port, { proto })
      .then((r) => console.log('[portmap] opened:', r.raw, '(externalIp=' + r.externalIp + ')'))
      .catch((e) => {
        console.error('[portmap] open failed:', e.message);
        process.exit(1);
      });
  } else if (cmd === 'close' && port) {
    close(port, { proto })
      .then((r) => console.log('[portmap] close:', r))
      .catch((e) => {
        console.error('[portmap] close failed:', e.message);
        process.exit(1);
      });
  } else {
    console.log('usage: node host/portmap.js <open|close> <port> [tcp|udp]');
  }
}
