import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const growthModule = await import(
  pathToFileURL(path.join(root, "src/lib/growth-decision.ts")).href
);
const { buildGrowthDecision } = growthModule;

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
  monthsWithRevenue: 4,
  costCoverageComplete: true,
  missingCostSalesCount: 0,
  missingCostRevenueLyd: 0,
};

test("growth engine recommends a machine only after every protection rule passes", () => {
  const result = buildGrowthDecision(readyInput);
  assert.equal(result.code, "buy_now");
  assert.equal(result.cashAfterCommitmentsLyd, 52000);
  assert.equal(result.cashAfterMachinePurchaseLyd, 30000);
  assert.ok(
    result.projectedPaybackMonths && result.projectedPaybackMonths <= 18,
  );
});

test("investor due and reserves can block a machine purchase", () => {
  const result = buildGrowthDecision({
    ...readyInput,
    cashAvailableLyd: 42000,
    investorDueLyd: 8000,
  });
  assert.equal(result.code, "build_cash_reserve");
  assert.ok(result.reserveGapLyd > 0);
});

test("missing product costs produce a dedicated hold without a fake payback", () => {
  const result = buildGrowthDecision({
    ...readyInput,
    costCoverageComplete: false,
    historyMonthCount: 0,
    monthsWithRevenue: 4,
    missingCostSalesCount: 6,
    missingCostRevenueLyd: 850,
  });
  assert.equal(result.code, "complete_product_costs");
  assert.equal(result.projectedPaybackMonths, null);
  assert.match(result.title, /Complete product costs/);
  assert.match(result.reasons.join(" "), /4 month/);
  assert.doesNotMatch(result.reasons.join(" "), /Estimated payback/);
});

test("operational problems take priority over expansion", () => {
  assert.equal(
    buildGrowthDecision({ ...readyInput, openCriticalIssueCount: 1 }).code,
    "fix_existing_first",
  );
  assert.equal(
    buildGrowthDecision({ ...readyInput, criticalRestockCount: 3 }).code,
    "fund_stock_first",
  );
  assert.equal(
    buildGrowthDecision({ ...readyInput, acceptedLocationCount: 0 }).code,
    "prepare_location",
  );
  assert.equal(
    buildGrowthDecision({ ...readyInput, historyMonthCount: 1 }).code,
    "collect_more_history",
  );
});

test("manual route sales use confirmed revenue and inventory movement cost", () => {
  const source = read("src/lib/investor-profit.ts");
  assert.match(source, /manualRouteSalesAsProfitRows/);
  assert.match(source, /status.*confirmed/s);
  assert.match(source, /movementById/);
  assert.match(source, /line_total_lyd/);
  assert.match(source, /source: "manual_route_sale"/);
  assert.match(
    source,
    /costMissing = !movementId \|\| !movement \|\| cost <= 0/,
  );
  assert.match(source, /manualSalesRevenueLyd/);
  assert.match(source, /manualSalesCogsLyd/);
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
  assert.match(actions, /sales_dashboard_monthly_summary/);
  assert.match(actions, /sales_dashboard_summary/);
  assert.doesNotMatch(actions, /from\("vms_sales_clean"\)/);
  assert.match(growth, /operationalReadClient/);
});

test("growth uses the same sales dashboard RPCs instead of the missing clean view", () => {
  const growth = read("src/app/finance/growth-decisions/page.tsx");
  assert.match(growth, /sales_dashboard_monthly_profit_breakdown/);
  assert.match(growth, /sales_dashboard_profit_breakdown/);
  assert.match(growth, /loadVmsGrowthProfit/);
  assert.match(growth, /p_dimension: "month"/);
  assert.match(growth, /p_dimension: "machine"/);
  assert.doesNotMatch(growth, /from\("vms_sales_clean"\)/);
  assert.match(growth, /Decision sales source:/);
  assert.match(growth, /p_dimension: "product"/);
  assert.match(growth, /missingCostProducts/);
  assert.match(growth, /Complete product costs first/);
  assert.match(growth, /Unavailable until costs are complete/);
  assert.match(growth, /MIN_DECISION_COST_COVERAGE_PERCENT = 99/);
  assert.match(growth, /costCoveragePercent >= MIN_DECISION_COST_COVERAGE_PERCENT/);
  assert.match(growth, /Minor cost gap ignored for growth decision/);
  assert.match(growth, /reportedGrossProfit - missingCostRevenue/);
  assert.match(growth, /Revenue treated as zero profit/);
});

test("growth keeps figures visible but holds expansion when coverage is incomplete", () => {
  const growth = read("src/app/finance/growth-decisions/page.tsx");
  assert.match(growth, /getSupabaseAdminClient\(\) \?\? supabase/);
  assert.match(
    growth,
    /historyMonthCount: manualCoverageComplete \? completeMonthly\.length : 0/,
  );
  assert.match(growth, /costCoverageComplete: vmsCoverageComplete/);
  assert.match(
    growth,
    /reliableProfitCoverage = vmsCoverageComplete && manualCoverageComplete/,
  );
  assert.match(growth, /Manual route sales coverage is incomplete/);
  assert.match(growth, /Complete product costs first/);
  assert.match(growth, /VMS sales could not load/);
});

test("investor role is restricted to the investor portal", () => {
  const authz = read("src/lib/authz.ts");
  assert.match(authz, /investor: \["investor\.view"\]/);
  assert.match(
    authz,
    /hasPermission\(input, "investor\.view"\).*"\/investor"/s,
  );
  assert.match(
    authz,
    /matchesPrefix\(pathname, \["\/investor"\]\).*investor\.view/,
  );
  assert.match(
    authz,
    /matchesPrefix\(pathname, \["\/vms-import"\]\).*canViewVmsImports/,
  );
  assert.match(
    authz,
    /matchesPrefix\(pathname, \["\/vms-mappings"\]\).*canManageVmsMappings/,
  );
  assert.doesNotMatch(
    authz,
    /matchesPrefix\(pathname, \["\/vms-import", "\/vms-mappings"\]\)\) return true/,
  );
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
  for (const source of [growth, owner, portal])
    assert.match(source, /TrendChart/);
  assert.match(growth, /HorizontalBarChart/);
  assert.match(machines, /HorizontalBarChart/);
});

test("migration is additive and protects each investor's data", () => {
  const migration = read(
    "supabase/migrations/202607180003_growth_decisions_investor_portal.sql",
  );
  assert.match(
    migration,
    /alter type public\.team_role add value if not exists 'investor'/,
  );
  assert.match(
    migration,
    /create table if not exists public\.investor_agreements/,
  );
  assert.match(
    migration,
    /create table if not exists public\.investor_monthly_statements/,
  );
  assert.match(
    migration,
    /create table if not exists public\.investor_payments/,
  );
  assert.match(migration, /investor_user_id = auth\.uid\(\)/);
  assert.match(migration, /calculation_status = 'finalized'/);
  assert.match(migration, /snacky_can_view_investor_agreement/);
  assert.doesNotMatch(
    migration,
    /\btruncate\b|\bdelete\s+from\b|drop\s+table|drop\s+column|drop[\s\S]{0,120}\bcascade\b/i,
  );
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
