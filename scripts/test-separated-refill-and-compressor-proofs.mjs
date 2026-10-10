import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const actions = fs.readFileSync("src/lib/operator-actions.ts", "utf8");
const card = fs.readFileSync("src/components/operator/CompressorSafetyProofCard.tsx", "utf8");
const completionPage = fs.readFileSync("src/app/operator/routes/[id]/stops/[stopId]/page.tsx", "utf8");
const safetyApi = fs.readFileSync("src/app/api/operator/routes/[id]/stops/[stopId]/safety-check/route.ts", "utf8");

const start = actions.indexOf("export async function uploadRefillProofPhoto");
const end = actions.indexOf("export async function uploadInventoryAdjustmentPhoto",start);
assert(start !== -1 && end > start);
const upload = actions.slice(start,end);

test("compressor explicitly signals its own proof type; completion never uses it", () => {
  assert.match(card, /photoFormData\.append\("photoPurpose", "compressor"\)/);
  assert.doesNotMatch(completionPage, /photoFormData\.append\("photoPurpose", "compressor"\)/);
  assert.match(upload, /formData\.get\("photoPurpose"\) \|\| "completion"/);
  assert.match(upload, /if \(photoPurpose !== "completion" && photoPurpose !== "compressor"\)/);
});

test("different independent storage keys for compressor and completion on the SAME stop", () => {
  assert.match(upload, /photoPurpose === "compressor"[\s\S]*?\$\{routeId\}\/compressor\/\$\{objectName\}/);
  assert.match(upload, /photoPurpose === "compressor" \? "compressor\/" : ""/);
  assert.match(upload, /photoDigest = createHash\("sha256"\)/);
});

test("compressor file can never overwrite machine_refill_history final photo pointer", () => {
  const compressorBranch=upload.indexOf('if (photoPurpose === "compressor") {');
  const returnInside=upload.indexOf('return {',compressorBranch);
  const proofHistoryWrite=upload.indexOf('.from("machine_refill_history")');
  assert(compressorBranch >= 0);
  assert(returnInside > compressorBranch && returnInside < proofHistoryWrite);
  assert.match(upload.slice(compressorBranch,proofHistoryWrite), /persisted: false/);
  assert.doesNotMatch(upload.slice(0,proofHistoryWrite), /\.from\("machine_refill_history"\)/);
  assert.match(upload.slice(proofHistoryWrite), /\.upsert\(/);
  assert.match(safetyApi,/\.from\("route_stop_safety_checks"\)[\s\S]*?\.upsert\(/);
});

test("storage upload stays authenticated and scope-bound to the selected route stop machine",()=>{
  assert.match(upload,/canAccessOperatorRoute\(routeAccessProfile, route\.operator_id\)/);
  assert.match(upload,/stop\.route_id !== routeId \|\| stop\.machine_id !== machineId/);
  assert.match(upload,/REFILL_PHOTO_BUCKET/);
});
