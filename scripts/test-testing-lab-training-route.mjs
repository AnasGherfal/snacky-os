import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { trainingExpectedFinal, verifyTrainingSelections, trainingBagUsed } from "../src/lib/training-route-simulation.ts";

const s = (code, productId, xyProductId, xyQty, actualAdd = 3, initialQty = 2) => ({
  code, productId, originalProductId: productId, initialQty, actualAdd, xyQty, xyProductId,
});

test("training verifies Coke lanes independently and identifies only mismatched one", () => {
  const result = verifyTrainingSelections([s("001", "cola", "cola", 5), s("003", "cola", "cola", 0)]);
  assert.deepEqual(result.map(v => v.slotCode), ["003"]);
  assert.equal(result[0].reason, "quantity_mismatch");
  assert.equal(result[0].expected, 5);
});

test("matching quantity with wrong snack must show product mismatch", () => {
  const errors = verifyTrainingSelections([s("005", "water", "pepsi", 5)]);
  assert.deepEqual(errors.map(v => v.reason), ["product_mismatch"]);
});

test("photo cannot change initial stock assumption for newly substituted SKU", () => {
  const changed = { ...s("007", "snickers", "snickers", 3), originalProductId: "cola", actualAdd: 3, initialQty: 7 };
  assert.equal(trainingExpectedFinal(changed), 3);
  assert.equal(verifyTrainingSelections([changed]).length, 0);
});

test("bag reconciliation only consumes actual refills from completed stops", () => {
  const used = trainingBagUsed([
    { status: "completed", lanes: [{ productId: "cola", actualAdd: 5 }, { productId: "cola", actualAdd: 4 }] },
    { status: "in_progress", lanes: [{ productId: "cola", actualAdd: 10 }] },
    { status: "completed", lanes: [{ productId: "water", actualAdd: 2 }] },
  ]);
  assert.deepEqual(used, { cola: 9, water: 2 });
});

test("training route uses real MachineStockQuickEditor and guided camera but cannot write real machine", () => {
  const client = fs.readFileSync("src/components/testing-lab/TrainingRouteClient.tsx", "utf8");
  const lab = fs.readFileSync("src/app/admin/testing-lab/TestingLabClient.tsx", "utf8");
  assert.match(client, /<MachineStockQuickEditor/);
  assert.match(client, /<GuidedMachineCamera/);
  assert.match(client, /Confirm pickup/);
  assert.match(client, /Complete Stop/);
  assert.match(client, /Refresh & verify XY/);
  assert.match(client, /Operator bag leftovers/);
  assert.match(client, /Cleaning and final check/);
  assert.match(client, /Cash is recorded separately/);
  assert.match(lab, /<TrainingRouteClient \/>/);
  assert.doesNotMatch(client, /\bfetch\s*\(|setXySlotProduct|uploadRefillProofPhoto|supabase|inventory_movements|xy-final-quantities/);
});

test("AI Analyze button is clickable with a selected photo even if model key is missing", () => {
  const page = fs.readFileSync("src/components/testing-lab/PhotoLibraryAiTest.tsx", "utf8");
  assert.match(page, /disabled=\{!photo \|\| working\}/);
  assert.match(page, /configured === false/);
  assert.match(page, /OPENAI_API_KEY/);
  assert.doesNotMatch(page, /disabled=\{!photo \|\| working \|\| !configured\}/);
});
