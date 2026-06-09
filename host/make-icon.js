'use strict';
// アイコン生成: マスコット(docs/passist_min.svg) を、グラデの角丸タイル(assets/icon-tile.svg)に
// 合成して host/assets/icon.ico (+ icon.png) を作る。  実行: node host/make-icon.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const _ico = require('png-to-ico');
const pngToIco = typeof _ico === 'function' ? _ico : _ico.default; // v3 は default エクスポート

const tileSvg = path.join(__dirname, 'assets', 'icon-tile.svg');
const markSvg = path.join(__dirname, '..', 'docs', 'passist_min.svg');
const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });

// タイルを size 正方形で描画 → マスコットを中央(やや上)に合成
async function render(size) {
  const tile = await sharp(tileSvg, { density: 600 }).resize(size, size).png().toBuffer();
  const markSize = Math.round(size * 0.66);
  const mark = await sharp(markSvg, { density: 600 })
    .resize(markSize, markSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const left = Math.round((size - markSize) / 2);
  const top = Math.max(0, Math.round((size - markSize) / 2) - Math.round(size * 0.012)); // 視覚的に少し上へ
  return sharp(tile).composite([{ input: mark, top, left }]).png().toBuffer();
}

(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push(await render(s));
  fs.writeFileSync(path.join(outDir, 'icon.png'), await render(512));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), await pngToIco(pngs));
  console.log('generated:', path.join(outDir, 'icon.ico'), '+ icon.png');
})().catch((e) => {
  console.error('icon gen failed:', e.message);
  process.exit(1);
});
