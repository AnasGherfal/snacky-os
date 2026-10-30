import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { buildInvestorMonthlyLedger } from "../src/lib/investor-monthly-ledger.ts";
const read = file => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
const archive = (month, net, payable, paid = 0) => ({
 month_start: month, net_profit_lyd: net, confirmed_payable_usd: payable,
 confirmed_paid_usd: paid, exchange_rate_lyd_per_usd: 7.5, payment_confirmed_at: "2026-10-22T10:00:00Z"
});
const sample = {
 startDate: "2026-01-01", capUsd: 8280,
 historical: [
  archive("2026-01-01",-9369,0),
  archive("2026-02-01",1063.97,42.56),
  archive("2026-03-01",12520.97,500.84)
 ],
 generated: [
  { month_start: "2026-04-01", operating_profit_lyd: 2000, investor_share_due_lyd: 600, calculation_status: "draft" }
 ],
 batches: [], allocations: [], legacyUsdPayouts: []
};
test("January–March imported months are first and visible in LYD, with confirmed zero paid",()=>{
 const result=buildInvestorMonthlyLedger(sample);
 assert.deepEqual(result.months.map(row=>row.month),["2026-01-01","2026-02-01","2026-03-01","2026-04-01"]);
 assert.deepEqual(result.months.map(row=>row.dueLyd),[0,319.20,3756.30,null]);
 assert.deepEqual(result.months.map(row=>row.paidLyd),[0,0,0,null]);
 assert.deepEqual(result.months.map(row=>row.status),["nothing_due","unpaid","unpaid","pending"]);
 assert.equal(result.months[0].netProfitLyd,-9369);
 assert.equal(result.totalDueLyd,4075.50);
 assert.equal(result.totalPaidLyd,0);
 assert.equal(result.totalOutstandingLyd,4075.50);
 assert.equal(result.creditedUsd,0);
 assert.equal(result.remainingGoalUsd,8280);
 assert.equal(result.payableMonths.length,2);
 assert.equal(result.needsReview,false);
});
test("one real multi-month LYD payment is allocated to each month, with USD credited only from actual payment",()=>{
 const paid=buildInvestorMonthlyLedger({...sample,batches:[{
  id:"batch1",payout_date:"2026-10-29",amount_lyd:4075.50,credited_usd:407.55,lyd_per_usd:10,payment_reference:"SYNTHETIC"
 }],allocations:[
  {payout_id:"batch1",month_start:"2026-02-01",amount_lyd:319.20},
  {payout_id:"batch1",month_start:"2026-03-01",amount_lyd:3756.30}
 ]});
 assert.equal(paid.totalPaidLyd,4075.50);
 assert.equal(paid.totalOutstandingLyd,0);
 assert.equal(paid.creditedUsd,407.55);
 assert.equal(paid.remainingGoalUsd,7872.45);
 assert.deepEqual(paid.months.slice(1,3).map(row=>row.status),["paid","paid"]);
});
test("payment batches with different rates accumulate original settlement credits rather than reprice earlier months",()=>{
 const result=buildInvestorMonthlyLedger({...sample,batches:[
  {id:"first",payout_date:"2026-10-29",amount_lyd:319.2,credited_usd:31.92,lyd_per_usd:10,payment_reference:"SYNTHETIC1"},
  {id:"later",payout_date:"2026-10-30",amount_lyd:1000,credited_usd:125,lyd_per_usd:8,payment_reference:"SYNTHETIC2"}
 ],allocations:[
  {payout_id:"first",month_start:"2026-02-01",amount_lyd:319.20},
  {payout_id:"later",month_start:"2026-03-01",amount_lyd:1000}
 ]});
 assert.equal(result.creditedUsd,156.92);
 assert.equal(result.totalPaidLyd,1319.20);
 assert.equal(result.months[2].outstandingLyd,2756.30);
});
test("incomplete source confirmations and orphan payment allocations fail closed",()=>{
 const unverified=buildInvestorMonthlyLedger({...sample,historical:[
  sample.historical[0],{...sample.historical[1],payment_confirmed_at:null},sample.historical[2]
 ]});
 assert.equal(unverified.needsReview,true);
 assert.equal(unverified.months[1].dueLyd,null);
 assert.equal(unverified.payableMonths.length,0);
 const orphan=buildInvestorMonthlyLedger({...sample,allocations:[{payout_id:"missing",month_start:"2026-02-01",amount_lyd:3}]});
 assert.equal(orphan.needsReview,true);
 assert.deepEqual(orphan.payableMonths,[]);
});
test("one shared visible table serves investor and owner; advanced views cannot hide first three months",()=>{
 const overview=read("src/components/InvestorYearOverview.tsx");
 const table=read("src/components/InvestorMonthlyTable.tsx");
 const portal=read("src/app/investor/page.tsx");
 const owner=read("src/app/finance/investors/page.tsx");
 assert.match(overview,/buildInvestorMonthlyLedger/);
 assert.match(overview,/investor_historical_months/);
 assert.match(overview,/investor_lyd_payout_allocations/);
 assert.match(overview,/\.eq\("calculation_status","finalized"\)/);
 assert.match(overview,/InvestorMonthlyTable/);
 assert.match(table,/<table/);
 assert.match(table,/ledger\.months\.map/);
 assert.match(table,/row\.dueLyd/);
 assert.match(table,/row\.paidLyd/);
 assert.match(table,/row\.outstandingLyd/);
 assert.match(table,/monthTitle/);
 assert.match(table,/under review/i);
 assert.match(owner,/InvestorYearOverview/);
 assert.match(portal,/InvestorYearOverview/);
 assert.match(portal,/admin=\{false\}/);
 assert.doesNotMatch(table,/monthly.*USD|USD.*monthly/i);
});
