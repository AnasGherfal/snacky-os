import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const activation = read("src/lib/vms-monthly-profit-activation.ts");
const action = read("src/lib/vms-monthly-profit-actions.ts");
const importActions = read("src/lib/vms-import-actions.ts");
const batchPage = read("src/app/vms-import/[batchId]/page.tsx");

test("activation verifies persisted monthly profit rows before changing batch state", () => {
  assert.match(activation, /from\("vms_monthly_product_profit"\)/);
  assert.match(activation, /eq\("import_batch_id", cleanBatchId\)/);
  assert.match(activation, /NO_MONTHLY_ROWS/);
  assert.match(activation, /no saved Monthly Product Profit rows to activate/i);
});

test("activation repairs core batch metadata and verifies the persisted active row", () => {
  assert.match(activation, /status:\s*"imported"/);
  assert.match(activation, /is_active:\s*true/);
  assert.match(activation, /rows_imported:\s*persistedRowCount/);
  assert.match(activation, /report_start_date:\s*reportStartDate/);
  assert.match(activation, /report_end_date:\s*reportEndDate/);
  assert.match(activation, /select\("id, status, is_active, rows_imported, report_start_date, report_end_date"\)/);
});

test("newest upload replaces older active partial uploads only for the same month", () => {
  assert.match(activation, /monthlyProfitBatchMonth\(row\) === businessMonth/);
  assert.match(activation, /deactivatedBatchIds/);
  assert.match(activation, /update\(\{ is_active: false/);
  assert.match(activation, /older partial uploads for the same month could not be disabled safely/i);
  assert.doesNotMatch(activation, /delete\(\).*vms_monthly_product_profit|from\("vms_monthly_product_profit"\)\s*\.delete/s);
});

test("successful imports automatically run the monthly activation postcondition", () => {
  assert.match(importActions, /import \{ ensureMonthlyProfitBatchActivated \} from "@\/lib\/vms-monthly-profit-activation"/);
  assert.match(importActions, /reportType === "monthly_product_profit" && effectiveImportedRows > 0/);
  assert.match(importActions, /await ensureMonthlyProfitBatchActivated\(\{/);
  assert.match(importActions, /Monthly Product Profit rows were saved but activation repair failed/);
  assert.doesNotMatch(importActions, /deactivateOlderActiveMonthlyProfitBatches/);
});

test("manual Activate file uses the saved-row repair and refreshes Product Planning", () => {
  assert.match(batchPage, /activateMonthlyProfitImportBatch/);
  assert.match(batchPage, /reportType === "monthly_product_profit" \? activateMonthlyProfitImportBatch : updateVmsImportBatchState/);
  assert.match(batchPage, /disables older partial uploads for the same month/);
  assert.match(action, /ensureMonthlyProfitBatchActivated/);
  assert.match(action, /revalidatePath\("\/product-planning"\)/);
});

test("repair is non-destructive to monthly profit data", () => {
  for (const source of [activation, action, importActions, batchPage]) {
    assert.doesNotMatch(source, /from\("vms_monthly_product_profit"\)\s*\.delete|truncate\s+table\s+public\.vms_monthly_product_profit|drop\s+table\s+public\.vms_monthly_product_profit/is);
  }
});
