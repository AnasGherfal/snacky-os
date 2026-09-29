import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const syncSource = fs.readFileSync(new URL("../src/lib/xy-vms-sync.ts", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/app/routes/new/RouteCreateForm.tsx", import.meta.url), "utf8");
const cronSource = fs.readFileSync(new URL("../src/app/api/cron/xy-vms/route.ts", import.meta.url), "utf8");
const backgroundSyncSource = fs.readFileSync(new URL("../src/components/XyBackgroundSync.tsx", import.meta.url), "utf8");
const shellSource = fs.readFileSync(new URL("../src/components/ShellChrome.tsx", import.meta.url), "utf8");
const dashboardSource = fs.readFileSync(new URL("../src/app/dashboard/page.tsx", import.meta.url), "utf8");
const refillsSource = fs.readFileSync(new URL("../src/app/refills/page.tsx", import.meta.url), "utf8");
const schedulerMigration = fs.readFileSync(new URL("../supabase/migrations/20260902150000_xy_vms_durable_scheduler.sql", import.meta.url), "utf8");
const vercelConfig = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

test("XY catalogue changes only matched products and preserves both prices", () => {
  assert.doesNotMatch(syncSource, /createMissingXyProductFromRow/);
  assert.match(syncSource, /vms_selling_price_lyd: identity\.sellingPrice/);
  assert.match(syncSource, /vms_cost_price_lyd: identity\.costPrice/);
  assert.match(syncSource, /current_selling_price_lyd: identity\.sellingPrice/);
  assert.match(syncSource, /current_cost_price_lyd: identity\.costPrice/);
});

test("configured XY lanes update the planogram and placeholders are skipped", () => {
  assert.match(syncSource, /lane\.kind === "placeholder"/);
  assert.match(syncSource, /from\("machine_slots"\)\.upsert\(chunk, \{ onConflict: "machine_id,slot_code" \}\)/);
  assert.match(syncSource, /slot_code: lane\.slotCode/);
  assert.match(syncSource, /par_qty: capacity/);
  assert.match(syncSource, /id: existingSlot\?\.id \?\? randomUUID\(\)/);
  assert.doesNotMatch(syncSource, /\.\.\.\(existingSlot\?\.id \? \{ id: existingSlot\.id \} : \{\}\)/);
  assert.ok(
    syncSource.indexOf("const activation = assessXyLaneSnapshot") < syncSource.indexOf("if (activationEligible && machineSlotUpserts.length)"),
    "planogram writes must happen only after the complete-snapshot safety decision",
  );
});

test("route creation refreshes and allocates XY quantities automatically", () => {
  assert.match(routeSource, /refreshXyRoutePlanningDataAction\(\)/);
  assert.match(routeSource, /result\.outcome === "in_progress"/);
  assert.match(routeSource, /applySuggestedQuantities\(\[machineId\], nextMachineIds\)/);
  assert.match(routeSource, /Current \$\{lane\.currentQty\} \/ Capacity \$\{lane\.capacity\} \/ Bring \$\{lane\.neededQty\}/);
  assert.match(routeSource, /Storage shortage — choose what to do/);
  assert.match(routeSource, /Make original 0/);
  assert.match(routeSource, /Swap from storage/);
});

test("unattended XY sync is protected and scheduled outside the browser", () => {
  assert.match(cronSource, /process\.env\.CRON_SECRET/);
  assert.match(cronSource, /authorization/);
  assert.match(cronSource, /SUPABASE_SCHEDULER_TOKEN_SHA256/);
  assert.match(cronSource, /ensureFreshXyRoutePlanningData\(\)/);
  assert.match(cronSource, /export const POST = refreshXy/);
  assert.doesNotMatch(cronSource, /syncXyAll\(\)/);
  assert.deepEqual(vercelConfig.crons, [{ path: "/api/cron/xy-vms", schedule: "0 4 * * *" }]);
  assert.match(schedulerMigration, /vault\.decrypted_secrets/);
  assert.match(schedulerMigration, /snacky-xy-vms-hourly/);
  assert.match(schedulerMigration, /'7 \* \* \* \*'/);
  assert.match(schedulerMigration, /timeout_milliseconds => 180000/);
  assert.match(schedulerMigration, /idx_vms_sync_runs_one_running_xy_import/);
});

test("authorized planners refresh XY in the background without pressing sync", () => {
  assert.match(backgroundSyncSource, /refreshXyRoutePlanningDataAction\(\)/);
  assert.match(backgroundSyncSource, /30 \* 60 \* 1000/);
  assert.match(backgroundSyncSource, /visibilitychange/);
  assert.match(shellSource, /hasPermission\(profile, "routes\.create"\)/);
  assert.match(shellSource, /<XyBackgroundSync enabled=\{canRefreshXy\}/);
  assert.match(backgroundSyncSource, /routerRef\.current\.refresh\(\)/);
  assert.match(backgroundSyncSource, /result\.outcome === "in_progress"/);
  assert.match(syncSource, /latestDisplayedXyStockSnapshot\(supabase\)/);
  assert.doesNotMatch(syncSource, /const latestStock = latestCompleted\(\["machine_goods", "all"\]\)/);
  assert.match(syncSource, /activationEligible/);
  assert.match(syncSource, /"partially_imported"/);
  assert.match(dashboardSource, /\.eq\("source_provider", "xy"\)/);
  assert.match(refillsSource, /\.eq\("source_provider", "xy"\)/);
  assert.match(dashboardSource, /vms_import_batches!inner/);
  assert.match(refillsSource, /vms_import_batches!inner/);
});
