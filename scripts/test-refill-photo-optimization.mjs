import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('src/lib/refill-photo.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const file = (size = 2_000_000, type = 'image/jpeg') => new File([new Uint8Array(size)], 'machine.jpg', { type, lastModified: 1000 });
function harness(options = {}) {
  let decoded = 0, closed = 0, revoked = 0;
  const encodings = [], canvases = [];
  const exports = {};
  const bitmap = { width: options.width ?? 4000, height: options.height ?? 3000, close() { closed++; } };
  class FakeImage {
    naturalWidth = bitmap.width; naturalHeight = bitmap.height;
    set src(value) { queueMicrotask(() => options.nativeFails ? this.onerror() : this.onload()); }
  }
  vm.runInNewContext(js, {
    exports, File, Blob, WeakMap, Set, Promise, Error, queueMicrotask, Uint8Array,
    createImageBitmap: async () => { decoded++; if (options.bitmapFails) throw Error('bitmap'); return bitmap; },
    Image: FakeImage,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() { revoked++; } },
    document: { createElement(name) {
      assert.equal(name, 'canvas');
      const canvas = { width: 0, height: 0, getContext: () => options.noContext ? null : { fillStyle: '', fillRect() {}, drawImage() {} },
        toBlob(callback, mime, quality) {
          const attempt = { mime, quality, width: this.width, height: this.height }; encodings.push(attempt);
          const result = options.output ? options.output(attempt, encodings.length) : { size: 250_000, type: mime };
          queueMicrotask(() => callback(result ? new Blob([new Uint8Array(result.size)], { type: result.type }) : null));
        } };
      canvases.push(canvas); return canvas;
    } },
  });
  return { ...exports, encodings, canvases, stats: () => ({ decoded, closed, revoked }) };
}

test('invalid types, empty files and originals over 10 MiB never reach image decoding', async () => {
  const h = harness();
  for (const f of [file(10, 'image/svg+xml'), file(10, 'application/pdf'), file(0), file(11 * 1024 * 1024)]) await assert.rejects(h.prepareRefillPhoto(f));
  assert.equal(h.stats().decoded, 0);
});
test('already compact photos retain exact bytes without another lossy encoding', async () => {
  const h = harness({ width: 1600, height: 1200 }), f = file(200_000);
  assert.equal(await h.prepareRefillPhoto(f), f);
  assert.equal(h.encodings.length, 0); assert.equal(h.stats().closed, 1);
});
test('large photo becomes small WebP with correct extension, preserved aspect and lastModified', async () => {
  const h = harness(), f = file();
  const result = await h.prepareRefillPhoto(f);
  assert.equal(result.name, 'machine.webp'); assert.equal(result.type, 'image/webp');
  assert.equal(result.size, 250_000); assert.equal(result.lastModified, f.lastModified);
  assert.deepEqual(h.encodings[0], { mime: 'image/webp', quality: 0.84, width: 2000, height: 1500 });
  assert.equal(f.size, 2_000_000); assert.equal(h.stats().closed, 1);
  assert.equal(h.canvases[0].width, 1, 'Canvas memory released after work');
});
test('same-file retry and concurrent calls use the exact same prepared bytes', async () => {
  const h = harness(), f = file();
  const first = h.prepareRefillPhoto(f), second = h.prepareRefillPhoto(f);
  assert.equal(first, second);
  const result = await first;
  assert.equal(await h.prepareRefillPhoto(f), result); assert.equal(h.stats().decoded, 1);
});
test('native WebP fallback cannot mislabel PNG output as WebP', async () => {
  const h = harness({ output: ({ mime }) => ({ size: 200_000, type: mime === 'image/webp' ? 'image/png' : 'image/jpeg' }) });
  const result = await h.prepareRefillPhoto(file());
  assert.equal(result.type, 'image/jpeg'); assert.equal(result.name, 'machine.jpg');
  assert.deepEqual(h.encodings.map(x => x.mime), ['image/webp', 'image/jpeg']);
});
test('quality has a floor; detailed photos may exceed the target but never 900 KiB', async () => {
  const h = harness({ output: ({ mime }) => ({ size: 600_000, type: mime }) });
  const result = await h.prepareRefillPhoto(file());
  assert.equal(result.size, 600_000); assert.ok(result.size < h.REFILL_PHOTO_UPLOAD_MAX_BYTES);
  assert.deepEqual(h.encodings.map(x => x.width), [2000, 2000, 1600]);
  assert.ok(h.encodings.every(x => x.quality >= 0.78));
});
test('when preparation cannot fit, it fails rather than uploading the original; retry can recover', async () => {
  let bad = true;
  const h = harness({ output: ({ mime }) => ({ size: bad ? 1_500_000 : 300_000, type: mime }) }), f = file();
  await assert.rejects(h.prepareRefillPhoto(f), /no new photo was saved/);
  bad = false;
  assert.equal((await h.prepareRefillPhoto(f)).size, 300_000); assert.equal(h.stats().decoded, 2);
});
test('preparation never increases small-image dimensions or size', async () => {
  const h = harness({ width: 800, height: 600, output: ({ mime }) => ({ size: 700_000, type: mime }) }), f = file(500_000);
  assert.equal(await h.prepareRefillPhoto(f), f);
  assert.ok(h.encodings.every(x => x.width === 800 && x.height === 600));
});
test('native decoder fallback releases its object URL on success and failure', async () => {
  const h = harness({ bitmapFails: true });
  await h.prepareRefillPhoto(file()); assert.equal(h.stats().revoked, 1);
  const broken = harness({ bitmapFails: true, nativeFails: true });
  await assert.rejects(broken.prepareRefillPhoto(file())); assert.equal(broken.stats().revoked, 1);
});
test('invalid dimensions and too many decoded pixels are rejected', async () => {
  for (const dims of [{ width: 0 }, { width: 10_000, height: 10_000 }]) {
    const h = harness(dims); await assert.rejects(h.prepareRefillPhoto(file())); assert.equal(h.stats().closed, 1);
  }
});
test('localized errors are actionable and canvas/encoder failures do not silently upload originals', async () => {
  const h = harness({ noContext: true }); await assert.rejects(h.prepareRefillPhoto(file(), true), /لم يتم حفظ صورة جديدة/);
  const noEncoder = harness({ output: () => null }); await assert.rejects(noEncoder.prepareRefillPhoto(file()));
});
test('all ordinary-camera paths prepare before upload; financial and quantity evidence is untouched', () => {
  const read = p => fs.readFileSync(p, 'utf8');
  const page = read('src/app/operator/routes/[id]/stops/[stopId]/page.tsx');
  assert.equal((page.match(/await prepareProofPhoto\(/g) ?? []).length, 2);
  assert.match(page, /PROOF_PHOTO_TARGET_BYTES = 850 \* 1024/);
  for (const path of ['src/components/operator/RouteStopQuickActions.tsx', 'src/components/operator/CompressorSafetyProofCard.tsx']) {
    assert.match(read(path), /append\("photo", await prepareRefillPhoto\(/);
  }
  for (const path of ['src/lib/cash-evidence.ts', 'src/lib/purchase-receipts.ts', 'src/components/operator/MachineQuantityConfirmationCard.tsx', 'src/components/routes/PendingMachineQuantityUpdateCard.tsx']) {
    assert.doesNotMatch(read(path), /prepareRefillPhoto/);
  }
  const action = read('src/lib/operator-actions.ts');
  assert.match(action, /photoDigest = createHash\("sha256"\)/);
  assert.match(action, /canAccessOperatorRoute\(routeAccessProfile, route\.operator_id\)/);
  assert.match(action, /precompletion_photo_saved: true/);
});
