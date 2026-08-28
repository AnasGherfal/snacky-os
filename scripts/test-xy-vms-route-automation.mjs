import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const syncSource = fs.readFileSync(new URL("../src/lib/xy-vms-sync.ts", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/app/routes/new/RouteCreateForm.tsx", import.meta.url), "utf8");
const cronSource = fs.readFileSync(new URL("../src/app/api/cron/xy-vms/route.ts", import.meta.url), "utf8");
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
});

test("route creation refreshes and allocates XY quantities automatically", () => {
  assert.match(routeSource, /refreshXyRoutePlanningDataAction\(\)/);
  assert.match(routeSource, /applySuggestedQuantities\(\[machineId\], nextMachineIds\)/);
  assert.match(routeSource, /Current \$\{lane\.currentQty\} \/ Capacity \$\{lane\.capacity\} \/ Bring \$\{lane\.neededQty\}/);
  assert.match(routeSource, /Storage shortage — choose what to do/);
  assert.match(routeSource, /Make original 0/);
  assert.match(routeSource, /Swap from storage/);
});

test("unattended XY sync requires a protected cron secret", () => {
  assert.match(cronSource, /process\.env\.CRON_SECRET/);
  assert.match(cronSource, /authorization/);
  assert.deepEqual(vercelConfig.crons, [{ path: "/api/cron/xy-vms", schedule: "0 4 * * *" }]);
});
