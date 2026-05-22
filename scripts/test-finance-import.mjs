import test from "node:test";
import assert from "node:assert/strict";
import { computeFinanceBalances, isBalanceAffectingTransaction } from "../src/lib/finance-balance.ts";
import { classifyFinanceRows, KHALIJ_UNIVERSITY_ARABIC_NAME, buildFinanceReviewGroups } from "../src/lib/finance-import.ts";

function row(sourceRow, record) {
  return {
    sourceFile: "docs/current-data/financial_transactions.csv",
    sourceSheet: "financial_transactions.csv",
    sourceRow,
    record,
  };
}

test("finance balances stay separated by owner/account/currency and exclude review rows", () => {
  const balances = computeFinanceBalances(
    [
      { transaction_status: "active", direction: "money_in", amount: 100, signed_amount: 100, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "income" },
      { transaction_status: "active", direction: "money_in", amount: 50, signed_amount: 50, account_id: "owner_lyd", currency: "LYD", transaction_effect: "income" },
      { transaction_status: "active", direction: "money_in", amount: 10, signed_amount: 10, account_id: "snacky_usd", currency: "USD", transaction_effect: "income" },
      { transaction_status: "active", direction: "money_out", amount: 25, signed_amount: -25, currency: "LYD", transaction_effect: "transfer", source_account_id: "snacky_lyd", destination_account_id: "owner_lyd" },
      { transaction_status: "active", needs_review: true, direction: "money_out", amount: 999, signed_amount: -999, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "expense" },
    ],
    { snacky_lyd: 5 },
  );

  assert.equal(balances.snacky_lyd, 80);
  assert.equal(balances.owner_lyd, 75);
  assert.equal(balances.snacky_usd, 10);
  assert.equal(balances.owner_usd, 0);
});

test("KhalijUniversity resolves to the correct Arabic machine name", () => {
  const [classified] = classifyFinanceRows([
    row(2, {
      date: "2026-04-12",
      transaction: "1810",
      money_flow: "Money In",
      transaction_type: "Revenue",
      location: "KhalijUniversity",
      transaction_description: "TO_CONFIRM",
      signed_amount: "1810.0",
      auto_bucket: "Inflow",
      bucket_override: "TO_CONFIRM",
      final_bucket: "Inflow",
    }),
  ], []);

  assert.equal(classified.importStatus, "auto_classified");
  assert.equal(classified.suggestedMachine, KHALIJ_UNIVERSITY_ARABIC_NAME);
  assert.equal(classified.resolvedLocationName, KHALIJ_UNIVERSITY_ARABIC_NAME);
});

test("duplicate rows are ignored by date amount description currency and account", () => {
  const rows = [
    row(2, {
      date: "2026-01-01",
      transaction: "100",
      money_flow: "Money In",
      transaction_type: "Revenue",
      location: "HTMall",
      transaction_description: "same deposit",
      signed_amount: "100",
      auto_bucket: "Inflow",
      final_bucket: "Inflow",
    }),
    row(3, {
      date: "2026-01-01",
      transaction: "100",
      money_flow: "Money In",
      transaction_type: "Revenue",
      location: "HTMall",
      transaction_description: "same deposit",
      signed_amount: "100",
      auto_bucket: "Inflow",
      final_bucket: "Inflow",
    }),
  ];

  const classified = classifyFinanceRows(rows, []);
  assert.equal(classified[0].importStatus, "auto_classified");
  assert.equal(classified[1].importStatus, "ignored");
});

test("ambiguous review rows are grouped into clarification questions", () => {
  const classified = classifyFinanceRows([
    row(2, {
      date: "2026-04-28",
      transaction: "4680",
      money_flow: "Money Out",
      transaction_type: "TO_CONFIRM",
      location: "TO_CONFIRM",
      transaction_description: "شراء دولار",
      signed_amount: "-4680",
      auto_bucket: "Review",
      final_bucket: "Review",
    }),
    row(3, {
      date: "2026-04-30",
      transaction: "118",
      money_flow: "Money Out",
      transaction_type: "TO_CONFIRM",
      location: "TO_CONFIRM",
      transaction_description: "TO_CONFIRM",
      signed_amount: "-118",
      auto_bucket: "Review",
      final_bucket: "Review",
    }),
  ], []);

  const groups = buildFinanceReviewGroups(classified);
  assert.ok(groups.length >= 1);
  assert.ok(groups.some((group) => group.key === "unknown_currency"));
  assert.equal(isBalanceAffectingTransaction({ transaction_status: "active", import_status: "needs_review", signed_amount: -4680 }), false);
});
