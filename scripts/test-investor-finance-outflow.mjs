import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { register } from "node:module";
register("./ts-alias-loader.mjs",import.meta.url);
const {auditInvestorFinanceMoneyOut,calculateInvestorOperatingExpenses}=await import("../src/lib/investor-finance-outflow.ts");
const {reconcileRecordedInvestorDrafts}=await import("../src/lib/investor-recorded-draft.ts");
const {reconcileInvestorSalesSources}=await import("../src/lib/investor-sales-proof.ts");
const read=file=>fs.readFileSync(new URL("../"+file,import.meta.url),"utf8");
const row=(id,date,amount,category,extra={})=>({
 id,transaction_date:date,direction:"money_out",transaction_status:"active",
 transaction_effect:"expense",review_status:"confirmed",needs_review:false,
 amount,currency:"LYD",category,source_type:"manual",description:"",...extra
});

test("every active Finance money-out includes confirmed Arabic budget adjustment, Other and transfers",()=>{
 const items=[
  row("budget","2026-08-23",8287.02,"Uncategorized",{description:"تعديل الميزانيه"}),
  row("owner","2026-08-24",250,"Other",{description:"Anas"}),
  row("exchange","2026-08-25",3430,"Currency Exchange",{transaction_effect:"transfer"}),
  row("void","2026-08-25",9000,"Other",{is_void:true}),
  row("closed","2026-08-25",9000,"Other",{transaction_status:"voided"})
 ];
 const audit=auditInvestorFinanceMoneyOut(items);
 const august=audit.byMonth["2026-08"];
 assert.equal(august.recordedMoneyOutLyd,11967.02);
 assert.equal(august.adjustmentLyd,8287.02);
 assert.equal(august.transferLyd,3430);
 assert.equal(august.actualRowCount,3);
 const expenses=calculateInvestorOperatingExpenses(audit.rows,[]);
 assert.equal(expenses.additionalCashOperatingLyd,8537.02);
 assert.equal(expenses.excludedTransferCount,1);
});

test("identical CSV/bootstrap imports are one Finance cash event, with mirror evidence preserved",()=>{
 const data=[
  row("csv","2026-04-02",3657,"Inventory Purchase",
   {source_sheet:"financial_transactions.csv",source_row:478,source_type:"import"}),
  row("bootstrap","2026-04-02",3657,"Inventory",
   {source_sheet:"production_bootstrap_financial_transactions",source_row:478,source_type:"import",review_status:"needs_review"}),
  row("actual","2026-04-02",250,"Other")
 ];
 const audit=auditInvestorFinanceMoneyOut(data);
 assert.equal(audit.byMonth["2026-04"].recordedMoneyOutLyd,3907);
 assert.equal(audit.duplicateImportCount,1);
 assert.equal(audit.byMonth["2026-04"].duplicateImportLyd,3657);
 assert.equal(audit.byMonth["2026-04"].reviewedCount,0);
 assert.equal(audit.rows.length,2);
});

test("stock purchases and paid rents stay in money-out, not double-charged to operating share",()=>{
 const items=[
  row("restock","2026-08-02",3000,"Products Restocking",{source_type:"purchase",transaction_kind:"product_purchase"}),
  row("rent","2026-08-04",2000,"Rent",{description:"ايجار مخزن"}),
  row("adjustment","2026-08-23",8287.02,"Uncategorized",{description:"تعديل الميزانيه"}),
  row("salary","2026-08-01",1760,"Salary / Employee Payment"),
  row("charity","2026-08-08",840,"Charity")
 ];
 const audit=auditInvestorFinanceMoneyOut(items);
 assert.equal(audit.byMonth["2026-08"].recordedMoneyOutLyd,15887.02);
 const policies=[{item_type:"rent",monthly_amount_lyd:4300}];
 const expenses=calculateInvestorOperatingExpenses(audit.rows,policies);
 assert.equal(expenses.accruedPolicyLyd,4300);
 assert.equal(expenses.additionalCashOperatingLyd,10887.02);
 assert.equal(expenses.totalOperatingExpensesLyd,15187.02);
 assert.equal(expenses.excludedProductCount,1);
 assert.equal(expenses.excludedRentPaidCount,1);
});

test("USD machine capex is recorded in original currency without blocking operating profit",()=>{
 const audit=auditInvestorFinanceMoneyOut([
  row("usd","2026-09-19",1023,"Machine Purchase",
   {currency:"USD",exchange_rate_usd_to_lyd:null})
 ]);
 const sep=audit.byMonth["2026-09"];
 assert.equal(sep.recordedMoneyOutLyd,null);
 assert.equal(sep.missingFxCount,1);
 assert.equal(sep.missingFxNativeUsd,1023);
 const computed=reconcileRecordedInvestorDrafts({statements:[
  {month_start:"2026-09-01",calculation_status:"draft",gross_profit_lyd:17663.33,
   investor_share_due_lyd:3101.5,operating_profit_lyd:10338.33,profit_basis:"operating_profit"}
 ],sourceAudit:audit,policies:[],profitShare:30});
 assert.equal(computed[0].investor_share_due_lyd,5299);
 assert.equal(computed[0].calculation_status,"draft");
});

test("recorded profit is recalculated rather than leaving the old excluded budget amount",()=>{
 const audit=auditInvestorFinanceMoneyOut([
  row("adjust","2026-08-23",8287.02,"Uncategorized",{description:"تعديل الميزانيه"})
 ]);
 const rechecked=reconcileRecordedInvestorDrafts({
  statements:[{month_start:"2026-08-01",calculation_status:"draft",
   gross_profit_lyd:18985.19,operating_profit_lyd:12925.19,
   investor_share_due_lyd:3877.56,profit_basis:"operating_profit"}],
  sourceAudit:audit,policies:[{item_type:"rent",monthly_amount_lyd:4300,
   effective_from:"2026-04-01",effective_through:null}],profitShare:30
 });
 assert.equal(rechecked[0].operating_profit_lyd,6398.17);
 assert.equal(rechecked[0].investor_share_due_lyd,1919.45);
 assert.equal(rechecked[0].financeAdjustmentsLyd,8287.02);
 assert.equal(rechecked[0].calculation_status,"draft");
});

test("shared owner/investor view is authorized before Finance admin read and never marks draft paid",()=>{
 const audit=read("src/lib/investor-portal-cashout.ts");
 const overview=read("src/components/InvestorYearOverview.tsx");
 const generator=read("src/lib/investor-actions.ts");
 const table=read("src/components/InvestorMonthlyTable.tsx");
 assert.match(audit,/agreement\.investor_user_id!==profile\.id/);
 assert.match(audit,/getSupabaseAdminClient/);
 assert.match(overview,/loadAuthorizedInvestorCashOutAudit/);
 assert.match(overview,/reconcileRecordedInvestorDrafts/);
 assert.match(table,/CashOutDisplay/);
 assert.match(generator,/auditInvestorFinanceMoneyOut/);
 assert.match(generator,/calculateInvestorOperatingExpenses/);
 assert.match(generator,/loadAuthorizedInvestorCashOutAudit/);
 assert.match(generator,/proof\.unresolvedCostCount===0/);
 assert.match(generator,/previousStatements\.every/);
 assert.doesNotMatch(generator,/isOwnerOrNonOperating|approvedOperations/);
});

test("fresh verified XY gross profit overrides stale saved monthly totals without finalizing",()=>{
 const proof={"2026-08-01":{
  month:"2026-08-01",revenueLyd:100,cogsLyd:60,grossProfitLyd:40,
  xyRows:1,manualSales:0,datedCostMatches:0,missingInventoryMovements:0,unresolvedCostCount:0,sourceIssues:[]
 }};
 const recalculated=reconcileRecordedInvestorDrafts({
  statements:[{month_start:"2026-08-01",calculation_status:"draft",
   gross_profit_lyd:9999,operating_profit_lyd:9999,investor_share_due_lyd:2999.7}],
  sourceAudit:auditInvestorFinanceMoneyOut([]),policies:[],profitShare:30,salesByMonth:proof
 });
 assert.equal(recalculated[0].operating_profit_lyd,40);
 assert.equal(recalculated[0].investor_share_due_lyd,12);
 assert.equal(recalculated[0].calculation_status,"draft");
});
