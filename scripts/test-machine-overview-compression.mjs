import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import sharp from "sharp";
import { compactMachineOverview, OVERVIEW_PREPARED_LIMIT_BYTES, OVERVIEW_MAX_STORED_BYTES } from "../src/lib/machine-overview-compression.ts";

test("small already prepared overviews retain exact original bytes", async () => {
  const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#6b8952" } })
    .jpeg({quality:80}).toBuffer();
  assert.ok(small.length < OVERVIEW_PREPARED_LIMIT_BYTES);
  const result = await compactMachineOverview(new Uint8Array(small));
  assert.deepEqual(result, new Uint8Array(small));
});

test("large older-client camera overview is bounded and preserves the full frame without cropping", async () => {
  // Deterministic low-amplitude camera-like grain over a clear spatial gradient.
  const width = 2200, height = 1600, raw = Buffer.alloc(width * height * 3);
  let state = 0x12345678;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const offset = (y * width + x) * 3;
    const grain = (state >>> 24) % 20;
    raw[offset] = Math.min(255, Math.floor(255*x/width) + grain);
    raw[offset+1] = Math.min(255, Math.floor(255*y/height) + grain);
    raw[offset+2] = Math.min(255, 90 + grain);
  }
  const input = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  assert.ok(input.length > OVERVIEW_PREPARED_LIMIT_BYTES && input.length < 10*1024*1024);
  const reduced = await compactMachineOverview(new Uint8Array(input));
  const meta = await sharp(reduced).metadata();
  assert.equal(meta.format, "webp");
  assert.ok(reduced.length < input.length && reduced.length <= OVERVIEW_MAX_STORED_BYTES);
  assert.ok(meta.width >= 1600 && meta.width <= 2000);
  assert.equal(Math.round(meta.width / meta.height * 100), Math.round(width / height * 100));
});

test("malformed source and oversized input are rejected, never silently stored", async () => {
  await assert.rejects(compactMachineOverview(new Uint8Array([])), /overview_source_size_invalid/);
  await assert.rejects(compactMachineOverview(new Uint8Array([1,2,3,4])), /overview_image_invalid|Input buffer/);
  await assert.rejects(compactMachineOverview(new Uint8Array(10*1024*1024+1)), /overview_source_size_invalid/);
});

test("server compression applies only to ordinary machine overview uploads, before SHA/path generation", () => {
  const src = fs.readFileSync("src/lib/operator-actions.ts","utf8");
  const start = src.indexOf("export async function uploadRefillProofPhoto");
  const end = src.indexOf("export async function uploadInventoryAdjustmentPhoto",start);
  const upload = src.slice(start,end);
  const overview = upload.indexOf("compactMachineOverview(new Uint8Array(await file.arrayBuffer()))");
  const hash = upload.indexOf('createHash("sha256")');
  assert.ok(overview > 0 && hash > overview);
  assert.match(upload,/if \(photoPurpose === "completion"\) \{/);
  assert.match(upload,/if \(photoPurpose === "compressor"\) \{/);
  assert.match(upload,/\.upload\(objectPath, storedFile,/);
  assert.match(upload,/contentType: storedFile\.type/);
  assert.doesNotMatch(upload,/route_stop_quantity_confirmations/);
});
