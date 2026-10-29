// Real browser encoder test. Synthetic fixtures only; no external app/credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require('../.qa/browser/node_modules/playwright');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/refill-photo.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const setup = `window.refillPhoto = (() => { const exports = {}; ${compiled}; return exports; })();`;
const results = [];
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: setup });
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 3200; canvas.height = 2400;
      const c = canvas.getContext('2d');
      const pixels = c.createImageData(canvas.width, canvas.height);
      let seed = 123;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        const noise = (seed >>> 24) % 40;
        const i = 4 * (y * canvas.width + x);
        pixels.data[i] = (x / 20 + noise) % 240;
        pixels.data[i + 1] = (y / 15 + noise) % 240;
        pixels.data[i + 2] = 100 + noise;
        pixels.data[i + 3] = 255;
      }
      c.putImageData(pixels, 0, 0);
      c.fillStyle = '#fff'; c.fillRect(200, 200, 2800, 400);
      c.fillStyle = '#111'; c.font = 'bold 100px sans-serif'; c.fillText('SNACKY — machine proof 123', 300, 430);
      const original = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.98));
      const source = new File([original], 'camera.jpg', { type: 'image/jpeg', lastModified: 123 });
      const prepared = await window.refillPhoto.prepareRefillPhoto(source);
      const repeated = await window.refillPhoto.prepareRefillPhoto(source);
      const image = new Image(); const url = URL.createObjectURL(prepared);
      try {
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
        return { originalBytes: original.size, preparedBytes: prepared.size, mime: prepared.type, width: image.naturalWidth, height: image.naturalHeight, sameFile: prepared === repeated, lastModified: prepared.lastModified };
      } finally { URL.revokeObjectURL(url); }
    });
    assert.ok(result.preparedBytes < result.originalBytes);
    assert.ok(result.preparedBytes <= 900 * 1024);
    assert.ok(result.width <= 2000);
    assert.equal(result.width / result.height, 4 / 3);
    assert.equal(result.sameFile, true); assert.equal(result.lastModified, 123);
    results.push({ browser: name, ...result });
  } finally { await browser.close(); }
}
fs.mkdirSync('diagnostics', { recursive: true });
fs.writeFileSync('diagnostics/refill-photo-browser.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
