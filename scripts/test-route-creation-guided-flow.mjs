import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "src/app/routes/new/RouteCreateForm.tsx"), "utf8");
const patchSource = fs.readFileSync(path.join(repoRoot, "scripts/apply-unified-route-builder-patch.mjs"), "utf8");

test("route creation is a resumable details, machines, products, review flow", () => {
  assert.match(source, /type RouteBuilderStep = "details" \| "machines" \| "products" \| "review"/);
  assert.match(source, /builderStep: RouteBuilderStep/);
  assert.match(source, /Route creation progress/);
  assert.match(source, /Review route before creating/);
  assert.match(source, /builderStep === "review"[\s\S]*type="submit"/);
});

test("one machine selection controls the scoped product picker without ghost products", () => {
  assert.match(source, /Tap a machine once to include it\. There is no second machine selector later\./);
  assert.match(source, /toggleRouteMachine/);
  assert.match(source, /setManualStopItems\(\(current\) => current\.filter\(\(item\) => item\.machineId !== machineId\)\)/);
  assert.match(source, /machines\.filter\(\(machine\) => machineIds\.includes\(machine\.id\)\)/);
});

test("suggested quantities and machine review are available before create", () => {
  assert.match(source, /applySuggestedQuantities/);
  assert.match(source, /Use suggested quantities/);
  assert.match(source, /Add suggestions for selected machines/);
  assert.match(source, /This machine has no products\. It will still be included as a planned stop\./);
});

test("the existing route API payload and stock validation remain canonical", () => {
  assert.match(source, /fetch\("\/api\/routes"/);
  assert.match(source, /manualStopItems: creationMode === "full" \? manualStopItems : \[\]/);
  assert.match(source, /recommendationFinalTakeQty/);
  assert.match(source, /const issues = validateStock\(\)/);
});

test("the legacy prebuild transform recognizes the committed guided builder", () => {
  assert.match(patchSource, /Guided route builder is already applied/);
  assert.match(patchSource, /type RouteBuilderStep/);
  assert.match(patchSource, /process\.exit\(0\)/);
});
