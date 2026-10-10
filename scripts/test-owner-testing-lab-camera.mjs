import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const camera = fs.readFileSync("src/components/testing-lab/GuidedMachineCamera.tsx", "utf8");
const client = fs.readFileSync("src/app/admin/testing-lab/TestingLabClient.tsx", "utf8");
const training = fs.readFileSync("src/components/testing-lab/TrainingRouteClient.tsx", "utf8");
const page = fs.readFileSync("src/app/admin/testing-lab/page.tsx", "utf8");
const sidebar = fs.readFileSync("src/components/Sidebar.tsx", "utf8");
const admin = fs.readFileSync("src/app/admin/page.tsx", "utf8");

test("guided camera frame, no cropping, photo preview and mobile fallback", () => {
  assert.match(camera, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(camera, /facingMode: \{ ideal: "environment" \}/);
  assert.match(camera, /aspect-\[3\/4\]/);
  assert.match(camera, /border-emerald-300/);
  assert.match(camera, /selectionRowCount/);
  assert.match(camera, /TOP OF MACHINE/);
  assert.match(camera, /BOTTOM VISIBLE/);
  assert.match(camera, /All 4 corners inside the green frame/);
  assert.match(camera, /canvas\.width = video\.videoWidth/);
  assert.match(camera, /canvas\.height = video\.videoHeight/);
  assert.match(camera, /ctx\.drawImage\(video, 0, 0, canvas\.width, canvas\.height\)/);
  assert.match(camera, /Retake/);
  assert.match(camera, /capture="environment"/);
});
test("testing lab displays safe camera and mock route, never sends actual XY commands", () => {
  assert.match(training, /<GuidedMachineCamera/);
  assert.match(training, /setPhotoUrl\(URL\.createObjectURL\(file\)\)/);
  assert.match(client, /<PhotoLibraryAiTest/);
  assert.match(client, /<TrainingRouteClient/);
  assert.match(training, /verifyTrainingSelections/);
  assert.match(training, /<MachineStockQuickEditor/);
  assert.doesNotMatch(client, /setXySlotProduct|\/xy-slot-product|inventory_movements|uploadRefillProofPhoto|\/xy-final-quantities/);
});
test("testing lab is visible and accessible only to an active owner", () => {
  assert.match(page, /hasRole\(profile, "owner"\)/);
  assert.match(page, /profile\.active_status !== "active"/);
  assert.match(sidebar, /ownerTestingLabItem/);
  assert.match(sidebar, /hasRole\(context, "owner"\)/);
  assert.match(admin, /item\.href !== "\/admin\/testing-lab" \|\| hasRole\(profile, "owner"\)/);
});
