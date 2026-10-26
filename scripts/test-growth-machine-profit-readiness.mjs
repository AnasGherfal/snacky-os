import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const page=readFileSync("src/app/finance/growth-decisions/page.tsx","utf8");

test("growth decision does not infer zero profit for unmatched VMS machines",()=>{
 assert.ok(page.includes("const hasVmsMachineMatch = Boolean(vmsRow)"));
 assert.ok(page.includes("const rentVerified = rentValue !== null"));
 assert.ok(page.includes("hasVmsMachineMatch && rentVerified"));
 assert.ok(page.includes("profitAfterRent: sourceReady"));
 assert.ok(page.includes(": null,"));
 assert.ok(page.includes("verifiedMachineProfitRows"));
 assert.ok(page.includes("unverifiedMachineCount"));
 assert.ok(page.includes("unverifiedMachineCount === 0"));
 assert.ok(page.includes("machineProfitCoverageComplete: unverifiedMachineCount === 0 && activeMachines.length > 0"));
});

test("owner sees bilingual profit readiness warning with existing review links",()=>{
 assert.ok(page.includes("Machine profitability needs verification"));
 assert.ok(page.includes("ربحية بعض الأجهزة غير مؤكدة"));
 assert.ok(page.includes("will not classify them as loss-making"));
 assert.ok(page.includes('href="/finance/rent"'));
 assert.ok(page.includes('href="/machines"'));
 assert.ok(page.includes('href="/vms-import"'));
});

test("growth profit readiness is read only",()=>{
 const block=page.slice(page.indexOf("const machineProfitRows ="),page.indexOf("const financeBalances ="));
 assert.doesNotMatch(block,/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
});

test("growth engine holds expansion instead of inferring zero-loss machines", async()=>{
 const {buildGrowthDecision}=await import("../src/lib/growth-decision.ts");
 const input={
  cashAvailableLyd: 100000, machineCostLyd: 15000, minimumCashReserveLyd: 1000,
  restockReserveLyd: 0, investorDueLyd: 0, minimumMonthlyOperatingProfitLyd: 100,
  averageMonthlyOperatingProfitLyd: 10000, averageMachineProfitAfterRentLyd: 5000,
  targetPaybackMonths: 20, acceptedLocationCount: 1, criticalRestockCount: 0,
  openCriticalIssueCount: 0, weakMachineCount: 0, historyMonthCount: 6,
  minimumHistoryMonths: 3, monthsWithRevenue: 6, costCoverageComplete: true,
  missingCostSalesCount: 0, missingCostRevenueLyd: 0,
  machineProfitCoverageComplete: false,
 };
 const decision=buildGrowthDecision(input);
 assert.equal(decision.code,"verify_machine_profit");
 assert.notEqual(decision.code,"buy_now");
 assert.match(decision.summary,/incomplete evidence/);
});
