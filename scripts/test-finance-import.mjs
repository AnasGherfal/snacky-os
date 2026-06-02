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
import { resolveCashCollectionTransactionDateTime } from "../src/lib/cash-finance.ts";
import { buildFinanceImportStageRow, buildFinanceTransaction, classifyFinanceRows, parseFinanceCsvText } from "../src/lib/finance-import.ts";

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
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_in", amount: 1000, signed_amount: 1000, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "income", final_bucket: "Revenue" },
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 250, signed_amount: -250, account_id: "snacky_lyd", currency: "LYD", transaction_effect: "expense", final_bucket: "Rent" },
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 700, signed_amount: -700, currency: "LYD", transaction_effect: "transfer", source_account_id: "owner_lyd", destination_account_id: "snacky_lyd", final_bucket: "Owner Funding" },
    { transaction_date: "2026-05-16", transaction_status: "active", direction: "money_out", amount: 100, signed_amount: -100, currency: "LYD", transaction_effect: "transfer", source_account_id: "snacky_lyd", destination_account_id: "owner_lyd", final_bucket: "Owner Withdrawal" },
  ];

  assert.equal(sumFinanceProfitRows(rows, "LYD"), 750);
});

test("cash collection finance transaction date comes from collection datetime", () => {
  const resolved = resolveCashCollectionTransactionDateTime({
    collected_at: "2026-05-20T08:45:00.000Z",
    counted_at: "2026-05-22T13:00:00.000Z",
  });

  assert.equal(resolved.transactionDatetime, "2026-05-20T08:45:00.000Z");
  assert.equal(resolved.transactionDate, "2026-05-20");
});

test("Snacky Transactions CSV header is detected after summary rows, including the exported NameTransaction Amount header", () => {
  const csv = [
    "Summary,,,,,,,",
    "Anas LYD,-24360.50,,,,,,",
    "Snacky LYD,8914.00,,,,,,",
    "Date,NameTransaction Amount,Transaction,Currency,Money Flow,Transaction Type,Location,Transaction Description",
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

test("every non-empty transaction row is retained, even when required values are blank", () => {
  const parsed = parseFinanceCsvText([
    "Date,NameTransaction Amount,Transaction,Currency,Money Flow,Transaction Type,Location,Transaction Description",
    ",Anas,1800,$,Money Out,,,Machine purchase",
    "16/05/2026,Snacky,75,LYD,Money Out,,KhalijUniversity,Unclear spend",
  ].join("\n"), { sourceFile: "Snacky - Financial Spreadsheet - Transactions.csv" });
  const classified = classifyFinanceRows(parsed.rows, []);

  assert.equal(classified.length, 2);
  assert.equal(classified[0].importStatus, "needs_review");
  assert.equal(classified[0].record.name, "Anas");
  assert.equal(classified[0].record.transaction, "1800");
  assert.equal(classified[1].importStatus, "needs_review");
  assert.equal(classified[1].categoryForTransaction, null);
  assert.ok(classified[1].reasons.includes("blank Transaction Type"));
});

test("Name and Currency provide the suggested account without changing the original Name", () => {
  const parsed = parseFinanceCsvText([
    "Date,Name,Transaction Amount,Currency,Money Flow,Transaction Type,Location,Transaction Description",
    "16/05/2026,Snacky,75,LYD,Money In,Revenue,,Cash",
    "16/05/2026,Snacky,10,$,Money In,Revenue,,Cash",
    "16/05/2026,Anas,40,LYD,Money Out,Miscellaneous,,Cash",
    "16/05/2026,Anas,5,$,Money Out,Miscellaneous,,Cash",
    "16/05/2026,Doa,12,LYD,Money Out,Salary / Employee Payment,,Salary",
    "16/05/2026,Ahmed,8,$,Money Out,Salary / Employee Payment,,Salary",
  ].join("\n"), { sourceFile: "Snacky - Financial Spreadsheet - Transactions.csv" });
  const classified = classifyFinanceRows(parsed.rows, []);

  assert.equal(classified[0].accountId, "snacky_lyd");
  assert.equal(classified[1].accountId, "snacky_usd");
  assert.equal(classified[2].accountId, "owner_lyd");
  assert.equal(classified[3].accountId, "owner_usd");
  assert.equal(classified[4].accountId, "snacky_lyd");
  assert.equal(classified[5].accountId, "snacky_usd");
  assert.equal(classified[4].record.name, "Doa");
  assert.equal(classified[5].record.name, "Ahmed");
});

test("Transaction Type is copied exactly and Money Flow alone controls direction", () => {
  const parsed = parseFinanceCsvText([
    "Date,Name,Transaction Amount,Currency,Money Flow,Transaction Type,Location,Transaction Description",
    "16/05/2026,Snacky,75,LYD,Money Out,Product Restocking,,Inventory buy",
    "16/05/2026,Snacky,40,LYD,Money Out,Rent,,Rent",
    "16/05/2026,Snacky,120,LYD,Money In,Revenue,,Cash counted",
    "16/05/2026,Snacky,10,LYD,Money Out,Charity,,Donation",
    "16/05/2026,Snacky,20,LYD,Money In,Ads,,Ad income",
    "16/05/2026,Snacky,30,LYD,Money Out,Shipping,,Shipping",
  ].join("\n"), { sourceFile: "Snacky - Financial Spreadsheet - Transactions.csv" });
  const classified = classifyFinanceRows(parsed.rows, []);

  assert.deepEqual(classified.map((item) => item.categoryForTransaction), [
    "Product Restocking",
    "Rent",
    "Revenue",
    "Charity",
    "Ads",
    "Shipping",
  ]);
  assert.deepEqual(classified.map((item) => item.direction), [
    "money_out",
    "money_out",
    "money_in",
    "money_out",
    "money_in",
    "money_out",
  ]);
});

test("duplicate-looking rows are kept as separate imported rows", () => {
  const rows = [
    row(2, {
      date: "2026-01-01",
      transaction: "100",
      currency: "LYD",
      money_flow: "Money In",
      transaction_type: "Revenue",
      name: "Snacky",
      location: "HTMall",
      transaction_description: "same deposit",
    }),
    row(3, {
      date: "2026-01-01",
      transaction: "100",
      currency: "LYD",
      money_flow: "Money In",
      transaction_type: "Revenue",
      name: "Snacky",
      location: "HTMall",
      transaction_description: "same deposit",
    }),
  ];

  const classified = classifyFinanceRows(rows, []);
  assert.equal(classified[0].importStatus, "imported");
  assert.equal(classified[1].importStatus, "imported");
  assert.deepEqual(classified[1].reasons, []);
});

test("stage rows and ledger rows preserve exact source fields one-to-one", () => {
  const [classified] = classifyFinanceRows([
    row(20, {
      date: "16/05/2026",
      name: "Ahmed",
      transaction: "42",
      currency: "LYD",
      money_flow: "Money Out",
      transaction_type: "Shipping",
      location: "KhalijUniversity",
      transaction_description: "Delivery fee",
    }),
  ], []);
  const stage = buildFinanceImportStageRow(classified, null, "batch-1");
  const transaction = buildFinanceTransaction(classified, "user-1", "batch-1");

  assert.equal(stage.source_row, 20);
  assert.equal(stage.raw_record.name, "Ahmed");
  assert.equal(stage.raw_record.transaction_type, "Shipping");
  assert.equal(stage.raw_record.location, "KhalijUniversity");
  assert.equal(stage.raw_record.transaction_description, "Delivery fee");
  assert.equal(transaction.transaction_type, "Shipping");
  assert.equal(transaction.final_bucket, "Shipping");
  assert.equal(transaction.location, "KhalijUniversity");
  assert.equal(transaction.description, "Delivery fee");
  assert.equal(transaction.counterparty_text, "Ahmed");
  assert.equal(transaction.direction, "money_out");
  assert.equal(transaction.signed_amount, -42);
});

test("needs-review rows remain visible in staging and do not affect balances", () => {
  const [classified] = classifyFinanceRows([
    row(2, {
      date: "",
      name: "Snacky",
      transaction: "4680",
      currency: "LYD",
      money_flow: "Money Out",
      transaction_type: "",
      location: "TO_CONFIRM",
      transaction_description: "buy dollars",
    }),
  ], []);

  const stage = buildFinanceImportStageRow(classified, null, "batch-1");
  assert.equal(classified.importStatus, "needs_review");
  assert.equal(stage.import_status, "needs_review");
  assert.equal(stage.raw_record.transaction_description, "buy dollars");
  assert.equal(buildFinanceTransaction(classified, "user-1", "batch-1"), null);
  assert.equal(isBalanceAffectingTransaction({ transaction_status: "active", import_status: "needs_review", signed_amount: -4680 }), false);
});
