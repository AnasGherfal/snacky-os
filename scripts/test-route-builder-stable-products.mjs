import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "src/app/routes/new/RouteCreateForm.tsx"), "utf8");

test("editing a route product quantity keeps that product in the same manual-item position", () => {
  assert.match(source, /const existingIndex = current\.findIndex/);
  assert.match(source, /next\[existingIndex\] = \{ \.\.\.next\[existingIndex\], quantity: safeQuantity \}/);
  assert.doesNotMatch(source, /const next = current\.filter\(\(item\) => !\(item\.machineId === machineId && item\.productId === productId\)\)[\s\S]{0,220}next\.push/);
});

test("the route product catalog has the same complete active-product source for every machine", () => {
  assert.match(source, /const stableMachineProductCatalog = useMemo/);
  assert.match(source, /return products[\s\S]*\.map\(\(product\) =>/);
  assert.match(source, /All active products — same order for every machine/);
  assert.match(source, /products are never hidden just because another machine uses a different setup/);
  assert.doesNotMatch(source, /stableMachineProductCatalog[\s\S]{0,300}\.slice\(0,/);
});

test("machine-specific signals label products without changing the catalog order", () => {
  assert.match(source, /candidate\.sourceKinds\.has\("planogram"\)/);
  assert.match(source, /candidate\.recommendedQty > 0/);
  assert.match(source, /comparePickupProductRows/);
  assert.doesNotMatch(source, /selectedDifference = b\.selectedQty/);
  assert.doesNotMatch(source, /recommendationDifference = b\.recommendedQty/);
});

test("quantities are edited inline on a stable product card", () => {
  assert.match(source, /data-route-product-id=\{candidate\.product\.id\}/);
  assert.match(source, /aria-label=\{tr\(locale, `\$\{candidate\.product\.name\} quantity`/);
  assert.match(source, /setDesiredManualQty\(selectedManualMachineId, candidate\.product\.id, selectedQty \+ 1\)/);
  assert.match(source, /Use suggested \$\{candidate\.recommendedQty\}/);
});

test("non-blocking planning warnings are consolidated instead of stacked", () => {
  assert.match(source, /const planningWarnings = Array\.from\(new Set/);
  assert.match(source, /Planning notice/);
  assert.doesNotMatch(source, /availabilityWarnings\.map\(\(warning\) => <li key=\{warning\}>/);
});

test("normal quantity clamping does not throw a global route-builder warning", () => {
  const start = source.indexOf("const setDesiredManualQty");
  const end = source.indexOf("const addProductQty", start);
  const block = source.slice(start, end);
  assert.match(block, /const safeTotal = Math\.min/);
  assert.doesNotMatch(block, /Only \$\{availableForMachine\} units remain/);
});
