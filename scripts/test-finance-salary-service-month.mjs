import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  financeProfitRecognitionDate,
  transactionImpacts,
  sumFinanceProfitRows,
} from "../src/lib/finance-balance.ts";

const noury = {
  transaction_date:"2026-11-02",
  direction:"money_out",
  amount:325,
  signed_amount:-325,
  account_id:"snacky_lyd",
  currency:"LYD",
  transaction_effect:"expense",
  category:"Salary / Employee Payment",
  transaction_status:"active",
  metadata:{service_month:"2026-10"},
};
test("October compensation paid November affects October earned-month profit", () => {
  assert.equal(financeProfitRecognitionDate(noury),"2026-10-31");
  assert.deepEqual(transactionImpacts(noury),{snacky_lyd:-325});
  assert.equal(noury.transaction_date,"2026-11-02");
  const october = [noury].filter(row => {
    const recognized = financeProfitRecognitionDate(row);
    return recognized && recognized >= "2026-10-01" && recognized <= "2026-10-31";
  });
  const november = [noury].filter(row => {
    const recognized = financeProfitRecognitionDate(row);
    return recognized && recognized >= "2026-11-01" && recognized <= "2026-11-30";
  });
  assert.equal(sumFinanceProfitRows(october,"LYD"),-325);
  assert.equal(sumFinanceProfitRows(november,"LYD"),0);
});

test("ordinary goods, income and malformed salary periods still use payment date", () => {
  assert.equal(financeProfitRecognitionDate({...noury,category:"Products Restocking"}),"2026-11-02");
  assert.equal(financeProfitRecognitionDate({...noury,category:"Revenue",direction:"money_in",transaction_effect:"income"}),"2026-11-02");
  assert.equal(financeProfitRecognitionDate({...noury,metadata:{service_month:"2026-13"}}),"2026-11-02");
  assert.equal(financeProfitRecognitionDate({...noury,metadata:null}),"2026-11-02");
  assert.equal(financeProfitRecognitionDate({...noury,metadata:{service_month:"2026-02"}}),"2026-02-28");
});

test("the Finance dashboard loads service-month metadata while cash totals use actual dates", () => {
  const ledger = readFileSync("src/lib/finance-ledger.ts","utf8");
  const page = readFileSync("src/app/finance/page.tsx","utf8");
  assert.match(ledger,/FINANCE_TRANSACTION_FULL_COLUMNS[\\s\\S]*"metadata"/);
  assert.match(page,/const periodRows = ledgerRows\\.filter/);
  assert.match(page,/row\\.transaction_date >= periodRange\\.start/);
  assert.match(page,/const recognizedProfitRows = ledgerRows\\.filter/);
  assert.match(page,/financeProfitRecognitionDate\\(row\\)/);
  assert.match(page,/sumFinanceProfitRows\\(recognizedProfitRows, "LYD"/);
  assert.match(page,/earlierSalaryPaidInPeriodLyd/);
});
