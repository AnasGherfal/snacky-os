import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/202607180001_route_stop_compressor_safety.sql");
const safetyApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/safety-check/route.ts");
const safetyCard = read("src/components/operator/CompressorSafetyProofCard.tsx");
const quickActions = read("src/components/operator/RouteStopQuickActions.tsx");
const routePage = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
const operatorActions = read("src/lib/operator-actions.ts");
const manualSection = read("src/components/operator/ManualRouteSalesSection.tsx");
const manualApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts");
const adjustmentApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/adjustments/route.ts");
const activityPage = read("src/app/reports/route-product-activity/page.tsx");
const operationalSales = read("src/components/OperationalSalesSummary.tsx");
const salesPage = read("src/app/sales/page.tsx");
const tabs = read("src/components/module-tabs-config.ts");

test("compressor safety migration is additive and requires photo evidence", () => {
  assert.match(migration, /create table if not exists public\.route_stop_safety_checks/i);
  assert.match(migration, /constraint route_stop_safety_checks_stop_unique unique \(route_stop_id\)/i);
  assert.match(migration, /compressor_confirmed = false/i);
  assert.match(migration, /proof_photo_url/i);
  assert.match(migration, /proof_photo_path/i);
  assert.doesNotMatch(migration, /truncate\s+table|drop\s+table\s+public\.(routes|route_stops|inventory_movements)|delete\s+from\s+public\.(routes|route_stops|inventory_movements)/i);
});

test("compressor proof API verifies route access and refuses checkbox-only confirmation", () => {
  assert.match(safetyApi, /buildOperatorRouteAccessContext/);
  assert.match(safetyApi, /canAccessOperatorRoute/);
  assert.match(safetyApi, /COMPRESSOR_NOT_CONFIRMED/);
  assert.match(safetyApi, /PROOF_REQUIRED/);
  assert.match(safetyApi, /upsert\(row, \{ onConflict: "route_stop_id" \}\)/);
  assert.match(safetyApi, /installed: false/);
});

test("operator must save a camera photo showing compressor ON after refill", () => {
  assert.match(safetyCard, /Compressor switched ON/);
  assert.match(safetyCard, /After filling, switch the compressor back on/);
  assert.match(safetyCard, /capture="environment"/);
  assert.match(safetyCard, /uploadRefillProofPhoto/);
  assert.match(safetyCard, /\/safety-check/);
  assert.match(safetyCard, /I switched the compressor ON and verified the machine is running/);
});

test("current route completion endpoint and payload remain intact", () => {
  assert.match(routePage, /fetchWithTimeout\(`\/api\/operator\/routes\/\$\{routeId\}\/stops\/\$\{stopId\}`/);
  assert.match(routePage, /clientSubmissionId:\s*clientSubmissionIdRef\.current/);
  assert.match(routePage, /filledItems:\s*stopData\.refillItems\.map/);
  assert.match(routePage, /extraItems:\s*extraProducts/);
  assert.match(routePage, /missingProducts:\s*missingReports/);
  assert.match(routePage, /CompressorSafetyProofCard/);
  assert.match(routePage, /compressorReadyForSubmit/);
  assert.match(routePage, /Save the compressor ON photo before completing this stop/);
});

test("server completion enforces compressor proof only after setup exists", () => {
  assert.match(operatorActions, /from\("route_stop_safety_checks"\)/);
  assert.match(operatorActions, /isMissingTable\(compressorProofError, "route_stop_safety_checks"\)/);
  assert.match(operatorActions, /Save the compressor ON photo before completing this stop/);
  assert.match(operatorActions, /machine_refill_history/);
  assert.match(operatorActions, /operator_bag_to_machine/);
});

test("quick buttons open only the requested searchable form", () => {
  for (const marker of ["snacky:open-manual-sale", "snacky:open-inventory-adjustment", "damaged", "returned_from_machine"]) {
    assert.match(quickActions, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(manualSection, /id="manual-route-sales"/);
  assert.match(manualSection, /window\.addEventListener\("snacky:open-manual-sale"/);
  assert.match(routePage, /id="inventory-adjustments"/);
  assert.match(routePage, /activeAdjustmentType/);
  assert.match(routePage, /Choose Damaged or Return from machine/);
  assert.doesNotMatch(routePage, /<div className="mt-4 grid gap-4 xl:grid-cols-2">\s*<InventoryAdjustmentForm/s);
});

test("product activity dashboard explains sales, damage, returns, and safety proof", () => {
  assert.match(activityPage, /from\("route_manual_sales"\)/);
  assert.match(activityPage, /from\("inventory_adjustments"\)/);
  assert.match(activityPage, /from\("route_stop_safety_checks"\)/);
  assert.match(activityPage, /pending_storage_confirmation/);
  assert.match(activityPage, /Stock movement posted/);
  assert.match(activityPage, /awaiting storage return/);
  assert.match(activityPage, /Combined total sales/);
  assert.match(activityPage, /Damaged products/);
  assert.match(activityPage, /Compressor safety compliance/);
  assert.match(tabs, /label:\s*"Product Activity",\s*href:\s*"\/reports\/route-product-activity"/);
});

test("confirmed route-entered sales are added visibly to VMS totals without rewriting VMS", () => {
  assert.match(operationalSales, /from\("route_manual_sales"\)/);
  assert.match(operationalSales, /\.eq\("status", "confirmed"\)/);
  assert.match(operationalSales, /props\.vmsRevenue \+ enteredRevenue/);
  assert.match(operationalSales, /props\.vmsUnits \+ enteredUnits/);
  assert.match(operationalSales, /inventory_movement_id/);
  assert.match(salesPage, /OperationalSalesSummary/);
  assert.match(salesPage, /vmsRevenue=\{summary\.revenueAmount\}/);
  assert.match(salesPage, /vmsUnits=\{summary\.successfulUnitsSold\}/);
});

test("manual sales and adjustment saves refresh the new dashboards", () => {
  assert.match(manualApi, /revalidatePath\("\/sales"\)/);
  assert.match(manualApi, /revalidatePath\("\/reports\/route-product-activity"\)/);
  assert.match(adjustmentApi, /revalidatePath\("\/reports\/route-product-activity"\)/);
});

test("feature does not modify pickup RPC contracts", () => {
  for (const source of [migration, safetyApi, safetyCard, quickActions, routePage, activityPage, operationalSales]) {
    assert.doesNotMatch(source, /create or replace function public\.snacky_confirm_route_pickup|drop function.*snacky_confirm_route_pickup/is);
  }
});
