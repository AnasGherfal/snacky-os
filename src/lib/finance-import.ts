import fs from "node:fs/promises";
import path from "node:path";
import {
  accountCurrency,
  financeAccountFor,
  financeAccountId,
  type FinanceAccountId,
  type FinanceCurrency,
  type FinanceTransactionEffect,
  normalizeFinanceCurrency,
} from "./finance-balance.ts";

export const FINANCE_SOURCE_FILE = "docs/current-data/financial_transactions.csv";
export const FINANCE_SOURCE_SHEET = "financial_transactions.csv";
export const HIGH_CONFIDENCE_THRESHOLD = 0.85;
export const KHALIJ_UNIVERSITY_ARABIC_NAME = "جامعة طرابلس الاهليه";

export type ImportStatus = "imported" | "auto_classified" | "needs_review" | "confirmed" | "ignored" | "skipped";

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

type AmountResult = { value: number | null; source: string | null };

type Inference = {
  category: string | null;
  accountId: FinanceAccountId;
  transactionEffect: FinanceTransactionEffect;
  sourceAccountId: FinanceAccountId | null;
  destinationAccountId: FinanceAccountId | null;
  confidence: number;
  reason: string | null;
  groupKey: string | null;
  question: string | null;
  machineName: string | null;
  machineId: string | null;
  resolvedLocationName: string | null;
  usedSuggestion: boolean;
  holdForReview?: boolean;
};

const MACHINE_ALIAS_OVERRIDES: FinanceMachineReference[] = [
  { alias_name: "KhalijUniversity", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "Khalij University", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "2510001719", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
  { alias_name: "خليج ليبيا", name: KHALIJ_UNIVERSITY_ARABIC_NAME, vms_machine_id: "2510001719" },
];

const explicitReviewValues = new Set(["", "TO_CONFIRM", "Review", "review", "to confirm"]);

function parseCsv(text: string) {
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
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current);
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header, index) => header.trim().replace(index === 0 ? /^\uFEFF/ : /^$/, ""));
  return rows.slice(1).map((values, index): ParsedFinanceRow => ({
    sourceFile: FINANCE_SOURCE_FILE,
    sourceSheet: FINANCE_SOURCE_SHEET,
    sourceRow: index + 2,
    record: Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] ?? ""])),
  }));
}

export async function readFinanceImportRows() {
  const csvPath = path.join(process.cwd(), "docs", "current-data", "financial_transactions.csv");
  return parseCsv(await fs.readFile(csvPath, "utf8"));
}

function parseDate(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : raw;
}

function parseAmount(value: string) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw || raw.toUpperCase() === "TO_CONFIRM") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function resolveAmount(record: Record<string, string>): AmountResult {
  const signedAmount = parseAmount(record.signed_amount);
  if (signedAmount !== null) return { value: signedAmount, source: "signed_amount" };
  const transactionAmount = parseAmount(record.transaction);
  if (transactionAmount !== null) return { value: transactionAmount, source: "transaction" };
  return { value: null, source: null };
}

function resolveDirectionFromFlow(value: string) {
  const direction = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (["money in", "in", "income", "revenue", "cash in"].includes(direction)) return "money_in";
  if (["money out", "out", "expense", "expenses", "cash out"].includes(direction)) return "money_out";
  return null;
}

function resolveDirection(record: Record<string, string>, amount: AmountResult) {
  const direction = resolveDirectionFromFlow(record.money_flow ?? "");
  if (direction) return direction;
  if (amount.source === "signed_amount" && amount.value !== null && amount.value > 0) return "money_in";
  if (amount.source === "signed_amount" && amount.value !== null && amount.value < 0) return "money_out";
  return null;
}

function cleanValue(value: string | undefined) {
  const text = String(value ?? "").trim();
  return explicitReviewValues.has(text) ? "" : text;
}

function clearCategory(value: string | undefined) {
  return cleanValue(value) || null;
}

function rawCategory(record: Record<string, string>) {
  return (
    String(record.final_bucket ?? "").trim()
    || String(record.bucket_override ?? "").trim()
    || String(record.auto_bucket ?? "").trim()
    || String(record.transaction_type ?? "").trim()
    || null
  );
}

function resolveCategory(record: Record<string, string>) {
  return clearCategory(record.final_bucket) ?? clearCategory(record.bucket_override) ?? clearCategory(record.auto_bucket) ?? clearCategory(record.transaction_type);
}

function normalizeDescription(value: string) {
  const text = value.trim().replace(/\s+/g, " ").toLowerCase();
  return explicitReviewValues.has(text.toUpperCase()) || text === "to_confirm" ? "" : text;
}

function normalizeLookup(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function normalizedText(record: Record<string, string>) {
  return [
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

function recordCurrency(record: Record<string, string>) {
  const explicit = String(record.currency ?? record.Currency ?? record.account_currency ?? "").trim().toUpperCase();
  if (explicit === "USD" || explicit === "LYD") return { currency: normalizeFinanceCurrency(explicit), ambiguous: false };
  const text = normalizedText(record);
  if (containsAny(text, ["usd", "dollar", "دولار"])) return { currency: "LYD" as FinanceCurrency, ambiguous: true };
  return { currency: "LYD" as FinanceCurrency, ambiguous: false };
}

function dedupeDescription(record: Record<string, string>) {
  const description = normalizeDescription(record.transaction_description ?? "");
  if (description) return description;
  return [record.location, record.transaction_type, record.auto_bucket, record.final_bucket].map((value) => cleanValue(value)).filter(Boolean).join(" ").toLowerCase();
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
    normalizeDescription(row.description),
    normalizeFinanceCurrency(row.currency),
    row.effect ?? "",
    accountPart,
  ].join("|");
}

function sourceKey(row: { source_file?: string | null; source_sheet?: string | null; source_row?: number | null }) {
  const sourceFile = row.source_file && row.source_file !== row.source_sheet ? row.source_file : FINANCE_SOURCE_FILE;
  return `${sourceFile}|${row.source_sheet ?? ""}|${Number(row.source_row ?? 0)}`;
}

function signedAmountFor(direction: "money_in" | "money_out" | null, amount: number | null) {
  if (!direction || amount === null) return null;
  return direction === "money_out" ? -Math.abs(amount) : Math.abs(amount);
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

  for (const alias of context.aliases ?? []) {
    add(alias.alias_name, alias);
  }

  return lookup;
}

function resolveMachine(value: string | null | undefined, lookup: Map<string, FinanceMachineReference>) {
  const normalized = normalizeLookup(value);
  if (!normalized) return { name: null, id: null };
  const machine = lookup.get(normalized);
  if (!machine) return { name: null, id: null };
  if (machine.vms_machine_id === "2510001719" || normalizeLookup(machine.alias_name) === "khalijuniversity" || normalizeLookup(machine.name) === normalizeLookup("خليج ليبيا")) {
    return { name: KHALIJ_UNIVERSITY_ARABIC_NAME, id: machine.id ?? null };
  }
  return { name: machine.name ?? machine.alias_name ?? value ?? null, id: machine.id ?? null };
}

function isOwnerPerson(record: Record<string, string>) {
  const type = normalizeLookup(record.transaction_type);
  const bucket = normalizeLookup(record.final_bucket);
  return type === "anas" || bucket === "ownerdraw";
}

function isToSnacky(record: Record<string, string>) {
  return normalizeLookup(record.transaction_type) === "tosnacky";
}

function isFromSnacky(record: Record<string, string>) {
  return normalizeLookup(record.transaction_type) === "fromsnacky";
}

function mirrorKey(date: string | null, amount: number | null) {
  if (!date || amount === null) return null;
  return `${date}|${Math.abs(amount).toFixed(2)}`;
}

function buildMirrorSets(rows: ParsedFinanceRow[]) {
  const ownerOut = new Set<string>();
  const toSnackyOut = new Set<string>();

  for (const row of rows) {
    const date = parseDate(row.record.date ?? "");
    const amount = resolveAmount(row.record);
    const direction = resolveDirection(row.record, amount);
    const key = mirrorKey(date, amount.value === null ? null : Math.abs(amount.value));
    if (!key || direction !== "money_out") continue;
    if (isOwnerPerson(row.record)) ownerOut.add(key);
    if (isToSnacky(row.record)) toSnackyOut.add(key);
  }

  return { ownerOut, toSnackyOut };
}

function inferRow(
  row: ParsedFinanceRow,
  args: {
    direction: "money_in" | "money_out" | null;
    currency: FinanceCurrency;
    currencyAmbiguous: boolean;
    rawCategoryValue: string | null;
    explicitCategory: string | null;
    machineLookup: Map<string, FinanceMachineReference>;
    mirrorSets: ReturnType<typeof buildMirrorSets>;
    date: string | null;
    amount: number | null;
  },
): Inference {
  const { record } = row;
  const text = normalizedText(record);
  const location = cleanValue(record.location);
  const machine = resolveMachine(location, args.machineLookup);
  const defaultAccount = financeAccountFor("snacky", args.currency);
  const explicitAccount = financeAccountId(record.account_id ?? record.account ?? record.balance_account, args.currency);
  const base: Inference = {
    category: args.explicitCategory,
    accountId: explicitAccount || defaultAccount,
    transactionEffect: args.direction === "money_in" ? "income" : "expense",
    sourceAccountId: null,
    destinationAccountId: null,
    confidence: args.explicitCategory ? 1 : 0.4,
    reason: args.explicitCategory ? null : "category unclear",
    groupKey: args.explicitCategory ? null : "category_unclear",
    question: args.explicitCategory ? null : "What category and account should these transactions use?",
    machineName: machine.name,
    machineId: machine.id,
    resolvedLocationName: machine.name,
    usedSuggestion: false,
  };

  if (args.currencyAmbiguous) {
    return {
      ...base,
      category: "Currency Exchange",
      transactionEffect: "transfer",
      sourceAccountId: "snacky_lyd",
      destinationAccountId: "snacky_usd",
      confidence: 0.55,
      reason: "currency or exchange rate unclear",
      groupKey: "unknown_currency",
      question: "I found USD or dollar-related transactions. Should they stay separated in USD, or is there an exchange rate to convert LYD and USD?",
      usedSuggestion: true,
      holdForReview: true,
    };
  }

  const key = mirrorKey(args.date, args.amount);
  if (args.direction === "money_in" && key && isFromSnacky(record) && args.mirrorSets.ownerOut.has(key)) {
    return {
      ...base,
      confidence: 1,
      reason: "mirror side of an internal owner transfer already represented",
      groupKey: "mirrored_internal_transfer",
      question: null,
      usedSuggestion: true,
      holdForReview: false,
    };
  }
  if (args.direction === "money_in" && key && normalizeLookup(cleanValue(record.transaction_type)) === "" && args.mirrorSets.toSnackyOut.has(key)) {
    return {
      ...base,
      confidence: 1,
      reason: "mirror side of owner funding already represented",
      groupKey: "mirrored_internal_transfer",
      question: null,
      usedSuggestion: true,
      holdForReview: false,
    };
  }

  if (containsAny(text, ["opening balance", "opening_balance", "رصيد افتتاحي"])) {
    return {
      ...base,
      category: "Opening Balance",
      transactionEffect: "opening_balance",
      accountId: defaultAccount,
      confidence: 0.95,
      reason: null,
      groupKey: null,
      question: null,
      usedSuggestion: true,
    };
  }

  if (containsAny(text, ["تعديل ميزاني", "تعديل الميزاني", "balance adjustment"])) {
    return {
      ...base,
      category: "Balance Adjustment",
      transactionEffect: "opening_balance",
      accountId: defaultAccount,
      confidence: 0.6,
      reason: "balance adjustment needs account confirmation",
      groupKey: "balance_adjustment",
      question: "I found balance adjustment rows. Should these initialize an account balance instead of being treated as income or expense?",
      usedSuggestion: true,
      holdForReview: true,
    };
  }

  if (isToSnacky(record)) {
    return {
      ...base,
      category: "Owner Funding",
      transactionEffect: "transfer",
      accountId: "snacky_lyd",
      sourceAccountId: "owner_lyd",
      destinationAccountId: "snacky_lyd",
      confidence: 0.92,
      reason: null,
      groupKey: null,
      question: null,
      usedSuggestion: true,
    };
  }

  if (isFromSnacky(record) || isOwnerPerson(record)) {
    return {
      ...base,
      category: "Owner Transfer",
      transactionEffect: "transfer",
      accountId: "snacky_lyd",
      sourceAccountId: "snacky_lyd",
      destinationAccountId: "owner_lyd",
      confidence: isOwnerPerson(record) ? 0.9 : 0.78,
      reason: isOwnerPerson(record) ? null : "owner transfer direction needs confirmation",
      groupKey: isOwnerPerson(record) ? null : "cash_transfer",
      question: isOwnerPerson(record) ? null : "I found transfers between Owner and Snacky. Should these be treated as Owner Funding or Owner Transfer instead of expenses?",
      usedSuggestion: true,
      holdForReview: !isOwnerPerson(record),
    };
  }

  if (containsAny(text, ["product restocking", "inventory"]) && args.direction === "money_out") {
    return {
      ...base,
      category: "Inventory Purchase",
      transactionEffect: "expense",
      accountId: defaultAccount,
      confidence: 0.96,
      reason: null,
      groupKey: null,
      question: null,
      usedSuggestion: !args.explicitCategory || args.explicitCategory !== "Inventory Purchase",
    };
  }

  if (containsAny(text, ["revenue"]) && args.direction === "money_in") {
    return {
      ...base,
      category: "Machine Revenue",
      transactionEffect: "income",
      accountId: defaultAccount,
      confidence: machine.name ? 0.97 : 0.9,
      reason: null,
      groupKey: null,
      question: machine.name ? null : "I found revenue rows with machine/location names I cannot map. Which machine should these belong to?",
      usedSuggestion: true,
      holdForReview: false,
    };
  }

  if (containsAny(text, ["rent", "ايجار", "اجار"]) && args.direction === "money_out") {
    return { ...base, category: "Rent", transactionEffect: "expense", accountId: defaultAccount, confidence: 0.92, reason: null, groupKey: null, question: null, usedSuggestion: true };
  }

  if (containsAny(text, ["ads", "دعاي", "اعلان"]) && args.direction === "money_in") {
    return { ...base, category: "Advertising Income", transactionEffect: "income", accountId: defaultAccount, confidence: 0.9, reason: null, groupKey: null, question: null, usedSuggestion: true };
  }

  if (containsAny(text, ["shipping", "شحن", "تخليص"]) && args.direction === "money_out") {
    return { ...base, category: "Shipping", transactionEffect: "expense", accountId: defaultAccount, confidence: 0.88, reason: null, groupKey: null, question: null, usedSuggestion: true };
  }

  if (containsAny(text, ["storage", "مخزن"]) && args.direction === "money_out") {
    return { ...base, category: "Storage", transactionEffect: "expense", accountId: defaultAccount, confidence: 0.86, reason: null, groupKey: null, question: null, usedSuggestion: true };
  }

  if (containsAny(text, ["fixed costs", "operations"]) && args.direction === "money_out") {
    return { ...base, category: args.explicitCategory ?? "Operations", transactionEffect: "expense", accountId: defaultAccount, confidence: 0.88, reason: null, groupKey: null, question: null, usedSuggestion: !args.explicitCategory };
  }

  if (args.explicitCategory) return base;

  const pattern = normalizeLookup(record.transaction_type) || normalizeLookup(record.transaction_description) || "unknown";
  return {
    ...base,
    category: args.direction === "money_in" ? "Unclassified Income" : args.direction === "money_out" ? "Unclassified Expense" : null,
    accountId: defaultAccount,
    confidence: 0.45,
    reason: "category/account ambiguous",
    groupKey: `ambiguous_${pattern.slice(0, 40)}`,
    question: "What category and Snacky/Owner account should these similar transactions use?",
    usedSuggestion: true,
    holdForReview: true,
  };
}

export function classifyFinanceRows(rows: ParsedFinanceRow[], existingRows: ExistingFinanceRow[], context: FinanceClassificationContext = {}) {
  const existingSourceKeys = new Set(existingRows.filter((row) => row.source_sheet && row.source_row).map(sourceKey));
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
  const mirrorSets = buildMirrorSets(rows);

  return rows.map((row): ClassifiedFinanceRow => {
    const transactionDate = parseDate(row.record.date ?? "");
    const rawAmount = resolveAmount(row.record);
    const direction = resolveDirection(row.record, rawAmount);
    const rawAbsoluteAmount = rawAmount.value === null ? null : Math.abs(rawAmount.value);
    const originalDescription = row.record.transaction_description ?? "";
    const explicitCategory = resolveCategory(row.record);
    const currencyResult = recordCurrency(row.record);
    const inference = inferRow(row, {
      direction,
      currency: currencyResult.currency,
      currencyAmbiguous: currencyResult.ambiguous,
      rawCategoryValue: rawCategory(row.record),
      explicitCategory,
      machineLookup,
      mirrorSets,
      date: transactionDate,
      amount: rawAbsoluteAmount,
    });

    const reasons: string[] = [];
    if (!transactionDate) reasons.push("date missing or invalid");
    if (rawAmount.value === null) reasons.push("amount missing or invalid");
    if (!direction) reasons.push("direction unclear");
    if (!inference.category) reasons.push("category unclear");
    if (currencyResult.ambiguous) reasons.push("currency or exchange rate unclear");
    if (inference.holdForReview && inference.reason) reasons.push(inference.reason);
    if (inference.transactionEffect === "transfer" && (!inference.sourceAccountId || !inference.destinationAccountId)) reasons.push("transfer source or destination account unclear");
    if (inference.transactionEffect === "transfer" && inference.sourceAccountId && inference.destinationAccountId && accountCurrency(inference.sourceAccountId) !== accountCurrency(inference.destinationAccountId)) {
      reasons.push("cross-currency transfer needs explicit exchange rate");
    }

    const signedAmount = signedAmountFor(direction, rawAbsoluteAmount);
    const duplicateKey = businessKey({
      date: transactionDate,
      amount: rawAbsoluteAmount,
      description: dedupeDescription(row.record),
      currency: currencyResult.currency,
      accountId: inference.accountId,
      sourceAccountId: inference.sourceAccountId,
      destinationAccountId: inference.destinationAccountId,
      effect: inference.transactionEffect,
    });
    const currentSourceKey = sourceKey({ source_file: row.sourceFile, source_sheet: row.sourceSheet, source_row: row.sourceRow });
    const hasSourceDuplicate = existingSourceKeys.has(currentSourceKey);
    const hasBusinessDuplicate = duplicateKey ? existingBusinessKeys.has(duplicateKey) || seenBusinessKeys.has(duplicateKey) : false;

    let importStatus: ImportStatus;
    if (hasSourceDuplicate || hasBusinessDuplicate || inference.groupKey === "mirrored_internal_transfer") {
      importStatus = "ignored";
      if (hasSourceDuplicate) reasons.push("source row already imported");
      if (hasBusinessDuplicate) reasons.push("duplicate transaction date, amount, description, currency, and account");
      if (inference.groupKey === "mirrored_internal_transfer" && inference.reason) reasons.push(inference.reason);
    } else if (reasons.length) {
      importStatus = "needs_review";
    } else if (inference.usedSuggestion && inference.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      importStatus = "auto_classified";
    } else {
      importStatus = "imported";
    }

    if (duplicateKey && importStatus !== "ignored") seenBusinessKeys.add(duplicateKey);

    const shouldInsert = ["imported", "auto_classified", "confirmed"].includes(importStatus) && Boolean(transactionDate && direction && rawAbsoluteAmount !== null && inference.category);
    const reviewReason = reasons.join("; ") || inference.reason || null;

    return {
      ...row,
      importStatus,
      shouldInsert,
      reasons,
      transactionDate,
      amount: rawAbsoluteAmount,
      signedAmount,
      direction,
      category: explicitCategory,
      categoryForTransaction: inference.category,
      originalDescription,
      duplicateKey,
      currency: currencyResult.currency,
      accountId: inference.accountId,
      transactionEffect: inference.transactionEffect,
      sourceAccountId: inference.sourceAccountId,
      destinationAccountId: inference.destinationAccountId,
      reviewReason,
      reviewGroupKey: importStatus === "needs_review" ? inference.groupKey ?? "needs_review" : inference.groupKey,
      suggestedCategory: inference.category,
      suggestedAccount: inference.accountId,
      suggestedCurrency: currencyResult.currency,
      suggestedMachine: inference.machineName,
      suggestedMachineId: inference.machineId,
      suggestedSourceAccount: inference.sourceAccountId,
      suggestedDestinationAccount: inference.destinationAccountId,
      confidenceScore: inference.confidence,
      clarificationQuestion: importStatus === "needs_review" ? inference.question ?? "What should Snacky OS do with these transactions?" : inference.question,
      resolvedLocationName: inference.resolvedLocationName,
    };
  });
}

export function canInsertClassifiedRow(row: ClassifiedFinanceRow) {
  return row.shouldInsert && row.importStatus !== "ignored" && row.importStatus !== "needs_review";
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
    accountId: row.suggestedAccount ?? row.accountId,
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
    transaction_type: row.record.transaction_type?.trim() || null,
    location: row.resolvedLocationName ?? row.record.location?.trim() ?? null,
    description: row.originalDescription || row.resolvedLocationName || null,
    original_description: row.originalDescription || null,
    amount: row.amount,
    signed_amount: row.transactionEffect === "transfer" ? -Math.abs(row.amount) : row.signedAmount,
    currency: row.currency,
    account_id: row.transactionEffect === "transfer" ? row.sourceAccountId : row.accountId,
    transaction_effect: row.transactionEffect,
    source_account_id: row.sourceAccountId,
    destination_account_id: row.destinationAccountId,
    bucket: row.record.auto_bucket?.trim() || null,
    bucket_override: row.record.bucket_override?.trim() || null,
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
      original_transaction: row.record.transaction || null,
      original_money_flow: row.record.money_flow || null,
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
    raw_date: row.record.date ?? null,
    amount: row.amount,
    signed_amount: row.signedAmount,
    raw_amount: row.record.signed_amount || row.record.transaction || null,
    direction: row.direction,
    raw_direction: row.record.money_flow ?? null,
    currency: row.currency,
    account_id: row.accountId,
    transaction_effect: row.transactionEffect,
    source_account_id: row.sourceAccountId,
    destination_account_id: row.destinationAccountId,
    category: row.categoryForTransaction,
    raw_category: row.record.final_bucket || row.record.bucket_override || row.record.auto_bucket || row.record.transaction_type || null,
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
    raw_record: row.record,
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
      const question = first.clarificationQuestion ?? "What should Snacky OS do with this group?";
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
        question,
        reason,
        canConfirm: groupRows.every((row) => row.transactionDate && row.direction && row.amount !== null && row.suggestedCategory && row.suggestedAccount),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function groupTitle(key: string, count: number) {
  if (key === "unknown_currency") return `${count} transactions have unknown currency or exchange treatment`;
  if (key === "cash_transfer") return `${count} cash movements need source/destination account`;
  if (key === "balance_adjustment") return `${count} balance adjustment rows need account confirmation`;
  if (key.startsWith("ambiguous_")) return `${count} similar transactions need category confirmation`;
  if (key === "category_unclear") return `${count} transactions need category confirmation`;
  return `${count} transactions need clarification`;
}

export function buildFinanceClarificationPrompts(groups: FinanceReviewGroup[]) {
  return groups.slice(0, 10).map((group) => {
    if (group.suggestedSourceAccount && group.suggestedDestinationAccount) {
      return `I found ${group.count} transactions that look like transfers from ${group.suggestedSourceAccount} to ${group.suggestedDestinationAccount}. ${group.question}`;
    }
    if (group.suggestedMachine) {
      return `I found machine name ${group.suggestedMachine}. ${group.question}`;
    }
    if (group.suggestedCategory && group.suggestedAccount) {
      return `I found ${group.count} transactions that look like ${group.suggestedCategory}. Should I classify them to ${group.suggestedAccount}?`;
    }
    return group.question;
  });
}
