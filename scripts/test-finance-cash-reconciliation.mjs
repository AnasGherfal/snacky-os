import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import { compareOwnerCashCountToLedger } from "../src/lib/finance-cash-reconciliation.ts";
import { verifyFinanceOpeningEvidence } from "../src/lib/finance-opening-evidence.ts";

function entry(date,amount) {
  return {transaction_date:date,transaction_status:"active",import_status:"imported",
    direction:amount >= 0?"money_in":"money_out",amount:Math.abs(amount),signed_amount:amount,
    currency:"LYD",account_id:"snacky_lyd",transaction_effect:amount >= 0?"income":"expense"};
}
const openingBalances={snacky_lyd:500,snacky_usd:0,owner_lyd:0,owner_usd:0};
const cutoffDate="2026-05-15";

test("cash vs ledger compares only movements through the owner's count date",()=>{
 const result=compareOwnerCashCountToLedger({
  rows:[entry("2026-05-16",100),entry("2026-10-26",-20),entry("2026-10-27",-500)],
  asOfDate:"2026-10-26",directlyAccessibleLyd:550,custodyLyd:30,
  openingBalances,cutoffDate,
 });
 assert.equal(result.verified,true);
 if (!result.verified) throw Error("failed");
 assert.equal(result.ledgerSnackyLyd,580);
 assert.equal(result.differenceFromCashAndBankLyd,30);
 assert.equal(result.differenceIncludingCustodyLyd,0);
 assert.equal(result.basis,"date_only");
});

test("comparison never subtracts unpaid debts or counts custodial cash twice",()=>{
 const result=compareOwnerCashCountToLedger({
  rows:[entry("2026-10-25",50)],
  asOfDate:"2026-10-26",directlyAccessibleLyd:500,custodyLyd:50,
  openingBalances,cutoffDate,
 });
 assert.equal(result.verified,true);
 if(!result.verified) throw Error("failed");
 assert.equal(result.differenceFromCashAndBankLyd,50);
 assert.equal(result.differenceIncludingCustodyLyd,0);
});

test("invalid calendar date, pre-cutoff or undated active rows block reconciliation",()=>{
 const base={rows:[entry("2026-10-25",50)],asOfDate:"2026-10-26",
  directlyAccessibleLyd:500,custodyLyd:50,openingBalances,cutoffDate};
 assert.deepEqual(compareOwnerCashCountToLedger({...base,asOfDate:"2026-02-30"}),
  {verified:false,reason:"invalid_date"});
 assert.deepEqual(compareOwnerCashCountToLedger({...base,asOfDate:"2026-05-14"}),
  {verified:false,reason:"before_opening_balance"});
 assert.deepEqual(compareOwnerCashCountToLedger({...base,rows:[entry(null,50)]}),
  {verified:false,reason:"undated_active_entry"});
 assert.deepEqual(compareOwnerCashCountToLedger({...base,directlyAccessibleLyd:NaN}),
  {verified:false,reason:"invalid_count"});
});

test("growth page only displays same-date differences and never posts financial adjustments",()=>{
 const src=readFileSync("src/app/finance/growth-decisions/page.tsx","utf8");
 assert.ok(src.includes("compareOwnerCashCountToLedger({"));
 assert.ok(src.includes("asOfDate: countedAsOf"));
 assert.ok(src.includes("directlyAccessibleLyd: liquidity.directlyAccessible"));
 assert.ok(src.includes("custodyLyd: liquidity.physicallyHeldElsewhere"));
 assert.ok(src.includes("differenceIncludingCustodyLyd"));
 assert.ok(src.includes("Reconciliation differences are not proven losses"));
 const contract=readFileSync("src/lib/finance-cash-reconciliation.ts","utf8");
 assert.doesNotMatch(contract,/\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
});

test("opening evidence requires matching Finance cutoff and all four accounts",()=>{
 const rows=[
  ["snacky_lyd","9514"],["snacky_usd","660"],["owner_lyd","-24360.50"],["owner_usd","-418"],
 ].map(([account_id,opening_balance])=>({account_id,opening_balance,balance_date:"2026-05-15"}));
 const settings={reconciliation_cutoff_date:"2026-05-15"};
 const complete=verifyFinanceOpeningEvidence(settings,rows);
 assert.equal(complete.verified,true);
 if(!complete.verified)throw Error("missing");
 assert.equal(complete.cutoffDate,"2026-05-15");
 assert.equal(complete.openingBalances.snacky_lyd,9514);
 assert.equal(complete.openingBalances.owner_lyd,-24360.5);
 assert.equal(verifyFinanceOpeningEvidence(settings,rows.slice(0,3)).verified,false);
 assert.equal(verifyFinanceOpeningEvidence(settings,[...rows,rows[0]]).verified,false);
 assert.equal(verifyFinanceOpeningEvidence({reconciliation_cutoff_date:"2026-10-26"},rows).verified,false);
 assert.equal(verifyFinanceOpeningEvidence(null,rows).verified,false);
});

test("growth reconciliation reads authenticated Finance settings and matching opening records",()=>{
 const src=readFileSync("src/app/finance/growth-decisions/page.tsx","utf8");
 assert.ok(src.includes('from("finance_settings")'));
 assert.ok(src.includes('from("finance_opening_balances")'));
 assert.ok(src.includes("verifyFinanceOpeningEvidence("));
 assert.ok(src.includes("openingBalances: financeOpening.openingBalances"));
 assert.ok(src.includes("cutoffDate: financeOpening.cutoffDate"));
 assert.ok(src.includes('unverifiedLedgerCash === null ?'));
});
