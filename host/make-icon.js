'use strict';
// docs/passist.svg → host/assets/icon.ico (+ icon.png)。アイコン生成のための一回限りのスクリプト。
//   node host/make-icon.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const _ico = require('png-to-ico');
const pngToIco = typeof _ico === 'function' ? _ico : _ico.default; // v3 は default エクスポート

const svgPath = path.join(__dirname, '..', 'docs', 'passist_min.svg');
const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });

// 非正方形のSVGを、透明背景の正方形に収める（contain）。複数サイズを ico にまとめる。
const square = (size) =>
  sharp(svgPath, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push(await square(s));
  fs.writeFileSync(path.join(outDir, 'icon.png'), await square(512));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), await pngToIco(pngs));
  console.log('generated:', path.join(outDir, 'icon.ico'), '+ icon.png');
})().catch((e) => {
  console.error('icon gen failed:', e.message);
  process.exit(1);
});
