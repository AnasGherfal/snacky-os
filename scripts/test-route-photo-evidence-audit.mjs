import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDuplicateProofImage, photoEvidenceFingerprint } from "../src/lib/route-photo-evidence.ts";

const first="routeX/stopA-fa75bd28ca3cd36e7765a632.jpg";
const compressor="routeX/stopA-f6c6238a27ad489117442dfd.jpg";

test("different completion and compressor photos are independent",()=>{
  assert.equal(isDuplicateProofImage({storagePath:compressor},{storagePath:first}),false);
  assert.equal(photoEvidenceFingerprint(compressor),"f6c6238a27ad489117442dfd");
});
test("same storage object under two labels is flagged, even across URL/path notation",()=>{
  assert.equal(isDuplicateProofImage({storagePath:compressor},{storagePath:compressor}),true);
  assert.equal(isDuplicateProofImage({storagePath:compressor},{url:compressor}),true);
});
test("identical image bytes copied to different purposes with same SHA digest are flagged",()=>{
  const legacy="routeX/stopA-01f83eeaf8f2b4dc8eab7a6f.webp";
  const separate="routeX/compressor/stopA-01f83eeaf8f2b4dc8eab7a6f.webp";
  assert.equal(isDuplicateProofImage({storagePath:separate},{storagePath:legacy}),true);
  assert.equal(isDuplicateProofImage({storagePath:separate},{storagePath:first}),false);
});
test("no evidence does not become a false alert",()=>{
  assert.equal(isDuplicateProofImage({storagePath:null},{storagePath:first}),false);
  assert.equal(isDuplicateProofImage({url:""},{storagePath:first}),false);
});
test("UI shows warning rather than treating upload as image verification",()=>{
  const ui=fs.readFileSync("src/components/RouteCompletionImages.tsx","utf8");
  assert.match(ui,/isDuplicateProofImage\(compressor, completion\)/);
  assert.match(ui,/Photo evidence warning/);
  assert.match(ui,/This does NOT prove the operator/);
  assert.match(ui,/Proof saved/);
  assert.doesNotMatch(ui, /"Verified"<\/span>/);
});
