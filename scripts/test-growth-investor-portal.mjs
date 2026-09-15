import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const read=file=>fs.readFileSync(path.join(root,file),"utf8");
const {buildGrowthDecision}=await import(pathToFileURL(path.join(root,"src/lib/growth-decision.ts")).href);
const readyInput={cashAvailableLyd:65000,machineCostLyd:22000,minimumCashReserveLyd:15000,restockReserveLyd:10000,investorDueLyd:3000,minimumMonthlyOperatingProfitLyd:6000,averageMonthlyOperatingProfitLyd:12000,averageMachineProfitAfterRentLyd:2200,targetPaybackMonths:18,acceptedLocationCount:1,criticalRestockCount:0,openCriticalIssueCount:0,weakMachineCount:0,historyMonthCount:4,minimumHistoryMonths:3,monthsWithRevenue:4,costCoverageComplete:true,missingCostSalesCount:0,missingCostRevenueLyd:0};

test('growth engine recommends a machine only after every protection rule passes',()=>{const result=buildGrowthDecision(readyInput);assert.equal(result.code,'buy_now');assert.equal(result.cashAfterCommitmentsLyd,52000);assert.equal(result.cashAfterMachinePurchaseLyd,30000);assert.ok(result.projectedPaybackMonths&&result.projectedPaybackMonths<=18);});
test('investor due and reserves can block a machine purchase',()=>{const result=buildGrowthDecision({...readyInput,cashAvailableLyd:42000,investorDueLyd:8000});assert.equal(result.code,'build_cash_reserve');assert.ok(result.reserveGapLyd>0);});
test('missing product costs produce a dedicated hold without a fake payback',()=>{const result=buildGrowthDecision({...readyInput,costCoverageComplete:false,historyMonthCount:0,monthsWithRevenue:4,missingCostSalesCount:6,missingCostRevenueLyd:850});assert.equal(result.code,'complete_product_costs');assert.equal(result.projectedPaybackMonths,null);assert.match(result.title,/Complete product costs/);assert.match(result.reasons.join(' '),/4 month/);assert.doesNotMatch(result.reasons.join(' '),/Estimated payback/);});
test('operational problems take priority over expansion',()=>{assert.equal(buildGrowthDecision({...readyInput,openCriticalIssueCount:1}).code,'fix_existing_first');assert.equal(buildGrowthDecision({...readyInput,criticalRestockCount:3}).code,'fund_stock_first');assert.equal(buildGrowthDecision({...readyInput,acceptedLocationCount:0}).code,'prepare_location');assert.equal(buildGrowthDecision({...readyInput,historyMonthCount:1}).code,'collect_more_history');});

test('manual route sales use confirmed revenue and inventory movement cost',()=>{
 const source=read('src/lib/investor-profit.ts');
 for(const pattern of [/manualRouteSalesAsProfitRows/,/status.*confirmed/s,/movementById/,/line_total_lyd/,/source: "manual_route_sale"/,/costMissing = !movementId \|\| !movement \|\| cost <= 0/,/manualSalesRevenueLyd/,/manualSalesCogsLyd/])assert.match(source,pattern);
});
test('investor profit calculation is positive-profit only and excludes distributions',()=>{
 const source=read('src/lib/investor-profit.ts'),expenses=read('src/lib/investor-expenses.ts');
 assert.match(source,/Math\.max\(0, operatingProfitLyd\)/);assert.match(source,/isInvestorDistributionLedgerRow/);assert.match(source,/source_type.*investor_payment/s);assert.match(source,/investorExpenseSummary\(operatingLedger\)/);assert.match(expenses,/aggregateExpenseCategories\(operatingLedger/);
});
test('growth and statements use confirmed manual sales and inventory movement cost',()=>{
 const actions=read('src/lib/investor-actions.ts'),growth=read('src/app/finance/growth-decisions/page.tsx');
 for(const source of [actions,growth]){assert.match(source,/route_manual_sales/);assert.match(source,/manualRouteSalesAsProfitRows/);assert.match(source,/inventory_movements/);}
 assert.match(actions,/manual sales revenue/);assert.match(actions,/sales_dashboard_monthly_summary/);assert.match(actions,/sales_dashboard_summary/);assert.doesNotMatch(actions,/from\("vms_sales_clean"\)/);assert.match(growth,/operationalReadClient/);
});
test('growth uses the same sales dashboard RPCs instead of the missing clean view',()=>{
 const growth=read('src/app/finance/growth-decisions/page.tsx');
 for(const pattern of [/sales_dashboard_monthly_profit_breakdown/,/sales_dashboard_profit_breakdown/,/loadVmsGrowthProfit/,/p_dimension: "month"/,/p_dimension: "machine"/,/Decision sales source:/,/p_dimension: "product"/,/missingCostProducts/,/Complete product costs first/,/Unavailable until costs are complete/,/MIN_DECISION_COST_COVERAGE_PERCENT = 99/,/costCoveragePercent >= MIN_DECISION_COST_COVERAGE_PERCENT/,/Minor cost gap ignored for growth decision/,/reportedGrossProfit - missingCostRevenue/,/Revenue treated as zero profit/])assert.match(growth,pattern);
 assert.doesNotMatch(growth,/from\("vms_sales_clean"\)/);
});
test('growth keeps figures visible but holds expansion when coverage is incomplete',()=>{
 const growth=read('src/app/finance/growth-decisions/page.tsx');
 for(const pattern of [/getSupabaseAdminClient\(\) \?\? supabase/,/historyMonthCount: manualCoverageComplete \? completeMonthly\.length : 0/,/costCoverageComplete: vmsCoverageComplete/,/reliableProfitCoverage = vmsCoverageComplete && manualCoverageComplete/,/Manual route sales coverage is incomplete/,/Complete product costs first/,/VMS sales could not load/])assert.match(growth,pattern);
});
test('investor role is restricted to the investor portal',()=>{
 const authz=read('src/lib/authz.ts');
 assert.match(authz,/investor: \["investor\.view"\]/);assert.match(authz,/hasPermission\(input, "investor\.view"\).*"\/investor"/s);assert.match(authz,/matchesPrefix\(pathname, \["\/investor"\]\).*investor\.view/);
 assert.match(authz,/matchesPrefix\(pathname, \["\/vms-import"\]\).*canViewVmsImports/);assert.match(authz,/matchesPrefix\(pathname, \["\/vms-mappings"\]\).*canManageVmsMappings/);assert.doesNotMatch(authz,/matchesPrefix\(pathname, \["\/vms-import", "\/vms-mappings"\]\)\) return true/);
 const sidebar=read('src/components/Sidebar.tsx');assert.match(sidebar,/Investor Portal/);assert.match(sidebar,/بوابة المستثمر/);assert.match(sidebar,/investorNav/);
});
test('finalized statements are protected and only complete months can finalize',()=>{
 const actions=read('src/lib/investor-actions.ts'),sql=read('supabase/migrations/20260915170000_investor_access_and_ledger.sql');
 assert.match(actions,/calculation_status === "finalized"/);assert.match(actions,/source_complete:complete/);assert.match(actions,/snacky_finalize_investor_statement_v1/);
 assert.match(sql,/not s.source_complete/);assert.match(sql,/Only a completed month can be finalized/);assert.match(sql,/Payment exceeds the remaining/);assert.match(sql,/Finalized investor statements cannot be changed or deleted/);
});
test('investor payments reduce cash but are non-operating and atomically posted',()=>{
 assert.match(read('src/lib/finance-balance.ts'),/"investor profit share"/);assert.match(read('src/lib/finance-operations.ts'),/"investor profit share"/);
 const sql=read('supabase/migrations/20260915170000_investor_access_and_ledger.sql'),actions=read('src/lib/investor-money-actions.ts');
 assert.match(sql,/'money_out','manual_money_out','Investor Profit Share'/);assert.match(sql,/'investor_payment',r.id/);assert.match(sql,/finance_posting_status='posted'/);assert.match(actions,/snacky_record_investor_payment_v1/);assert.match(actions,/Number\(finance.signed_amount\)/);
});
test('growth, investor, and machine dashboards contain real charts',()=>{
 for(const file of ['src/app/finance/growth-decisions/page.tsx','src/app/finance/investors/page.tsx','src/app/investor/page.tsx'])assert.match(read(file),/TrendChart/);
 assert.match(read('src/app/finance/growth-decisions/page.tsx'),/HorizontalBarChart/);assert.match(read('src/app/machines-dashboard/page.tsx'),/HorizontalBarChart/);
});
test('original migration is additive and protects each investor data',()=>{
 const migration=read('supabase/migrations/202607180003_growth_decisions_investor_portal.sql');
 for(const pattern of [/alter type public\.team_role add value if not exists 'investor'/,/create table if not exists public\.investor_agreements/,/create table if not exists public\.investor_monthly_statements/,/create table if not exists public\.investor_payments/,/investor_user_id = auth\.uid\(\)/,/calculation_status = 'finalized'/,/snacky_can_view_investor_agreement/])assert.match(migration,pattern);
 assert.doesNotMatch(migration,/\btruncate\b|\bdelete\s+from\b|drop\s+table|drop\s+column|drop[\s\S]{0,120}\bcascade\b/i);
});
test('owner pages connect agreement creation, monthly review and atomic payout forms',()=>{
 const tabs=read('src/components/module-tabs-config.ts'),team=read('src/lib/team.ts'),owner=read('src/app/finance/investors/page.tsx'),card=read('src/components/InvestorStatementCard.tsx');
 assert.match(tabs,/Growth Decisions/);assert.match(tabs,/Investors/);assert.match(team,/investor:/);assert.match(owner,/Create investor login/);assert.match(owner,/generateInvestorStatement/);assert.match(owner,/InvestorStatementCard/);assert.match(card,/InvestorMoneyForm kind="payout"/);
});
