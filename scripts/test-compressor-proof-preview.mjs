import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import sharp from "sharp";
import { compactCompressorIndicator, COMPRESSOR_PREVIEW_MAX_BYTES } from "../src/lib/compressor-proof-preview.ts";

const image = `<svg width="3024" height="4032" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#444"/><rect x="400" y="1500" width="1600" height="700" fill="#222"/><circle cx="1300" cy="1800" r="130" fill="#00ff00"/><text x="1200" y="2000" font-size="120" fill="#fff">ON</text></svg>`;
const original = await sharp(Buffer.from(image)).jpeg({quality:92}).toBuffer();

test("historical compressor proxy shrinks real JPEG image while retaining whole-frame aspect and readable on-indicator", async () => {
  const compact = await compactCompressorIndicator(original);
  const info = await sharp(compact).metadata();
  assert.equal(info.format, "webp");
  assert.ok(compact.byteLength < original.byteLength);
  assert.ok(compact.byteLength <= COMPRESSOR_PREVIEW_MAX_BYTES);
  assert.equal(info.width, 600); assert.equal(info.height, 800);
  const { data, info: pixelInfo } = await sharp(compact).raw().toBuffer({resolveWithObject:true});
  const x=Math.floor(1300*600/3024), y=Math.floor(1800*800/4032), offset=(y*pixelInfo.width+x)*pixelInfo.channels;
  assert.ok(data[offset+1]>data[offset]+20,"The power indicator must remain visibly green");
});
test("image decoder rejects missing or invalid original content rather than silently altering evidence", async () => {
  await assert.rejects(compactCompressorIndicator(new Uint8Array()));
  await assert.rejects(compactCompressorIndicator(new Uint8Array([1,2,3,4])));
});
test("authenticated storage proxy prepares compact preview without changing the source hash path", () => {
  const source=fs.readFileSync("src/app/api/storage/[bucket]/[...path]/route.ts","utf8");
  assert.match(source,/canReadPrivateObject/);
  assert.match(source,/compactPreview/);
  assert.match(source,/displayCompressor\(new Uint8Array\(await data\.arrayBuffer\(\)\)\)/);
  assert.match(source,/isCompressor && !archiveCheck/);
  assert.match(source,/verified-private-blob/);
  assert.match(source,/archiveCheck && bucket === REFILL_PHOTO_BUCKET/);
});
test("recent compressor safety evidence can only be archived with separately enabled flags", () => {
  const archive=fs.readFileSync("src/app/api/ops/archive-refill-photo/route.ts","utf8");
  assert.match(archive,/SNACKY_COMPRESSOR_HISTORICAL_COMPACTION_ENABLED/);
  assert.match(archive,/SNACKY_COMPRESSOR_SOURCE_RELEASE_ENABLED/);
  assert.match(archive,/SNACKY_PHOTO_ARCHIVE_RELEASE_ENABLED/);
  assert.match(archive,/isCompactCompressorJob\(job\)/);
  assert.match(archive,/fileAgeEligible\(oldInfo\)\|\|isCompactCompressorJob\(job\)/);
  assert.match(archive,/includeSafety === true/);
  assert.match(archive,/source_version_conflict_before_release/);
  assert.match(archive,/post_delete_archive_integrity_error/);
});

test("all compressor uploads are converted on the server, including uncompressed stale clients",()=>{
 const actions=fs.readFileSync("src/lib/operator-actions.ts","utf8");
 assert.match(actions,/if \(photoPurpose === "compressor"\) \{/);
 assert.match(actions,/compactCompressorIndicator\(new Uint8Array\(await file\.arrayBuffer\(\)\)\)/);
 assert.match(actions,/\.upload\(objectPath, storedFile,/);
 assert.match(actions,/contentType: storedFile\.type/);
 assert.match(actions,/\.digest\("hex"\)/);
 assert.match(actions,/storedFile = new File\(/);
 assert.match(actions,/if \(photoPurpose === "compressor"\) \{[\s\S]*?storedFile = new File\(/);
});
