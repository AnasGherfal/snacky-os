import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const endpoint = fs.readFileSync("src/app/api/admin/qa-real-route-snapshot/route.ts","utf8");
const loader = fs.readFileSync("src/components/testing-lab/RealMachineRouteLoader.tsx","utf8");
const fixture = fs.readFileSync("src/lib/qa-real-machine-fixture.ts","utf8");
const trainer = fs.readFileSync("src/components/testing-lab/TrainingRouteClient.tsx","utf8");
const page = fs.readFileSync("src/app/operator/routes/qa-real/page.tsx","utf8");
const list = fs.readFileSync("src/app/operator/routes/page.tsx","utf8");

test("loads actual active Snacky machine and product selections without guessing fake XY",()=>{
  assert.match(endpoint, /latest_vms_stock_by_slot/);
  assert.match(endpoint, /\.from\("machines"\)/);
  assert.match(endpoint, /\.from\("products"\)/);
  assert.match(endpoint, /SNK-2509000371/);
  assert.match(endpoint, /SNK-2510001719/);
  assert.match(endpoint, /source: "xy_imported_snapshot_readonly"/);
  assert.match(endpoint, /hasRole\(profile, "owner"\)/);
  assert.doesNotMatch(endpoint, /setXySlotProduct|setXySlot|inventory_movements|\.insert\(|\.upsert\(|\.update\(|readXyMachineLayout/);
});

test("owners access route from real Operator Routes page, not testing lab",()=>{
  assert.match(page, /hasRole\(profile, "owner"\)/);
  assert.match(list, /hasRole\(profile, "owner"\)/);
  assert.match(list, /<OwnerQaRouteCard locale=\{locale\} \/>/);
  const qaCard = fs.readFileSync("src/components/operator/OwnerQaRouteCard.tsx", "utf8");
  assert.match(qaCard, /href="\/operator\/routes\/qa-real"/);
  assert.match(loader, /<TrainingRouteClient/);
  assert.match(loader, /<PhotoLibraryAiTest/);
});

test("real selection snapshot feeds actual operator machine editor with no vendor writes",()=>{
  assert.match(loader, /buildRealMachineTrainingFixture\(body\)/);
  assert.match(fixture, /for \(const slot of machine\.slots\)/);
  assert.match(fixture, /slot\.productId/);
  assert.match(fixture, /slot\.currentQty/);
  assert.match(fixture, /slot\.capacity/);
  assert.match(fixture, /omitted\.push/);
  assert.match(endpoint, /source: "xy_imported_snapshot_readonly"/);
  assert.match(trainer, /<MachineStockQuickEditor/);
  assert.match(trainer, /<GuidedMachineCamera/);
  assert.match(trainer, /const isRealSnapshotTraining = Boolean\(realData\)/);
  assert.match(trainer, /No Smart AI button in this safe test route/);
  assert.doesNotMatch(loader + trainer, /\/xy-slot-product|\/xy-final-quantities|setXySlotProduct|\.from\("inventory_movements"\)/);
  assert.doesNotMatch(loader + trainer, /fetch\(["']https:\/\//);
});

test("each real selection retains its own stock and duplicate SKUs can recur on multiple lanes",()=>{
  assert.match(fixture, /code: slot\.slotCode/);
  assert.match(fixture, /productId, originalProductId: productId/);
  assert.match(fixture, /xyQty: starting/);
  assert.match(fixture, /plannedAdd/);
  assert.match(trainer, /verifyTrainingSelections\(activeStop\.lanes\)/);
  assert.match(trainer, /trainingBagUsed/);
});
