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

test("manual sales render the full supplied product catalog", () => {
  const source = read("src/components/operator/ManualRouteSalesSection.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  assert.match(source, /snacky:manual-sales-full-catalog/);
  assert.doesNotMatch(source, /\.slice\(0,\s*24\)/);
  assert.match(source, /product\.sku/);
  assert.match(source, /product\.barcode/);
  assert.match(source, /product\.category/);
  assert.match(source, /product\.brand/);
  assert.match(api, /from\("products"\)/);
  assert.match(api, /\.eq\("active", true\)/);
  assert.match(api, /manualSaleProductOptions/);
});

test("explicit-zero return writes through the privileged ledger and verifies storage balance", () => {
  const source = read("src/lib/operator-actions.ts");
  assert.match(source, /snacky:zero-fill-privileged-ledger-client/);
  assert.match(source, /const zeroFillLedgerClient = getSupabaseAdminClient\(\) \?\? supabase/);
  assert.match(source, /supabase: zeroFillLedgerClient/);
  assert.match(source, /snacky:zero-fill-storage-ledger-verification/);
  assert.match(source, /from\("current_inventory_by_location"\)/);
  assert.match(source, /Expected storage/);
  assert.match(source, /returned_qty: returnedQty/);
});
