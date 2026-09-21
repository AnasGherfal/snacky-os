import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { availableRouteStockForMachine, remainingRouteStock } from "../src/lib/route-stock-allocation.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "src/app/routes/new/RouteCreateForm.tsx"), "utf8");
const pageSource = fs.readFileSync(path.join(repoRoot, "src/app/routes/new/page.tsx"), "utf8");
const apiSource = fs.readFileSync(path.join(repoRoot, "src/app/api/routes/route.ts"), "utf8");
const inventoryPageSource = fs.readFileSync(path.join(repoRoot, "src/app/inventory/page.tsx"), "utf8");
const restockLoaderSource = fs.readFileSync(path.join(repoRoot, "src/lib/restock-priority-data.ts"), "utf8");
const resilienceMigration = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20260827153537_route_builder_timeout_resilience.sql"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

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

test("production builds use committed source without runtime patch scripts", () => {
  assert.doesNotMatch(packageJson.scripts.prebuild, /scripts\/apply-/);
  assert.doesNotMatch(packageJson.scripts["test:stop-zero-return"], /scripts\/apply-/);
});

test("stale VMS stock cannot silently populate route quantities", () => {
  assert.match(pageSource, /STOCK_SNAPSHOT_MAX_AGE_MS = 72 \* 60 \* 60 \* 1000/);
  assert.match(pageSource, /stale_stock_snapshot/);
  assert.match(source, /staleRecommendationMachineIds/);
  assert.match(source, /Import a fresh VMS stock snapshot before using automatic quantities/);
  assert.match(source, /!staleRecommendationMachineIds\.has\(machineId\)/);
});

test("optional planning timeouts never replace the route builder", () => {
  assert.match(pageSource, /const blockingQueryIssues = queryIssues\.filter\(\(issue\) => issue\.key === "machines"\)/);
  assert.doesNotMatch(pageSource, /if \(queryIssues\.length\)/);
  assert.match(source, /const planningWarnings = Array\.from\(new Set/);
  assert.match(source, /Planning notice/);
  assert.match(pageSource, /fullRouteAvailable=\{!productsError && !storageError\}/);
  assert.match(source, /Storage quantities must be verified before products can be assigned/);
  assert.match(source, /if \(!storageKnown \|\| storageAvailable <= 0\) return 0/);
});

test("storage is allocated once across every machine in the route", () => {
  const waterForMachineA = [{ machineId: "machine-a", productId: "water", quantity: 10 }];
  assert.equal(remainingRouteStock(waterForMachineA, "water", 10), 0);
  assert.equal(availableRouteStockForMachine(waterForMachineA, "water", "machine-b", 10), 0);
  assert.equal(availableRouteStockForMachine(waterForMachineA, "water", "machine-a", 10), 10);

  const splitWater = [
    { machineId: "machine-a", productId: "water", quantity: 6 },
    { machineId: "machine-b", productId: "water", quantity: 4 },
  ];
  assert.equal(remainingRouteStock(splitWater, "water", 10), 0);
  assert.equal(availableRouteStockForMachine(splitWater, "water", "machine-a", 10), 6);
  assert.equal(availableRouteStockForMachine(splitWater, "water", "machine-b", 10), 4);
});

test("manual product controls display and enforce machine-specific remaining stock", () => {
  assert.match(source, /availableStockForMachine/);
  assert.match(source, /Available for this machine/);
  assert.match(source, /Unassigned after route/);
  assert.match(source, /availableForMachine <= 0/);
  assert.match(source, /const safeTotal = Math\.min\(unitQuantity\(desiredManual\), maxTotal\)/);
  assert.match(source, /max=\{storageKnown \? available : 0\}/);
});

test("route creation fails closed when stock cannot be verified", () => {
  assert.match(apiSource, /function isStatementTimeout/);
  assert.match(apiSource, /Storage quantities could not be verified in time\. Retry, or create a stops-only route\./);
  assert.doesNotMatch(apiSource, /validationDeferred: true/);
  assert.match(apiSource, /const planningReadClient = getSupabaseAdminClient\(\) \?\? supabase/);
  assert.match(apiSource, /validateRouteStock\(planningReadClient, stockByProduct\)/);
});

test("inventory failures cannot masquerade as zero stock", () => {
  assert.match(restockLoaderSource, /getSupabaseAdminClient\(\) \?\? supabase/);
  assert.match(restockLoaderSource, /from\("route_storage_stock_by_product"\)/);
  assert.match(restockLoaderSource, /storageLoaded: !storage\.error/);
  assert.match(inventoryPageSource, /if \(!restockResult\.storageLoaded\)/);
  assert.match(inventoryPageSource, /no missing result is being shown as zero/i);
});

test("route planning uses narrow storage balances and the latest active VMS batch", () => {
  assert.match(pageSource, /from\("route_storage_stock_by_product"\)/);
  assert.match(apiSource, /from\("route_storage_stock_by_product"\)/);
  assert.match(resilienceMigration, /create or replace view public\.route_storage_stock_by_product/);
  assert.match(resilienceMigration, /with latest_batch as/);
  assert.match(resilienceMigration, /join latest_batch lb on lb\.id = vss\.import_batch_id/);
  assert.match(resilienceMigration, /security_invoker = true/);
  assert.match(resilienceMigration, /revoke all on table public\.refill_recommendations from public, anon/);
});


test("manual quantity edits keep their row position instead of moving to the bottom", () => {
  const setterStart = source.indexOf("const setManualStopQty");
  const setterEnd = source.indexOf("const setDesiredManualQty", setterStart);
  assert.notEqual(setterStart, -1);
  assert.notEqual(setterEnd, -1);
  const setterSource = source.slice(setterStart, setterEnd);

  assert.match(setterSource, /const existingIndex = current\.findIndex/);
  assert.match(setterSource, /next\[existingIndex\] = \{ \.\.\.next\[existingIndex\], quantity: safeQuantity \}/);
  assert.match(setterSource, /existingIndex < 0 \? current : current\.filter/);
});

test("the machine product picker shows one complete stable active-product catalog", () => {
  const pickerStart = source.indexOf("const stableMachineProductCatalog");
  const pickerEnd = source.indexOf("const toggleValue", pickerStart);
  assert.notEqual(pickerStart, -1);
  assert.notEqual(pickerEnd, -1);
  const pickerSource = source.slice(pickerStart, pickerEnd);

  assert.match(pickerSource, /return products/);
  assert.match(pickerSource, /const visibleMachineProductCatalog/);
  assert.doesNotMatch(pickerSource, /\.slice\(0,/);
});

test("route creation shows assignment completeness per selected machine", () => {
  assert.match(source, /unresolvedRequiredCount/);
  assert.match(source, /refill products assigned/);
  assert.match(source, /missing/);
  assert.match(source, /no automatic refill pending/);
});

test("non-blocking route planning notices are compact and deduplicated", () => {
  assert.match(source, /const planningWarnings = Array\.from\(new Set/);
  assert.match(source, /xyRefreshStatus === "warning"/);
  assert.match(source, /<details className="rounded-xl border border-amber-200/);
  assert.match(source, /Planning notice/);
});

test("manual overages clamp to verified stock without stacking another global warning", () => {
  const setterStart = source.indexOf("const setDesiredManualQty");
  const setterEnd = source.indexOf("const addProductQty", setterStart);
  assert.notEqual(setterStart, -1);
  assert.notEqual(setterEnd, -1);
  const setterSource = source.slice(setterStart, setterEnd);

  assert.match(setterSource, /const safeTotal = Math\.min\(unitQuantity\(desiredManual\), maxTotal\)/);
  assert.doesNotMatch(setterSource, /Only \$\{availableForMachine\} units remain available/);
});
