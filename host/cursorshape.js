'use strict';
// ホストの「現在のカーソル形状」を Windows API (GetCursorInfo) で検出して通知する。
// 標準カーソル(LoadCursor)のハンドルと照合して種類名を判定。変化時のみ出力。
// 依存を増やさないため PowerShell + P/Invoke を常駐プロセスでポーリングする。
const { spawn } = require('child_process');

const SCRIPT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class Cur {',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }',
  '  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);',
  '  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr h, int n);',
  '}',
  '"@',
  '$ids=@{32512="arrow";32513="ibeam";32514="wait";32515="cross";32642="sizenwse";32643="sizenesw";32644="sizewe";32645="sizens";32646="sizeall";32648="no";32649="hand";32650="appstarting";32651="help"}',
  '$map=@{}',
  'foreach($id in $ids.Keys){ $h=[Cur]::LoadCursor([IntPtr]::Zero,$id); if($h -ne [IntPtr]::Zero){ $map[$h]=$ids[$id] } }',
  '$last=""',
  'while($true){',
  '  $ci=New-Object Cur+CURSORINFO',
  '  $ci.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($ci)',
  '  if([Cur]::GetCursorInfo([ref]$ci)){',
  '    if($ci.flags -eq 0){ $name="hidden" } elseif($map.ContainsKey($ci.hCursor)){ $name=$map[$ci.hCursor] } else { $name="arrow" }',
  '    if($name -ne $last){ $last=$name; [Console]::Out.WriteLine($name); [Console]::Out.Flush() }',
  '  }',
  '  Start-Sleep -Milliseconds 150',
  '}',
].join('\n');

let proc = null;

function start(onShape) {
  if (proc || process.platform !== 'win32') return;
  const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64'); // -EncodedCommand で引用符問題を回避
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true });
  } catch {
    proc = null;
    return;
  }
  proc.stdout.on('data', (buf) => {
    String(buf)
      .split(/\r?\n/)
      .forEach((l) => {
        const s = l.trim();
        if (s) onShape(s);
      });
  });
  proc.on('exit', () => {
    proc = null;
  });
  proc.on('error', () => {
    proc = null;
  });
}

function stop() {
  if (proc) {
    try {
      proc.kill();
    } catch {}
    proc = null;
  }
}

module.exports = { start, stop };
