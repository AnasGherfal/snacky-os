import fs from "node:fs/promises";
import path from "node:path";
import {
  accountCurrency,
  financeAccountFor,
  financeAccountId,
  FINANCE_RECONCILIATION_CUTOFF_DATE,
  type FinanceAccountId,
  type FinanceCurrency,
  type FinanceTransactionEffect,
  normalizeFinanceCurrency,
} from "./finance-balance.ts";

export const FINANCE_SOURCE_FILE = "docs/current-data/financial_transactions.csv";
export const FINANCE_SOURCE_SHEET = "financial_transactions.csv";
export const SNACKY_TRANSACTIONS_SOURCE_SHEET = "Snacky Transactions";
export const HIGH_CONFIDENCE_THRESHOLD = 0.85;
export const KHALIJ_UNIVERSITY_ARABIC_NAME = "جامعة طرابلس الاهلية";

export type ImportStatus = "imported" | "auto_classified" | "needs_review" | "confirmed" | "ignored" | "skipped";
export type FinanceImportMode = "historical" | "live";

export type ParsedFinanceRow = {
  sourceFile: string;
  sourceSheet: string;
  sourceRow: number;
  record: Record<string, string>;
};

export type ExistingFinanceRow = {
  id?: string | null;
  source_file?: string | null;
  source_sheet?: string | null;
  source_row?: number | null;
  transaction_date?: string | null;
  amount?: number | string | null;
  signed_amount?: number | string | null;
  currency?: string | null;
  account_id?: string | null;
  source_account_id?: string | null;
  destination_account_id?: string | null;
  transaction_effect?: string | null;
  description?: string | null;
  original_description?: string | null;
  final_bucket?: string | null;
};

export type FinanceMachineReference = {
  id?: string | null;
  name?: string | null;
  machine_code?: string | null;
  vms_machine_id?: string | null;
  alias_name?: string | null;
};

export type FinanceClassificationContext = {
  machines?: FinanceMachineReference[];
  aliases?: FinanceMachineReference[];
};

export type ClassifiedFinanceRow = ParsedFinanceRow & {
  importStatus: ImportStatus;
  shouldInsert: boolean;
  reasons: string[];
  transactionDate: string | null;
  amount: number | null;
  signedAmount: number | null;
  direction: "money_in" | "money_out" | null;
  category: string | null;
  categoryForTransaction: string | null;
  originalDescription: string;
  duplicateKey: string | null;
  currency: FinanceCurrency;
  accountId: FinanceAccountId;
  transactionEffect: FinanceTransactionEffect;
  sourceAccountId: FinanceAccountId | null;
  destinationAccountId: FinanceAccountId | null;
  reviewReason: string | null;
  reviewGroupKey: string | null;
  suggestedCategory: string | null;
  suggestedAccount: FinanceAccountId | null;
  suggestedCurrency: FinanceCurrency;
  suggestedMachine: string | null;
  suggestedMachineId: string | null;
  suggestedSourceAccount: FinanceAccountId | null;
  suggestedDestinationAccount: FinanceAccountId | null;
  confidenceScore: number;
  clarificationQuestion: string | null;
  resolvedLocationName: string | null;
  importMode: FinanceImportMode;
};

export type FinanceReviewGroup = {
  key: string;
  title: string;
  count: number;
  sourceRows: number[];
  exampleDescriptions: string[];
  totalAmount: number;
  currency: FinanceCurrency;
  suggestedCategory: string | null;
  suggestedAccount: FinanceAccountId | null;
  suggestedMachine: string | null;
  suggestedSourceAccount: FinanceAccountId | null;
  suggestedDestinationAccount: FinanceAccountId | null;
  confidenceScore: number;
  question: string;
  reason: string;
  canConfirm: boolean;
};

type ParsedCsvTable = {
  rows: ParsedFinanceRow[];
  sourceSheet: string;
  headerRow: number;
  detectedFormat: "snacky_transactions" | "normalized";
};

const SOURCE_FILE_CANDIDATES = [
  "docs/current-data/Snacky - Financial Spreadsheet - Transactions.csv",
  "docs/current-data/financial_transactions.csv",
  "docs/source-data/Snacky - Financial Spreadsheet - Transactions.csv",
];

const SNACKY_REQUIRED_HEADERS = [
  "date",
  "name",
  "transactionamount",
  "currency",
  "moneyflow",
  "transactiontype",
  "location",
  "transactiondescription",
];

const NORMALIZED_REQUIRED_HEADERS = [
  "date",
  "transaction",
  "moneyflow",
  "transactiontype",
  "location",
  "transactiondescription",
];

const SOURCE_COLUMN_TO_RECORD_KEY: Record<string, string> = {
  date: "date",
  name: "name",
  transactionamount: "transaction",
  currency: "currency",
  moneyflow: "money_flow",
  transactiontype: "transaction_type",
  location: "location",
  transactiondescription: "transaction_description",
};

const NORMALIZED_COLUMN_TO_RECORD_KEY: Record<string, string> = {
  date: "date",
  transaction: "transaction",
  moneyflow: "money_flow",
  money_flow: "money_flow",
  transactiontype: "transaction_type",
  transaction_type: "transaction_type",
  location: "location",
  transactiondescription: "transaction_description",
  transaction_description: "transaction_description",
  signedamount: "signed_amount",
  signed_amount: "signed_amount",
  autobucket: "auto_bucket",
  auto_bucket: "auto_bucket",
  bucketoverride: "bucket_override",
  bucket_override: "bucket_override",
  finalbucket: "final_bucket",
  final_bucket: "final_bucket",
  accountid: "account_id",
  account_id: "account_id",
};

const MACHINE_ALIAS_OVERRIDES: FinanceMachineReference[] = [
  { alias_name: "KhalijUniversity", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "Khalij University", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "2510001719", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "جامعة طرابلس الاهلية", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "خليج ليبيا", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
];

const explicitReviewValues = new Set(["", "to_confirm", "to confirm", "review"]);

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current);
      rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current);
  rows.push(row);
  return rows;
}

function normalizeHeader(value: string) {
  return String(value ?? "")
    .trim()
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "");
}

function headerIndex(headers: string[]) {
  const map = new Map<string, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (normalized && !map.has(normalized)) map.set(normalized, index);
  });
  return map;
}

function hasHeaders(index: Map<string, number>, required: string[]) {
  return required.every((header) => index.has(header));
}

function detectTransactionHeader(rows: string[][]) {
  for (let index = 0; index < rows.length; index += 1) {
    const headers = headerIndex(rows[index]);
    if (hasHeaders(headers, SNACKY_REQUIRED_HEADERS)) {
      return { rowIndex: index, format: "snacky_transactions" as const, headers };
    }
  }

  if (rows.length) {
    const headers = headerIndex(rows[0]);
    if (hasHeaders(headers, NORMALIZED_REQUIRED_HEADERS)) {
      return { rowIndex: 0, format: "normalized" as const, headers };
    }
  }

  return null;
}

function isClearlyEmptyCsvRow(values: string[]) {
  return values.every((value) => !String(value ?? "").trim());
}

function recordFromRow(values: string[], headers: string[], format: ParsedCsvTable["detectedFormat"]) {
  const record: Record<string, string> = {};
  const mapper = format === "snacky_transactions" ? SOURCE_COLUMN_TO_RECORD_KEY : NORMALIZED_COLUMN_TO_RECORD_KEY;

  headers.forEach((header, index) => {
    const rawValue = values[index] ?? "";
    const normalized = normalizeHeader(header);
    const recordKey = mapper[normalized] ?? normalized;
    if (recordKey) record[recordKey] = rawValue.trim();
    if (header.trim()) record[header.trim()] = rawValue.trim();
  });

  record.__source_format = format;
  return record;
}

export function parseFinanceCsvText(text: string, options: { sourceFile?: string; sourceSheet?: string } = {}): ParsedCsvTable {
  const csvRows = parseCsvRows(text);
  const detected = detectTransactionHeader(csvRows);
  if (!detected) {
    return {
      rows: [],
      sourceSheet: options.sourceSheet ?? FINANCE_SOURCE_SHEET,
      headerRow: 0,
      detectedFormat: "normalized",
    };
  }

  const sourceFile = options.sourceFile ?? FINANCE_SOURCE_FILE;
  const sourceSheet = options.sourceSheet ?? (detected.format === "snacky_transactions" ? SNACKY_TRANSACTIONS_SOURCE_SHEET : FINANCE_SOURCE_SHEET);
  const headers = csvRows[detected.rowIndex];
  const rows: ParsedFinanceRow[] = [];

  for (let index = detected.rowIndex + 1; index < csvRows.length; index += 1) {
    const values = csvRows[index];
    if (isClearlyEmptyCsvRow(values)) continue;
    rows.push({
      sourceFile,
      sourceSheet,
      sourceRow: index + 1,
      record: recordFromRow(values, headers, detected.format),
    });
  }

  return {
    rows,
    sourceSheet,
    headerRow: detected.rowIndex + 1,
    detectedFormat: detected.format,
  };
}

export async function readFinanceImportRows() {
  for (const candidate of SOURCE_FILE_CANDIDATES) {
    const fullPath = path.join(process.cwd(), candidate);
    try {
      const text = await fs.readFile(fullPath, "utf8");
      return parseFinanceCsvText(text, { sourceFile: candidate }).rows;
    } catch {
      // Try the next source file candidate.
    }
  }
  return [];
}

function cleanValue(value: string | undefined | null) {
  const text = String(value ?? "").trim();
  return explicitReviewValues.has(text.toLowerCase()) ? "" : text;
}

function parseDate(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw || explicitReviewValues.has(raw.toLowerCase())) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    const day = first;
    const month = second;
    return toIsoDate(year, month, day);
  }

  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 20000 && serial < 70000) {
    const date = new Date(Date.UTC(1899, 11, 30 + Math.floor(serial)));
    return date.toISOString().slice(0, 10);
  }

  return null;
}

function toIsoDate(year: number, month: number, day: number) {
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function parseAmount(value: string) {
  const raw = String(value ?? "")
    .replace(/[,\s]/g, "")
    .replace(/LYD|USD|\$/gi, "")
    .trim();
  if (!raw || explicitReviewValues.has(raw.toLowerCase())) return null;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const parsed = Number(raw.replace(/[()]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  const amount = Math.round(Math.abs(parsed) * 100) / 100;
  return negative ? amount : amount;
}

function resolveAmount(record: Record<string, string>) {
  const transactionAmount = parseAmount(record.transaction ?? record["Transaction Amount"] ?? "");
  if (transactionAmount !== null) return { value: transactionAmount, source: "transaction" };
  const signedAmount = parseAmount(record.signed_amount ?? "");
  if (signedAmount !== null) return { value: signedAmount, source: "signed_amount" };
  return { value: null, source: null };
}

function resolveDirectionFromFlow(value: string) {
  const direction = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["money in", "in", "income", "revenue", "cash in"].includes(direction)) return "money_in" as const;
  if (["money out", "out", "expense", "expenses", "cash out"].includes(direction)) return "money_out" as const;
  return null;
}

function resolveDirection(record: Record<string, string>) {
  const direction = resolveDirectionFromFlow(record.money_flow ?? record["Money Flow"] ?? "");
  if (direction) return direction;
  const signed = Number(String(record.signed_amount ?? "").replace(/,/g, ""));
  if (Number.isFinite(signed) && signed > 0) return "money_in" as const;
  if (Number.isFinite(signed) && signed < 0) return "money_out" as const;
  return null;
}

function resolveCurrency(record: Record<string, string>) {
  const raw = String(record.currency ?? record.Currency ?? "").trim().toUpperCase();
  if (raw === "$" || raw === "USD" || raw.includes("DOLLAR")) return { currency: "USD" as FinanceCurrency, known: true };
  if (raw === "LYD" || raw === "LD" || raw === "ل.د" || raw.includes("DINAR")) return { currency: "LYD" as FinanceCurrency, known: true };
  if (raw) return { currency: "LYD" as FinanceCurrency, known: false };

  const text = normalizedText(record);
  if (text.includes("$") || text.includes("usd") || text.includes("dollar") || text.includes("دولار") || text.includes("Ø¯ÙˆÙ„Ø§Ø±")) {
    return { currency: "LYD" as FinanceCurrency, known: false };
  }
  return { currency: "LYD" as FinanceCurrency, known: record.__source_format !== "snacky_transactions" };
}

function normalizeLookup(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function resolveAccount(record: Record<string, string>, currency: FinanceCurrency) {
  const explicit = financeAccountId(record.account_id ?? record.account ?? record.balance_account, currency);
  if (record.account_id || record.account || record.balance_account) return { accountId: explicit, known: true };

  const hasNameColumn = Object.prototype.hasOwnProperty.call(record, "name") || Object.prototype.hasOwnProperty.call(record, "Name");
  const name = normalizeLookup(record.name ?? record.Name);
  if (name === "snacky" || name === "snackyos" || name === "snackycompany") {
    return { accountId: financeAccountFor("snacky", currency), known: true };
  }
  if (name === "anas" || name === "owner" || name === "owneranas") {
    return { accountId: financeAccountFor("owner", currency), known: true };
  }
  if (!hasNameColumn) return { accountId: financeAccountFor("snacky", currency), known: true };
  return { accountId: financeAccountFor("snacky", currency), known: false };
}

function rawCategory(record: Record<string, string>) {
  return cleanValue(record.transaction_type)
    || cleanValue(record["Transaction Type"])
    || cleanValue(record.final_bucket)
    || cleanValue(record.bucket_override)
    || cleanValue(record.auto_bucket)
    || null;
}

function resolveCategory(record: Record<string, string>) {
  return rawCategory(record) ?? "Uncategorized";
}

function normalizedText(record: Record<string, string>) {
  return [
    record.name,
    record.transaction_type,
    record.location,
    record.transaction_description,
    record.auto_bucket,
    record.bucket_override,
    record.final_bucket,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function containsAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function buildMachineLookup(context: FinanceClassificationContext) {
  const lookup = new Map<string, FinanceMachineReference>();
  const add = (key: string | null | undefined, machine: FinanceMachineReference) => {
    const normalized = normalizeLookup(key);
    if (normalized && !lookup.has(normalized)) lookup.set(normalized, machine);
  };

  for (const machine of [...(context.machines ?? []), ...MACHINE_ALIAS_OVERRIDES]) {
    add(machine.name, machine);
    add(machine.machine_code, machine);
    add(machine.vms_machine_id, machine);
    add(machine.alias_name, machine);
  }

  for (const alias of context.aliases ?? []) add(alias.alias_name, alias);
  return lookup;
}

function resolveMachine(value: string | null | undefined, lookup: Map<string, FinanceMachineReference>) {
  const normalized = normalizeLookup(value);
  if (!normalized) return { name: null, id: null };
  const machine = lookup.get(normalized);
  if (!machine) return { name: null, id: null };
  if (machine.vms_machine_id === "2510001719" || normalizeLookup(machine.alias_name) === "khalijuniversity") {
    return { name: KHALIJ_UNIVERSITY_ARABIC_NAME, id: machine.id ?? null };
  }
  return { name: machine.name ?? machine.alias_name ?? value ?? null, id: machine.id ?? null };
}

function cleanDescription(record: Record<string, string>) {
  return cleanValue(record.transaction_description ?? record["Transaction Description"]) || "";
}

function dedupeDescription(record: Record<string, string>, resolvedLocationName: string | null) {
  return [
    cleanDescription(record),
    resolvedLocationName,
    cleanValue(record.location),
    cleanValue(record.transaction_type),
  ].filter(Boolean).join(" ").toLowerCase();
}

function businessKey(row: {
  date: string | null;
  amount: number | null;
  description: string;
  currency: string | null;
  accountId: string | null;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  effect?: string | null;
}) {
  if (!row.date || row.amount === null || !Number.isFinite(row.amount)) return null;
  const accountPart = row.effect === "transfer"
    ? `${row.sourceAccountId ?? ""}->${row.destinationAccountId ?? ""}`
    : row.accountId ?? "";
  return [
    row.date,
    Math.abs(row.amount).toFixed(2),
    row.description.trim().toLowerCase().replace(/\s+/g, " "),
    normalizeFinanceCurrency(row.currency),
    row.effect ?? "",
    accountPart,
  ].join("|");
}

function sourceKey(row: { source_file?: string | null; source_sheet?: string | null; source_row?: number | null }) {
  return `${row.source_file ?? ""}|${row.source_sheet ?? ""}|${Number(row.source_row ?? 0)}`;
}

function signedAmountFor(direction: "money_in" | "money_out" | null, amount: number | null) {
  if (!direction || amount === null) return null;
  return direction === "money_out" ? -Math.abs(amount) : Math.abs(amount);
}

function inferTransactionEffect(category: string | null, direction: "money_in" | "money_out" | null): FinanceTransactionEffect {
  const normalized = normalizeLookup(category);
  if (normalized === "ownerfunding" || normalized === "ownerwithdrawal" || normalized === "bankexchange") return "transfer";
  return direction === "money_in" ? "income" : "expense";
}

function suggestedTransferAccounts(category: string | null, accountId: FinanceAccountId) {
  const currency = accountCurrency(accountId);
  const normalized = normalizeLookup(category);
  if (normalized === "ownerfunding") {
    return {
      sourceAccountId: financeAccountFor("owner", currency),
      destinationAccountId: financeAccountFor("snacky", currency),
    };
  }
  if (normalized === "ownerwithdrawal") {
    return {
      sourceAccountId: financeAccountFor("snacky", currency),
      destinationAccountId: financeAccountFor("owner", currency),
    };
  }
  return { sourceAccountId: null, destinationAccountId: null };
}

function reviewGroupForReason(reason: string) {
  if (reason.includes("date")) return "missing_date";
  if (reason.includes("amount")) return "missing_amount";
  if (reason.includes("Name")) return "unknown_name";
  if (reason.includes("currency")) return "unknown_currency";
  if (reason.includes("Money Flow") || reason.includes("direction")) return "missing_money_flow";
  if (reason.includes("Transaction Type")) return "blank_transaction_type";
  if (reason.includes("transfer") || reason.includes("exchange")) return "unclear_transfer_exchange";
  if (reason.includes("duplicate")) return "duplicate_suspected";
  return "needs_review";
}

export function classifyFinanceRows(rows: ParsedFinanceRow[], existingRows: ExistingFinanceRow[], context: FinanceClassificationContext = {}) {
  const existingSourceKeys = new Set(existingRows.filter((row) => row.source_file && row.source_sheet && row.source_row).map(sourceKey));
  const existingSourceIds = new Map(existingRows.filter((row) => row.source_file && row.source_sheet && row.source_row).map((row) => [sourceKey(row), row.id ?? null]));
  const existingBusinessKeys = new Set(
    existingRows
      .map((row) => businessKey({
        date: String(row.transaction_date ?? "") || null,
        amount: row.amount === null || row.amount === undefined ? Math.abs(Number(row.signed_amount ?? NaN)) : Math.abs(Number(row.amount)),
        description: String(row.original_description ?? row.description ?? ""),
        currency: row.currency ?? "LYD",
        accountId: row.account_id ?? null,
        sourceAccountId: row.source_account_id ?? null,
        destinationAccountId: row.destination_account_id ?? null,
        effect: row.transaction_effect ?? null,
      }))
      .filter((key): key is string => Boolean(key)),
  );
  const seenBusinessKeys = new Set<string>();
  const machineLookup = buildMachineLookup(context);

  return rows.map((row): ClassifiedFinanceRow => {
    const transactionDate = parseDate(row.record.date ?? row.record.Date ?? "");
    const rawAmount = resolveAmount(row.record);
    const direction = resolveDirection(row.record);
    const originalDescription = cleanDescription(row.record);
    const currencyResult = resolveCurrency(row.record);
    const accountResult = resolveAccount(row.record, currencyResult.currency);
    const category = resolveCategory(row.record);
    const hadBlankCategory = !rawCategory(row.record);
    const location = cleanValue(row.record.location ?? row.record.Location);
    const machine = resolveMachine(location, machineLookup);
    const transactionEffect = inferTransactionEffect(category, direction);
    const transfer = suggestedTransferAccounts(category, accountResult.accountId);
    const amount = rawAmount.value;
    const signedAmount = signedAmountFor(direction, amount);
    const duplicateKey = businessKey({
      date: transactionDate,
      amount,
      description: dedupeDescription(row.record, machine.name),
      currency: currencyResult.currency,
      accountId: accountResult.accountId,
      sourceAccountId: transfer.sourceAccountId,
      destinationAccountId: transfer.destinationAccountId,
      effect: transactionEffect,
    });
    const currentSourceKey = sourceKey({ source_file: row.sourceFile, source_sheet: row.sourceSheet, source_row: row.sourceRow });
    const hasSourceDuplicate = existingSourceKeys.has(currentSourceKey);
    const hasBusinessDuplicate = duplicateKey ? existingBusinessKeys.has(duplicateKey) || seenBusinessKeys.has(duplicateKey) : false;
    const text = normalizedText(row.record);
    const reasons: string[] = [];

    if (!transactionDate) reasons.push("missing date");
    if (amount === null) reasons.push("missing amount");
    if (!accountResult.known) reasons.push("unknown Name");
    if (!currencyResult.known) reasons.push("unknown currency");
    if (!direction) reasons.push("missing Money Flow");
    if (hadBlankCategory) reasons.push("blank Transaction Type");
    if (transactionEffect === "transfer" && (!transfer.sourceAccountId || !transfer.destinationAccountId)) reasons.push("unclear transfer/exchange");
    if (containsAny(text, ["exchange", "bank / exchange", "currency exchange", "شراء دولار", "Ø´Ø±Ø§Ø¡ Ø¯ÙˆÙ„Ø§Ø±"])) reasons.push("unclear transfer/exchange");
    if (hasBusinessDuplicate && !hasSourceDuplicate) reasons.push("duplicate suspected");

    let importStatus: ImportStatus;
    let shouldInsert = Boolean(transactionDate && amount !== null && direction && accountResult.known && currencyResult.known && category);
    if (hasSourceDuplicate) {
      importStatus = "confirmed";
      shouldInsert = false;
    } else if (reasons.length) {
      importStatus = "needs_review";
      shouldInsert = false;
    } else if (machine.name || row.record.__source_format === "snacky_transactions" || transactionEffect === "transfer") {
      importStatus = "auto_classified";
    } else {
      importStatus = "imported";
    }

    if (duplicateKey && !hasSourceDuplicate) seenBusinessKeys.add(duplicateKey);

    const reviewReason = reasons.join("; ") || null;
    const firstReason = reasons[0] ?? "";
    const importMode = transactionDate && transactionDate <= FINANCE_RECONCILIATION_CUTOFF_DATE ? "historical" : "live";
    const sourceAccountId = transactionEffect === "transfer" ? transfer.sourceAccountId : null;
    const destinationAccountId = transactionEffect === "transfer" ? transfer.destinationAccountId : null;

    return {
      ...row,
      importStatus,
      shouldInsert,
      reasons,
      transactionDate,
      amount,
      signedAmount,
      direction,
      category: rawCategory(row.record),
      categoryForTransaction: category,
      originalDescription,
      duplicateKey,
      currency: currencyResult.currency,
      accountId: transactionEffect === "transfer" && sourceAccountId ? sourceAccountId : accountResult.accountId,
      transactionEffect,
      sourceAccountId,
      destinationAccountId,
      reviewReason,
      reviewGroupKey: reasons.length ? reviewGroupForReason(firstReason) : null,
      suggestedCategory: category,
      suggestedAccount: accountResult.accountId,
      suggestedCurrency: currencyResult.currency,
      suggestedMachine: machine.name,
      suggestedMachineId: machine.id,
      suggestedSourceAccount: sourceAccountId,
      suggestedDestinationAccount: destinationAccountId,
      confidenceScore: importStatus === "needs_review" ? 0.55 : 0.92,
      clarificationQuestion: reasons.length ? "Confirm this source row before it affects finance." : null,
      resolvedLocationName: machine.name ?? (location || null),
      importMode,
    };
  });
}

export function canInsertClassifiedRow(row: ClassifiedFinanceRow) {
  return row.shouldInsert && row.importStatus !== "ignored" && row.importStatus !== "needs_review" && row.importStatus !== "confirmed";
}

export function forceConfirmClassifiedRow(row: ClassifiedFinanceRow): ClassifiedFinanceRow {
  if (!row.transactionDate || !row.direction || row.amount === null || !row.suggestedCategory) return row;
  return {
    ...row,
    importStatus: "confirmed",
    shouldInsert: true,
    reasons: [],
    reviewReason: null,
    categoryForTransaction: row.suggestedCategory,
    accountId: row.suggestedSourceAccount ?? row.suggestedAccount ?? row.accountId,
    sourceAccountId: row.suggestedSourceAccount ?? row.sourceAccountId,
    destinationAccountId: row.suggestedDestinationAccount ?? row.destinationAccountId,
  };
}

export function buildFinanceTransaction(row: ClassifiedFinanceRow, createdBy?: string | null, importBatchId?: string | null) {
  if (!canInsertClassifiedRow(row) || !row.transactionDate || !row.direction || row.amount === null || row.signedAmount === null || !row.categoryForTransaction) {
    return null;
  }

  return {
    transaction_date: row.transactionDate,
    direction: row.transactionEffect === "transfer" ? "money_out" : row.direction,
    transaction_kind: "spreadsheet_import",
    transaction_type: cleanValue(row.record.transaction_type) || null,
    location: row.resolvedLocationName ?? (cleanValue(row.record.location) || null),
    description: row.originalDescription || row.resolvedLocationName || null,
    original_description: row.originalDescription || null,
    amount: row.amount,
    signed_amount: row.transactionEffect === "transfer" ? -Math.abs(row.amount) : row.signedAmount,
    currency: row.currency,
    account_id: row.transactionEffect === "transfer" ? row.sourceAccountId : row.accountId,
    transaction_effect: row.transactionEffect,
    source_account_id: row.sourceAccountId,
    destination_account_id: row.destinationAccountId,
    bucket: cleanValue(row.record.auto_bucket) || null,
    bucket_override: cleanValue(row.record.bucket_override) || null,
    final_bucket: row.categoryForTransaction,
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    import_status: row.importStatus,
    source_file: row.sourceFile,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    import_batch_id: importBatchId ?? null,
    review_reason: row.reviewReason,
    suggested_category: row.suggestedCategory,
    suggested_account: row.suggestedAccount,
    suggested_machine: row.suggestedMachine,
    confidence_score: row.confidenceScore,
    related_machine_id: row.suggestedMachineId,
    created_by: createdBy ?? null,
    original_csv_row: row.record,
    metadata: {
      source_format: row.record.__source_format ?? null,
      import_mode: row.importMode,
      opening_balance_cutoff_date: FINANCE_RECONCILIATION_CUTOFF_DATE,
      original_row: row.record,
      duplicate_key: row.duplicateKey,
      classification: {
        confidence_score: row.confidenceScore,
        account_id: row.accountId,
        currency: row.currency,
        transaction_effect: row.transactionEffect,
        source_account_id: row.sourceAccountId,
        destination_account_id: row.destinationAccountId,
        suggested_machine: row.suggestedMachine,
      },
    },
  };
}

export function buildFinanceImportStageRow(row: ClassifiedFinanceRow, transactionId?: string | null, importBatchId?: string | null) {
  return {
    import_batch_id: importBatchId ?? null,
    source_file: row.sourceFile,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    import_status: row.importStatus,
    transaction_date: row.transactionDate,
    raw_date: row.record.date ?? row.record.Date ?? null,
    amount: row.amount,
    signed_amount: row.signedAmount,
    raw_amount: row.record.transaction ?? row.record["Transaction Amount"] ?? row.record.signed_amount ?? null,
    direction: row.direction,
    raw_direction: row.record.money_flow ?? row.record["Money Flow"] ?? null,
    currency: row.currency,
    account_id: row.accountId,
    transaction_effect: row.transactionEffect,
    source_account_id: row.sourceAccountId,
    destination_account_id: row.destinationAccountId,
    category: row.categoryForTransaction,
    raw_category: rawCategory(row.record),
    original_description: row.originalDescription || null,
    review_reason: row.reviewReason,
    review_group_key: row.reviewGroupKey,
    suggested_category: row.suggestedCategory,
    suggested_account: row.suggestedAccount,
    suggested_currency: row.suggestedCurrency,
    suggested_machine: row.suggestedMachine,
    suggested_machine_id: row.suggestedMachineId,
    suggested_source_account: row.suggestedSourceAccount,
    suggested_destination_account: row.suggestedDestinationAccount,
    confidence_score: row.confidenceScore,
    clarification_question: row.clarificationQuestion,
    financial_transaction_id: transactionId ?? null,
    raw_record: {
      ...row.record,
      import_mode: row.importMode,
      opening_balance_cutoff_date: FINANCE_RECONCILIATION_CUTOFF_DATE,
    },
    updated_at: new Date().toISOString(),
  };
}

function rowDescription(row: Pick<ClassifiedFinanceRow, "originalDescription" | "record" | "resolvedLocationName">) {
  return cleanValue(row.originalDescription) || row.resolvedLocationName || cleanValue(row.record.transaction_type) || cleanValue(row.record.location) || "Unclear transaction";
}

export function buildFinanceReviewGroups(rows: ClassifiedFinanceRow[]) {
  const groups = new Map<string, ClassifiedFinanceRow[]>();
  for (const row of rows) {
    if (row.importStatus !== "needs_review") continue;
    const key = row.reviewGroupKey ?? "needs_review";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return Array.from(groups.entries())
    .map(([key, groupRows]): FinanceReviewGroup => {
      const confidence = groupRows.reduce((sum, row) => sum + row.confidenceScore, 0) / Math.max(groupRows.length, 1);
      const first = groupRows[0];
      const examples = Array.from(new Set(groupRows.map(rowDescription))).slice(0, 3);
      const totalAmount = groupRows.reduce((sum, row) => sum + Math.abs(Number(row.amount ?? 0)), 0);
      const reason = first.reviewReason ?? "needs review";
      return {
        key,
        title: groupTitle(key, groupRows.length),
        count: groupRows.length,
        sourceRows: groupRows.map((row) => row.sourceRow),
        exampleDescriptions: examples,
        totalAmount: Math.round(totalAmount * 100) / 100,
        currency: first.currency,
        suggestedCategory: first.suggestedCategory,
        suggestedAccount: first.suggestedAccount,
        suggestedMachine: first.suggestedMachine,
        suggestedSourceAccount: first.suggestedSourceAccount,
        suggestedDestinationAccount: first.suggestedDestinationAccount,
        confidenceScore: Math.round(confidence * 100) / 100,
        question: first.clarificationQuestion ?? "Confirm these source rows one at a time.",
        reason,
        canConfirm: false,
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function groupTitle(key: string, count: number) {
  if (key === "missing_date") return `${count} rows are missing a valid date`;
  if (key === "missing_amount") return `${count} rows are missing a valid amount`;
  if (key === "unknown_name") return `${count} rows have an unknown Name`;
  if (key === "unknown_currency") return `${count} rows have an unknown currency`;
  if (key === "missing_money_flow") return `${count} rows are missing Money Flow`;
  if (key === "blank_transaction_type") return `${count} rows are Uncategorized`;
  if (key === "unclear_transfer_exchange") return `${count} rows need transfer or exchange review`;
  if (key === "duplicate_suspected") return `${count} rows may be duplicates`;
  return `${count} rows need review`;
}

export function buildFinanceClarificationPrompts(groups: FinanceReviewGroup[]) {
  return groups.slice(0, 10).map((group) => `${group.title}: ${group.reason}`);
}

export function sourceKeyForFinanceRow(row: Pick<ParsedFinanceRow, "sourceFile" | "sourceSheet" | "sourceRow">) {
  return `${row.sourceFile}|${row.sourceSheet}|${row.sourceRow}`;
}

export function importModeForDate(date: string | null | undefined): FinanceImportMode {
  return date && date <= FINANCE_RECONCILIATION_CUTOFF_DATE ? "historical" : "live";
}
