import fs from "node:fs/promises";
import path from "node:path";

export const FINANCE_SOURCE_FILE = "docs/current-data/financial_transactions.csv";
export const FINANCE_SOURCE_SHEET = "financial_transactions.csv";

export type ImportStatus = "imported" | "needs_review" | "skipped";

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
  signed_amount?: number | string | null;
  description?: string | null;
  original_description?: string | null;
};

export type ClassifiedFinanceRow = ParsedFinanceRow & {
  importStatus: ImportStatus;
  reasons: string[];
  transactionDate: string | null;
  amount: number | null;
  signedAmount: number | null;
  direction: "money_in" | "money_out" | null;
  category: string | null;
  originalDescription: string;
  duplicateKey: string | null;
};

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

  const headers = rows[0].map((header) => header.trim());
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
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveAmount(record: Record<string, string>) {
  return parseAmount(record.signed_amount) ?? parseAmount(record.transaction);
}

function resolveDirection(value: string) {
  const direction = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (["money in", "in", "income", "revenue", "cash in"].includes(direction)) return "money_in";
  if (["money out", "out", "expense", "expenses", "cash out"].includes(direction)) return "money_out";
  return null;
}

function clearCategory(value: string | undefined) {
  const category = String(value ?? "").trim();
  if (!category || category.toUpperCase() === "TO_CONFIRM" || category.toLowerCase() === "review") return null;
  return category;
}

function resolveCategory(record: Record<string, string>) {
  return clearCategory(record.final_bucket) ?? clearCategory(record.bucket_override) ?? clearCategory(record.auto_bucket) ?? clearCategory(record.transaction_type);
}

function normalizeDescription(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function businessKey(date: string | null, signedAmount: number | null, description: string) {
  if (!date || signedAmount === null) return null;
  return `${date}|${signedAmount.toFixed(2)}|${normalizeDescription(description)}`;
}

function sourceKey(row: { source_file?: string | null; source_sheet?: string | null; source_row?: number | null }) {
  const sourceFile = row.source_file && row.source_file !== row.source_sheet ? row.source_file : FINANCE_SOURCE_FILE;
  return `${sourceFile}|${row.source_sheet ?? ""}|${Number(row.source_row ?? 0)}`;
}

export function classifyFinanceRows(rows: ParsedFinanceRow[], existingRows: ExistingFinanceRow[]) {
  const existingSourceKeys = new Set(existingRows.filter((row) => row.source_sheet && row.source_row).map(sourceKey));
  const existingBusinessKeys = new Set(
    existingRows
      .map((row) => businessKey(String(row.transaction_date ?? ""), Number(row.signed_amount ?? NaN), String(row.original_description ?? row.description ?? "")))
      .filter((key): key is string => Boolean(key)),
  );
  const seenBusinessKeys = new Set<string>();

  return rows.map((row): ClassifiedFinanceRow => {
    const transactionDate = parseDate(row.record.date ?? "");
    const rawAmount = resolveAmount(row.record);
    const direction = resolveDirection(row.record.money_flow ?? "");
    const category = resolveCategory(row.record);
    const originalDescription = row.record.transaction_description ?? "";
    const reasons: string[] = [];

    if (!transactionDate) reasons.push("date missing or invalid");
    if (rawAmount === null) reasons.push("amount missing or invalid");
    if (!direction) reasons.push("direction unclear");
    if (!category) reasons.push("category unclear");

    const signedAmount = rawAmount === null || !direction ? null : direction === "money_out" ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    const duplicateKey = businessKey(transactionDate, signedAmount, originalDescription);
    const hasSourceDuplicate = existingSourceKeys.has(sourceKey({ source_file: row.sourceFile, source_sheet: row.sourceSheet, source_row: row.sourceRow }));
    const hasBusinessDuplicate = duplicateKey ? existingBusinessKeys.has(duplicateKey) || seenBusinessKeys.has(duplicateKey) : false;

    let importStatus: ImportStatus = "imported";
    if (hasSourceDuplicate) {
      importStatus = "skipped";
      reasons.push("source row already imported");
    } else if (hasBusinessDuplicate) {
      importStatus = "needs_review";
      reasons.push("possible duplicate");
    } else if (reasons.length) {
      importStatus = "needs_review";
    }

    if (duplicateKey) seenBusinessKeys.add(duplicateKey);

    return {
      ...row,
      importStatus,
      reasons,
      transactionDate,
      amount: signedAmount === null ? null : Math.abs(signedAmount),
      signedAmount,
      direction,
      category,
      originalDescription,
      duplicateKey,
    };
  });
}

export function buildFinanceTransaction(row: ClassifiedFinanceRow, createdBy?: string | null) {
  if (row.importStatus !== "imported" || !row.transactionDate || !row.direction || row.amount === null || row.signedAmount === null || !row.category) {
    return null;
  }

  return {
    transaction_date: row.transactionDate,
    direction: row.direction,
    transaction_kind: "spreadsheet_import",
    transaction_type: row.record.transaction_type?.trim() || null,
    location: row.record.location?.trim() || null,
    description: row.originalDescription || null,
    original_description: row.originalDescription || null,
    amount: row.amount,
    signed_amount: row.signedAmount,
    bucket: row.record.auto_bucket?.trim() || null,
    bucket_override: row.record.bucket_override?.trim() || null,
    final_bucket: row.category,
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    import_status: "imported",
    source_file: row.sourceFile,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    created_by: createdBy ?? null,
    metadata: {
      original_transaction: row.record.transaction || null,
      original_money_flow: row.record.money_flow || null,
      original_row: row.record,
      duplicate_key: row.duplicateKey,
    },
  };
}

export function buildFinanceImportStageRow(row: ClassifiedFinanceRow, transactionId?: string | null) {
  return {
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
    category: row.category,
    raw_category: row.record.final_bucket || row.record.bucket_override || row.record.auto_bucket || row.record.transaction_type || null,
    original_description: row.originalDescription || null,
    review_reason: row.reasons.join("; ") || null,
    financial_transaction_id: transactionId ?? null,
    raw_record: row.record,
    updated_at: new Date().toISOString(),
  };
}
