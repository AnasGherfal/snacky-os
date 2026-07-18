import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const growthModule = await import(pathToFileURL(path.join(root, "src/lib/growth-decision.ts")).href);
const investorProfitModule = await import(pathToFileURL(path.join(root, "src/lib/investor-profit.ts")).href);
const { buildGrowthDecision } = growthModule;
const { calculateInvestorMonth, manualRouteSalesAsProfitRows } = investorProfitModule;

const readyInput = {
  cashAvailableLyd: 65000,
  machineCostLyd: 22000,
  minimumCashReserveLyd: 15000,
  restockReserveLyd: 10000,
  investorDueLyd: 3000,
  minimumMonthlyOperatingProfitLyd: 6000,
  averageMonthlyOperatingProfitLyd: 12000,
  averageMachineProfitAfterRentLyd: 2200,
  targetPaybackMonths: 18,
  acceptedLocationCount: 1,
  criticalRestockCount: 0,
  openCriticalIssueCount: 0,
  weakMachineCount: 0,
  historyMonthCount: 4,
  minimumHistoryMonths: 3,
};

test("growth engine recommends a machine only after every protection rule passes", () => {
  const result = buildGrowthDecision(readyInput);
  assert.equal(result.code, "buy_now");
  assert.equal(result.cashAfterCommitmentsLyd, 52000);
  assert.equal(result.cashAfterMachinePurchaseLyd, 30000);
  assert.ok(result.projectedPaybackMonths && result.projectedPaybackMonths <= 18);
});

test("investor due and reserves can block a machine purchase", () => {
  const result = buildGrowthDecision({ ...readyInput, cashAvailableLyd: 42000, investorDueLyd: 8000 });
  assert.equal(result.code, "build_cash_reserve");
  assert.ok(result.reserveGapLyd > 0);
});

test("operational problems take priority over expansion", () => {
  assert.equal(buildGrowthDecision({ ...readyInput, openCriticalIssueCount: 1 }).code, "fix_existing_first");
  assert.equal(buildGrowthDecision({ ...readyInput, criticalRestockCount: 3 }).code, "fund_stock_first");
  assert.equal(buildGrowthDecision({ ...readyInput, acceptedLocationCount: 0 }).code, "prepare_location");
  assert.equal(buildGrowthDecision({ ...readyInput, historyMonthCount: 1 }).code, "collect_more_history");
});

test("confirmed manual sales add revenue and movement cost to investor profit", () => {
  const manualRows = manualRouteSalesAsProfitRows([
    { id: "sale-1", status: "confirmed", total_amount_lyd: 30, inventory_movement_id: "movement-1" },
    { id: "sale-2", status: "confirmed", total_amount_lyd: 15, inventory_movement_id: null },
    { id: "sale-3", status: "cancelled", total_amount_lyd: 99, inventory_movement_id: "movement-3" },
  ], [
    { id: "movement-1", line_total_lyd: 18, unit_cost_lyd: 6 },
    { id: "movement-3", line_total_lyd: 50, unit_cost_lyd: 5 },
  ]);
  assert.equal(manualRows.length, 2);
  assert.deepEqual(manualRows[0], {
    net_sales_amount: 30,
    cogs_amount: 18,
    gross_profit_amount: 12,
    cost_missing: false,
    source: "manual_route_sale",
  });
  assert.equal(manualRows[1].cost_missing, true);

  const calculation = calculateInvestorMonth({
    salesRows: [
      { net_sales_amount: 100, cogs_amount: 60, gross_profit_amount: 40, cost_missing: false, source: "vms" },
      ...manualRows,
    ],
    ledgerRows: [],
    sharePercent: 30,
  });
  assert.equal(calculation.revenueLyd, 145);
  assert.equal(calculation.manualSalesRevenueLyd, 45);
  assert.equal(calculation.manualSalesCogsLyd, 18);
  assert.equal(calculation.missingCostRows, 1);
  assert.equal(calculation.complete, false);
});

test("investor profit calculation is positive-profit only and excludes distributions", () => {
  const source = read("src/lib/investor-profit.ts");
  assert.match(source, /Math\.max\(0, operatingProfitLyd\)/);
  assert.match(source, /isInvestorDistributionLedgerRow/);
  assert.match(source, /source_type.*investor_payment/s);
  assert.match(source, /aggregateExpenseCategories\(operatingLedger/);
});

test("growth and statements use confirmed manual sales and inventory movement cost", () => {
  const actions = read("src/lib/investor-actions.ts");
  const growth = read("src/app/finance/growth-decisions/page.tsx");
  for (const source of [actions, growth]) {
    assert.match(source, /route_manual_sales/);
    assert.match(source, /manualRouteSalesAsProfitRows/);
    assert.match(source, /inventory_movements/);
  }
  assert.match(actions, /manual sales revenue/);
  assert.match(growth, /Both VMS and confirmed manual route sales must load/);
});

test("investor role is restricted to the investor portal", () => {
  const authz = read("src/lib/authz.ts");
  assert.match(authz, /investor: \["investor\.view"\]/);
  assert.match(authz, /hasPermission\(input, "investor\.view"\).*"\/investor"/s);
  assert.match(authz, /matchesPrefix\(pathname, \["\/investor"\]\).*investor\.view/);
  const sidebar = read("src/components/Sidebar.tsx");
  assert.match(sidebar, /Investor Portal/);
  assert.match(sidebar, /بوابة المستثمر/);
  assert.match(sidebar, /investorNav/);
});

test("finalized statements are protected and only complete months can finalize", () => {
  const actions = read("src/lib/investor-actions.ts");
  assert.match(actions, /calculation_status === "finalized"/);
  assert.match(actions, /complete=true/);
  assert.match(actions, /Only a completed month can be finalized/);
  assert.match(actions, /Payment exceeds the remaining/);
});

test("investor payments reduce cash but are non-operating", () => {
  const balance = read("src/lib/finance-balance.ts");
  const operations = read("src/lib/finance-operations.ts");
  const actions = read("src/lib/investor-actions.ts");
  assert.match(balance, /"investor profit share"/);
  assert.match(operations, /"investor profit share"/);
  assert.match(actions, /direction: "money_out"/);
  assert.match(actions, /source_type: "investor_payment"/);
  assert.match(actions, /finance_posting_status/);
});

test("growth, investor, and machine dashboards contain real charts", () => {
  const growth = read("src/app/finance/growth-decisions/page.tsx");
  const owner = read("src/app/finance/investors/page.tsx");
  const portal = read("src/app/investor/page.tsx");
  const machines = read("src/app/machines-dashboard/page.tsx");
  for (const source of [growth, owner, portal]) assert.match(source, /TrendChart/);
  assert.match(growth, /HorizontalBarChart/);
  assert.match(machines, /HorizontalBarChart/);
});

test("migration is additive and protects each investor's data", () => {
  const migration = read("supabase/migrations/202607180003_growth_decisions_investor_portal.sql");
  assert.match(migration, /alter type public\.team_role add value if not exists 'investor'/);
  assert.match(migration, /create table if not exists public\.investor_agreements/);
  assert.match(migration, /create table if not exists public\.investor_monthly_statements/);
  assert.match(migration, /create table if not exists public\.investor_payments/);
  assert.match(migration, /investor_user_id = auth\.uid\(\)/);
  assert.match(migration, /calculation_status = 'finalized'/);
  assert.match(migration, /snacky_can_view_investor_agreement/);
  assert.doesNotMatch(migration, /\btruncate\b|\bdelete\s+from\b|drop\s+table|drop\s+column|drop[\s\S]{0,120}\bcascade\b/i);
});

test("owner pages are connected through Finance and team login creation", () => {
  const tabs = read("src/components/module-tabs-config.ts");
  const team = read("src/lib/team.ts");
  const ownerPage = read("src/app/finance/investors/page.tsx");
  assert.match(tabs, /Growth Decisions/);
  assert.match(tabs, /Investors/);
  assert.match(team, /investor:/);
  assert.match(ownerPage, /Create investor login/);
  assert.match(ownerPage, /generateInvestorStatement/);
  assert.match(ownerPage, /recordInvestorPayment/);
});
