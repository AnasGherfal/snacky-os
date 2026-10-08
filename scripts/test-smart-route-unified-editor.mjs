import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root,name),"utf8");
const planner = read("src/lib/smart-route-planner.ts");
const endpoint = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-final-quantities/route.ts");
const worker = read("src/lib/xy-stop-quantity-sync.ts");
const stop = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
const admin = read("src/app/routes/[id]/page.tsx");
const migration = read("supabase/migrations/20261009010000_xy_selection_price_and_stock_edits.sql");

test("Smart Route keeps inventory failures fatal while optional signals fail softly", () => {
  assert.match(planner,/ensureFreshXyRoutePlanningData\(\)\.catch/);
  assert.match(planner,/ensureFreshXyLiveSales\(\{ maxAgeMs: 90 \* 60 \* 1000 \}\)\.catch/);
  assert.match(planner,/const essentialFailures =/);
  assert.match(planner,/const optionalFailures =/);
  assert.match(planner,/compactPlanWarnings/);
  assert.match(planner,/physical.*Hidden/i);
  assert.match(planner,/No route or stock/);
  assert.doesNotMatch(planner,/Smart planning data is incomplete:/);
});

test("Machine layout editor is primary while advanced XY layout remains accessible", () => {
  assert.match(stop,/MachineStockQuickEditor/);
  assert.match(stop,/showAdvancedLayout/);
  assert.match(stop,/Advanced: see full XY layout and move lanes/);
  assert.match(stop,/selectionPrices/);
  assert.match(stop,/prices=\{selectionPrices\}/);
  assert.match(stop,/onPriceChange=\{setSelectionPrices\}/);
  assert.match(stop,/onChangeProduct/);
  assert.match(stop,/selectionCodes = new Set/);
  assert.match(stop,/priceLyd: selectionPrices\[slotCode\]/);
});

test("Both stock and price are edited by individual selection with visible feedback", () => {
  assert.match(editor,/updateOne/);
  assert.match(editor,/updatePrice/);
  assert.match(editor,/setWholeRow/);
  assert.match(editor,/setFeedback/);
  assert.match(editor,/Change product/);
  assert.match(editor,/Price \(LYD\)/);
  assert.match(editor,/role="status"/);
  assert.match(editor,/Object\.hasOwn\(values, slot\.slotCode\)/);
});

test("Price only edits never imply physical stock moves", () => {
  assert.match(endpoint,/const hasStock =/);
  assert.match(endpoint,/const hasPrice =/);
  assert.match(endpoint,/const priceBySlot =/);
  assert.match(endpoint,/update_stock: finalQty !== null/);
  assert.match(endpoint,/target_qty: finalQty \?\? baselineQty/);
  assert.match(endpoint,/xy_hidden_machine_selections/);
  assert.match(worker,/row\.update_stock \? row\.target_qty : current\.currentQty/);
  assert.match(worker,/row\.expected_price_lyd/);
  assert.match(worker,/verifyXySlot/);
  assert.doesNotMatch(endpoint,/inventory_movements|operator_bag_to_machine/);
  assert.match(migration,/update_stock boolean not null default true/);
});

test("Admin can see price stock and sync state in same route table", () => {
  assert.match(admin,/target_price_lyd/);
  assert.match(admin,/Stock: XY/);
  assert.match(admin,/Price: XY/);
});
