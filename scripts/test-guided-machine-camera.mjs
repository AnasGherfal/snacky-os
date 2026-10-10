import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const camera = fs.readFileSync("src/components/operator/GuidedMachineCamera.tsx", "utf8");
const stop = fs.readFileSync("src/app/operator/routes/[id]/stops/[stopId]/page.tsx", "utf8");

test("machine proof offers live rear-camera portrait framing, not an unframed upload only", () => {
  assert.match(camera, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(camera, /facingMode: \{ ideal: "environment" \}/);
  assert.match(camera, /aspect-\[3\/4\]/);
  assert.match(camera, /border-emerald-300/);
  assert.match(camera, /TOP OF MACHINE/);
  assert.match(camera, /BOTTOM VISIBLE/);
  assert.match(camera, /All 4 corners inside the green frame/);
  assert.match(stop, /<GuidedMachineCamera/);
  const testRoute = fs.readFileSync("src/app/operator/verification-test/page.tsx", "utf8");
  assert.match(testRoute, /<GuidedMachineCamera/);
  assert.match(testRoute, /setTestPhotoUrl\(URL.createObjectURL\(file\)\)/);
  assert.doesNotMatch(testRoute, /uploadRefillProofPhoto|setXySlotProduct/);
});

test("capture preserves entire original video image; overlay only guides, not crops", () => {
  assert.match(camera, /canvas\.width = video\.videoWidth/);
  assert.match(camera, /canvas\.height = video\.videoHeight/);
  assert.match(camera, /ctx\.drawImage\(video, 0, 0, canvas\.width, canvas\.height\)/);
  assert.doesNotMatch(camera, /ctx\.drawImage\(video, [^)]*crop/);
});

test("guided capture supports honest image review, retake, and optional lighting warnings", () => {
  assert.match(camera, /analyzeGuidedMachinePhoto/);
  assert.match(camera, /dark/);
  assert.match(camera, /glare/);
  assert.match(camera, /blurry/);
  assert.match(camera, /frameConfirmed/);
  assert.match(camera, /disabled=\{working \|\| !frameConfirmed\}/);
  assert.match(camera, /Retake/);
  assert.match(camera, /previewUrl/);
});

test("camera failure can use native phone capture without losing photo workflow", () => {
  assert.match(camera, /capture="environment"/);
  assert.match(camera, /Live camera could not open/);
  assert.match(camera, /onCaptured\(photoFile\)/);
  assert.match(stop, /saveFinalMachinePhotoImmediately/);
  assert.match(stop, /return false/);
  assert.match(stop, /snacky:machine-photo-persisted/);
});

test("guided image retains finer product packaging detail but stays on existing proof storage path", () => {
  assert.match(stop, /guidedMachinePhoto = file\.name\.startsWith\("snacky-guided-"\)/);
  assert.match(stop, /targetBytes = guidedMachinePhoto \? 2 \* 1024 \* 1024/);
  assert.match(stop, /maxDimension: 2400, quality: 0\.88/);
  assert.match(stop, /uploadRefillProofPhoto\(photoFormData\)/);
  assert.match(stop, /<MachinePhotoRecognitionCard/);
  assert.doesNotMatch(camera, /setXySlotProduct|\/xy-slot-product|inventory_movements/);
});
