// @sigstore/verify とその依存をブラウザ向けに 1 ファイルへバンドルする。
// 出力: server/public/sigstore-verifier.bundle.js（≈数百KB、gzip後 数十KB）
// 利用側（viewer.js / about.js）から動的 import() で読み込む。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoServer = path.resolve(__dirname, '..');

// ブラウザ向けに entry を生成（src to bundle）。
// @sigstore/verify から最小限のものを再エクスポート。
const ENTRY = path.join(repoServer, 'tools', 'sigstore-entry.mjs');
fs.writeFileSync(
  ENTRY,
  `// 自動生成（build-sigstore.mjs）— 編集しない
import { Verifier } from '@sigstore/verify';
import { Bundle, bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';

globalThis.__sigstore = { Verifier, Bundle, bundleFromJSON, TrustedRoot };
export { Verifier, Bundle, bundleFromJSON, TrustedRoot };
`
);

const out = path.join(repoServer, 'public', 'sigstore-verifier.bundle.js');
await build({
  entryPoints: [ENTRY],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
  // ブラウザ向け polyfill
  inject: [],
  banner: { js: '/* @sigstore/verify bundled for browser. See SOURCE: https://github.com/sigstore/sigstore-js */' },
});

const stat = fs.statSync(out);
console.log('[build-sigstore] wrote', out, '(' + (stat.size / 1024).toFixed(1) + ' KB)');
