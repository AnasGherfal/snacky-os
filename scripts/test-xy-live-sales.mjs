import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractXyLiveSalesRows,
  normalizeXyLiveSalesRow,
  renderXyLiveSalesRequestTemplate,
} from "../src/lib/xy-live-sales.ts";
import { createVmsMonthlyTransactionDuplicateHash } from "../src/lib/vms-transaction-details.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncSource = fs.readFileSync(path.join(repoRoot, "src/lib/xy-live-sales-sync.ts"), "utf8");
const plannerSource = fs.readFileSync(path.join(repoRoot, "src/lib/smart-route-planner.ts"), "utf8");
const cronSource = fs.readFileSync(path.join(repoRoot, "src/app/api/cron/xy-sales/route.ts"), "utf8");
const adminSource = fs.readFileSync(path.join(repoRoot, "src/app/admin/vms-api/page.tsx"), "utf8");
const migrationSource = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20261004090000_xy_live_sales.sql"), "utf8");
const envSource = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));

test("nested XY web responses expose transaction rows", () => {
  const rows = extractXyLiveSalesRows({
    code: 200,
    data: {
      records: [
        { jqbh: "M-1", spmc: "Water", zfje: "3", zfsj: "2026-10-04 10:30:00" },
        { jqbh: "M-2", spmc: "Twix", zfje: "5", zfsj: "2026-10-04 10:31:00" },
      ],
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].jqbh, "M-1");
});

test("explicit response row paths are supported", () => {
  const rows = extractXyLiveSalesRows(
    { payload: { page: { values: [{ machineCode: "A" }] } } },
    "payload.page.values",
  );
  assert.deepEqual(rows, [{ machineCode: "A" }]);
});

test("live XY rows normalize into the canonical Snacky transaction shape", () => {
  const normalized = normalizeXyLiveSalesRow({
    shbh: "6591",
    jqbh: "2503000217",
    jqmc: "Diplomacy Mall",
    ddbh: "ORDER-100",
    hdbh: "030",
    spbh: "P-9",
    spmc: "Gardena chocolate",
    zfje: "5",
    zfsj: "2026-10-04 12:30:00",
    sl: "2",
    ddzt: "支付成功",
  });

  assert.equal(normalized.machineCode, "2503000217");
  assert.equal(normalized.productName, "Gardena chocolate");
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.paymentAmount, 5);
  assert.equal(normalized.transactionStatus, "successful_sale");
  assert.equal(normalized.businessDate, "2026-10-04");
});

test("refund and vend failures are not counted as successful sales", () => {
  const refunded = normalizeXyLiveSalesRow({
    jqbh: "M1",
    spmc: "Water",
    zfje: "3",
    zfsj: "2026-10-04 10:00:00",
    tksj: "2026-10-04 10:05:00",
    tkzt: "退款",
  });
  const failed = normalizeXyLiveSalesRow({
    jqbh: "M1",
    spmc: "Water",
    zfje: "3",
    zfsj: "2026-10-04 10:00:00",
    ddzt: "出货失败",
  });
  assert.equal(refunded.transactionStatus, "refunded");
  assert.equal(failed.transactionStatus, "failed_vend");
});

test("live API and imported files use the same duplicate hash contract", () => {
  const normalized = normalizeXyLiveSalesRow({
    machine_code: "M1",
    order_number: "ORDER-123",
    cargo_lane: "006",
    product_number: "P1",
    product_name: "Water",
    payment_amount: "3",
    payment_time: "2026-10-04 10:00:00",
    quantity: "1",
    transaction_status: "success",
  });
  assert.equal(
    normalized.duplicateHash,
    createVmsMonthlyTransactionDuplicateHash(normalized.canonicalRow),
  );
});

test("request template only renders caller-supplied placeholders into JSON", () => {
  const rendered = renderXyLiveSalesRequestTemplate(
    '{"merchant":"{{merchantId}}","page":{{page}},"pageSize":{{pageSize}},"start":"{{startDateTime}}"}',
    {
      merchantId: "6591",
      page: 2,
      pageSize: 200,
      startDateTime: "2026-10-03 00:00:00",
    },
  );
  assert.deepEqual(rendered, {
    merchant: "6591",
    page: 2,
    pageSize: 200,
    start: "2026-10-03 00:00:00",
  });
});

test("live sales sync writes the existing canonical VMS transaction pipeline only", () => {
  assert.match(syncSource, /from\("vms_transactions_raw"\)/);
  assert.match(syncSource, /from\("vms_import_batches"\)/);
  assert.match(syncSource, /from\("vms_sync_runs"\)/);
  assert.doesNotMatch(syncSource, /from\("routes"\)/);
  assert.doesNotMatch(syncSource, /from\("route_stop_items"\)/);
  assert.doesNotMatch(syncSource, /from\("inventory_movements"\)/);
  assert.match(syncSource, /onConflict: "duplicate_hash", ignoreDuplicates: true/);
});

test("smart-route ranking prefers recent true sales but keeps stock-depletion fallback", () => {
  assert.match(plannerSource, /snacky_smart_route_sales_signals/);
  assert.match(plannerSource, /Math\.log1p\(machineSales\) \* 30/);
  assert.match(plannerSource, /Math\.log1p\(machineDemand\) \* 12/);
  assert.match(plannerSource, /now\.getTime\(\) - latestSalesMs <= 48 \* 60 \* 60 \* 1000/);
  assert.match(plannerSource, /const useTransactionSales = rawSalesSignals\.length > 0 && recentTransactionSales/);
  assert.match(plannerSource, /"xy_live_sales_plus_stock_depletion"/);
  assert.match(plannerSource, /"xy_stock_depletion"/);
});

test("sales-signal RPC only counts mapped successful sales from active imported batches", () => {
  assert.match(migrationSource, /t\.transaction_status = 'successful_sale'/);
  assert.match(migrationSource, /t\.mapped_machine_id is not null/);
  assert.match(migrationSource, /t\.mapped_product_id is not null/);
  assert.match(migrationSource, /coalesce\(b\.is_active, false\) = true/);
  assert.match(migrationSource, /revoke all on function public\.snacky_smart_route_sales_signals\(integer\)\s+from public, anon, authenticated/);
  assert.match(migrationSource, /grant execute on function public\.snacky_smart_route_sales_signals\(integer\)\s+to service_role/);
});

test("hourly live sales cron is authenticated and safe while disabled", () => {
  assert.match(cronSource, /process\.env\.CRON_SECRET/);
  assert.match(cronSource, /timingSafeEqual/);
  assert.match(cronSource, /syncXyLiveSales\(\)/);
  assert.match(cronSource, /result\.outcome === "disabled"/);
  assert.deepEqual(
    vercelConfig.crons.find((row) => row.path === "/api/cron/xy-sales"),
    { path: "/api/cron/xy-sales", schedule: "15 * * * *" },
  );
});

test("XY admin exposes live-sales freshness without exposing secrets", () => {
  assert.match(adminSource, /Live Sales/);
  assert.match(adminSource, /Sync Live Sales/);
  assert.match(adminSource, /latestXyLiveSalesHealth/);
  assert.match(envSource, /XY_WEB_LIVE_SALES_ENABLED=false/);
  assert.match(envSource, /XY_WEB_SALES_PATH=/);
  assert.match(envSource, /XY_WEB_SALES_REQUEST_TEMPLATE=/);
  assert.doesNotMatch(envSource, /XY_WEB_API_AUTHORIZATION=\S+/);
});
