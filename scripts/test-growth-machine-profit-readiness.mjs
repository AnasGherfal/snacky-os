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
