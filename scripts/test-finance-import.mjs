import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFinanceBalances,
  computeFinanceBalancesFromCutoff,
  FINANCE_RECONCILIATION_CUTOFF_DATE,
  isBalanceAffectingTransaction,
  RECONCILED_OPENING_BALANCES,
  sumFinanceProfitRows,
} from "../src/lib/finance-balance.ts";
import { classifyFinanceRows, KHALIJ_UNIVERSITY_ARABIC_NAME, buildFinanceReviewGroups, parseFinanceCsvText } from "../src/lib/finance-import.ts";

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

test("finance balances start from 2026-05-15 openings and ignore earlier historical rows", () => {
  const balances = computeFinanceBalancesFromCutoff({
    rows: [
      { transaction_date: "2026-05-15", transaction_status: "active", direction: "money_out", amount: 100000, signed_amount: -100000, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "expense" },
      { transaction_date: "2026-05-14", transaction_status: "active", direction: "money_out", amount: 100000, signed_amount: -100000, account_id: "owner_lyd", currency: "LYD", transaction_effect: "expense" },
      { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 500, signed_amount: -500, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "expense" },
      { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_in", amount: 100, signed_amount: 100, account_id: "snacky_usd", currency: "USD", transaction_effect: "income" },
      { transaction_date: "2026-05-17", transaction_status: "active", direction: "money_out", amount: 200, signed_amount: -200, currency: "LYD", transaction_effect: "transfer", source_account_id: "owner_lyd", destination_account_id: "snacky_lyd" },
    ],
    openingBalances: RECONCILED_OPENING_BALANCES,
    cutoffDate: FINANCE_RECONCILIATION_CUTOFF_DATE,
  });

  assert.equal(balances.owner_lyd, -24560.5);
  assert.equal(balances.owner_usd, -418);
  assert.equal(balances.snacky_lyd, 9214);
  assert.equal(balances.snacky_usd, 760);
});

test("owner funding and withdrawal do not count as profit", () => {
  const rows = [
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_in", amount: 1000, signed_amount: 1000, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "income", final_bucket: "Sales Revenue" },
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 250, signed_amount: -250, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "expense", final_bucket: "Rent" },
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 700, signed_amount: -700, currency: "LYD", transaction_effect: "transfer", source_account_id: "owner_lyd", destination_account_id: "snacky_lyd", final_bucket: "Owner Funding" },
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 100, signed_amount: -100, currency: "LYD", transaction_effect: "transfer", source_account_id: "snacky_lyd", destination_account_id: "owner_lyd", final_bucket: "Owner Withdrawal" },
  ];

  assert.equal(sumFinanceProfitRows(rows, "LYD"), 750);
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

test("Snacky Transactions CSV header is detected after summary rows", () => {
  const csv = [
    "Summary,,,,,,,",
    "Anas LYD,-24360.50,,,,,,",
    "Snacky LYD,8914.00,,,,,,",
    "Date,Name,Transaction Amount,Currency,Money Flow,Transaction Type,Location,Transaction Description",
    "15/05/2026,Snacky,100,LYD,Money In,Revenue,KhalijUniversity,Machine cash",
    "16/05/2026,Anas,50,$,Money Out,Owner Withdrawal,,Owner took cash",
  ].join("\n");

  const parsed = parseFinanceCsvText(csv, { sourceFile: "Snacky - Financial Spreadsheet - Transactions.csv" });

  assert.equal(parsed.headerRow, 4);
  assert.equal(parsed.detectedFormat, "snacky_transactions");
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].sourceRow, 5);
  assert.equal(parsed.rows[0].record.date, "15/05/2026");
  assert.equal(parsed.rows[0].record.name, "Snacky");
  assert.equal(parsed.rows[0].record.transaction, "100");
});

test("blank Transaction Type rows are kept as Uncategorized needs-review rows", () => {
  const parsed = parseFinanceCsvText([
    "Date,Name,Transaction Amount,Currency,Money Flow,Transaction Type,Location,Transaction Description",
    "16/05/2026,Snacky,75,LYD,Money Out,,KhalijUniversity,Unclear spend",
  ].join("\n"), { sourceFile: "Snacky - Financial Spreadsheet - Transactions.csv" });
  const [classified] = classifyFinanceRows(parsed.rows, []);

  assert.equal(classified.importStatus, "needs_review");
  assert.equal(classified.categoryForTransaction, "Uncategorized");
  assert.ok(classified.reasons.includes("blank Transaction Type"));
});

test("Name and Currency map to the correct account", () => {
  const parsed = parseFinanceCsvText([
    "Date,Name,Transaction Amount,Currency,Money Flow,Transaction Type,Location,Transaction Description",
    "16/05/2026,Snacky,75,LYD,Money In,Revenue,,Cash",
    "16/05/2026,Snacky,10,$,Money In,Revenue,,Cash",
    "16/05/2026,Anas,40,LYD,Money Out,Miscellaneous,,Cash",
    "16/05/2026,Anas,5,$,Money Out,Miscellaneous,,Cash",
  ].join("\n"), { sourceFile: "Snacky - Financial Spreadsheet - Transactions.csv" });
  const classified = classifyFinanceRows(parsed.rows, []);

  assert.equal(classified[0].accountId, "snacky_lyd");
  assert.equal(classified[1].accountId, "snacky_usd");
  assert.equal(classified[2].accountId, "owner_lyd");
  assert.equal(classified[3].accountId, "owner_usd");
});

test("duplicate rows are shown for review instead of ignored", () => {
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
  assert.equal(classified[0].importStatus, "imported");
  assert.equal(classified[1].importStatus, "needs_review");
  assert.ok(classified[1].reasons.includes("duplicate suspected"));
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
