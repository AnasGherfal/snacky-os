import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("saving the final machine photo updates persisted state without reloading the page", () => {
  const source = read("src/components/operator/RouteStopQuickActions.tsx");
  assert.match(source, /snacky:machine-photo-save-no-reload/);
  assert.match(source, /snacky:machine-photo-persisted/);
  assert.doesNotMatch(source, /window\.location\.reload\(\)/);
});

test("manual sales use the full supplied product catalog", () => {
  const source = read("src/components/operator/ManualRouteSalesSection.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  assert.match(source, /const productChoices = allProducts;/);
  assert.doesNotMatch(source, /\.slice\(0,\s*24\)/);
  assert.match(api, /from\("products"\)/);
  assert.match(api, /\.eq\("active", true\)/);
  assert.match(api, /manualSaleProductOptions/);
});

test("stop inventory is committed once and an explicit zero stays in route custody", () => {
  const source = read("src/lib/operator-actions.ts");
  const start = source.indexOf("export async function completeStop");
  const end = source.indexOf("\nexport async function ", start + 1);
  assert.notEqual(start, -1, "completeStop must exist");
  const completeStop = source.slice(start, end === -1 ? source.length : end);

  assert.match(completeStop, /snacky_commit_route_stop_inventory_v1/);
  assert.match(completeStop, /p_fill_lines/);
  assert.doesNotMatch(completeStop, /zeroFillLedgerClient/);
  assert.doesNotMatch(completeStop, /route_stop_zero_fill_return/);
  assert.doesNotMatch(completeStop, /reason:\s*returning\s*\?\s*"operator_bag_to_storage"/);
});

test("terminal stop outcomes stay reachable and use Arabic status labels", () => {
  const route = read("src/app/operator/routes/[id]/page.tsx");
  const stop = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const arabic = read("src/lib/i18n/ar.ts");
  const compactRoute = route.replace(/\s+/g, " ");

  assert.match(
    compactRoute,
    /isRouteStopDoneStatus\(stop\.status\) \? \( <div className="mt-1"> <Link href=\{`\/operator\/routes\/\$\{routeId\}\/stops\/\$\{stop\.id\}`\}/,
  );
  assert.match(compactRoute, /\{t\("View stop outcome"\)\}/);
  assert.match(stop, /<StatusBadge status=\{stopData\.stopStatus\} label=\{t\(stopData\.stopStatus, stopData\.stopStatus\)\} \/>/);
  assert.match(arabic, /"View stop outcome": "عرض نتيجة الموقع"/);
  assert.match(arabic, /completed:\s*"مكتمل"/);
  assert.match(arabic, /skipped:\s*"تم التجاوز"/);
  assert.match(arabic, /canceled:\s*"ملغاة?"/);
});

test("starting a stop never reports success after a failed compare-and-set", () => {
  const source = read("src/lib/operator-actions.ts");
  const start = source.indexOf("export async function markStopInProgress");
  const end = source.indexOf("\nexport async function ", start + 1);
  const body = source.slice(start, end === -1 ? source.length : end);

  assert.match(body, /This route is not active, so the stop cannot be started/);
  assert.match(body, /\.eq\("status", ROUTE_STOP_PICKED_STATUS\)[\s\S]*\.select\("id, status"\)[\s\S]*\.maybeSingle\(\)/);
  assert.match(body, /if \(!startedStop\)[\s\S]*This stop changed while it was being started/);
  assert.doesNotMatch(body, /String\(stop\.status \?\? ""\) !== ROUTE_STOP_PICKED_STATUS\) return \{ success: true \}/);
});
