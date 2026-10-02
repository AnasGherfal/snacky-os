import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SOURCE_FILE = "docs/current-data/financial_transactions.csv";
const SOURCE_SHEET = "financial_transactions.csv";
const BATCH_SIZE = 200;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadEnvFile(filename) {
  try {
    const text = await readFile(path.join(process.cwd(), filename), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = parseEnvValue(trimmed.slice(separatorIndex + 1));
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
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
  return rows.slice(1).map((values, index) => ({
    sourceFile: SOURCE_FILE,
    sourceSheet: SOURCE_SHEET,
    sourceRow: index + 2,
    record: Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] ?? ""])),
  }));
}

async function readSourceRows() {
  const sourcePath = path.join(process.cwd(), SOURCE_FILE);
  return parseCsv(await readFile(sourcePath, "utf8"));
}

function parseDate(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : raw;
}

function parseAmountValue(value) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveAmount(record) {
  const signedAmount = parseAmountValue(record.signed_amount);
  if (signedAmount !== null) return { value: signedAmount, source: "signed_amount" };
  const transactionAmount = parseAmountValue(record.transaction);
  if (transactionAmount !== null) return { value: transactionAmount, source: "transaction" };
  return { value: null, source: null };
}

function resolveDirectionFromFlow(value) {
  const direction = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["money in", "in", "income", "revenue", "cash in"].includes(direction)) return "money_in";
  if (["money out", "out", "expense", "expenses", "cash out"].includes(direction)) return "money_out";
  return null;
}

function resolveDirection(record, amount) {
  const fromFlow = resolveDirectionFromFlow(record.money_flow);
  if (fromFlow) return { direction: fromFlow, inferred: false };
  if (amount.source === "signed_amount" && amount.value !== null && amount.value > 0) return { direction: "money_in", inferred: true };
  if (amount.source === "signed_amount" && amount.value !== null && amount.value < 0) return { direction: "money_out", inferred: true };
  return { direction: null, inferred: false };
}

function clearCategory(value) {
  const category = String(value ?? "").trim();
  if (!category || category.toUpperCase() === "TO_CONFIRM" || category.toLowerCase() === "review") return null;
  return category;
}

function rawCategory(record) {
  return (
    String(record.final_bucket ?? "").trim()
    || String(record.bucket_override ?? "").trim()
    || String(record.auto_bucket ?? "").trim()
    || String(record.transaction_type ?? "").trim()
    || null
  );
}

function resolveCategory(record) {
  return clearCategory(record.final_bucket) ?? clearCategory(record.bucket_override) ?? clearCategory(record.auto_bucket) ?? clearCategory(record.transaction_type);
}

function normalizeDescription(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function money(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

function businessKey(date, signedAmount, description) {
  if (!date || signedAmount === null || !Number.isFinite(signedAmount)) return null;
  return `${date}|${money(signedAmount).toFixed(2)}|${normalizeDescription(description)}`;
}

function sourceKey(row) {
  const sourceFile = row.source_file && row.source_file !== row.source_sheet ? row.source_file : SOURCE_FILE;
  return `${sourceFile}|${row.source_sheet ?? ""}|${Number(row.source_row ?? 0)}`;
}

function classifyRows(rows, existingRows) {
  const existingSourceKeys = new Set(existingRows.filter((row) => row.source_sheet && row.source_row).map(sourceKey));
  const existingBySource = new Map(existingRows.filter((row) => row.source_sheet && row.source_row).map((row) => [sourceKey(row), row.id]));
  const existingBusinessKeys = new Set(
    existingRows
      .map((row) => businessKey(String(row.transaction_date ?? ""), Number(row.signed_amount ?? NaN), row.original_description ?? row.description ?? ""))
      .filter(Boolean),
  );
  const seenBusinessKeys = new Set();

  return rows.map((row) => {
    const transactionDate = parseDate(row.record.date);
    const amount = resolveAmount(row.record);
    const directionResult = resolveDirection(row.record, amount);
    const direction = directionResult.direction;
    const category = resolveCategory(row.record);
    const originalDescription = row.record.transaction_description ?? "";
    const reasons = [];

    if (!transactionDate) reasons.push("date missing or invalid");
    if (amount.value === null) reasons.push("amount missing or invalid");
    if (!direction) reasons.push("direction unclear");
    if (!category) reasons.push("category unclear");
    if (directionResult.inferred) reasons.push("direction inferred from signed amount");

    const signedAmount = amount.value === null || !direction ? null : money(direction === "money_out" ? -Math.abs(amount.value) : Math.abs(amount.value));
    const absoluteAmount = signedAmount === null ? null : Math.abs(signedAmount);
    const duplicateKey = businessKey(transactionDate, signedAmount, originalDescription);
    const currentSourceKey = sourceKey({ source_file: row.sourceFile, source_sheet: row.sourceSheet, source_row: row.sourceRow });
    const hasSourceDuplicate = existingSourceKeys.has(currentSourceKey);
    const hasBusinessDuplicate = duplicateKey ? existingBusinessKeys.has(duplicateKey) || seenBusinessKeys.has(duplicateKey) : false;

    let importStatus = reasons.length ? "needs_review" : "imported";
    let shouldInsert = Boolean(transactionDate && direction && signedAmount !== null && absoluteAmount !== null);

    if (hasSourceDuplicate) {
      importStatus = "skipped";
      shouldInsert = false;
      reasons.push("source row already imported");
    } else if (hasBusinessDuplicate) {
      importStatus = "needs_review";
      shouldInsert = false;
      reasons.push("possible duplicate");
    }

    if (duplicateKey) seenBusinessKeys.add(duplicateKey);

    return {
      ...row,
      transactionDate,
      amount: absoluteAmount,
      signedAmount,
      direction,
      category,
      categoryForTransaction: category ?? rawCategory(row.record) ?? "Review",
      originalDescription,
      duplicateKey,
      importStatus,
      reasons,
      shouldInsert,
      existingTransactionId: existingBySource.get(currentSourceKey) ?? null,
    };
  });
}

function transactionPayload(row) {
  const needsManualReview = row.importStatus === "needs_review";
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
    final_bucket: row.categoryForTransaction,
    review_status: needsManualReview ? "needs_review" : "confirmed",
    needs_review: needsManualReview,
    transaction_status: "active",
    import_status: needsManualReview ? "needs_review" : "imported",
    source_file: row.sourceFile,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    metadata: {
      imported_by_script: "scripts/import-financial-transactions.mjs",
      original_transaction: row.record.transaction || null,
      original_money_flow: row.record.money_flow || null,
      original_row: row.record,
      duplicate_key: row.duplicateKey,
      review_reasons: row.reasons,
    },
  };
}

function stagePayload(row, transactionId) {
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
    raw_category: rawCategory(row.record),
    original_description: row.originalDescription || null,
    review_reason: row.reasons.join("; ") || null,
    financial_transaction_id: transactionId ?? null,
    raw_record: row.record,
    updated_at: new Date().toISOString(),
  };
}

function chunks(rows) {
  const chunked = [];
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    chunked.push(rows.slice(index, index + BATCH_SIZE));
  }
  return chunked;
}

async function insertTransactions(supabase, rows) {
  const insertedRows = [];
  for (const chunk of chunks(rows)) {
    const { data, error } = await supabase
      .from("financial_transactions")
      .insert(chunk.map(transactionPayload))
      .select("id, source_file, source_sheet, source_row, import_status, needs_review");
    if (error) throw error;
    insertedRows.push(...(data ?? []));
  }
  return insertedRows;
}

async function upsertStageRows(supabase, rows) {
  for (const chunk of chunks(rows)) {
    const { error } = await supabase.from("finance_import_rows").upsert(chunk, { onConflict: "source_file,source_sheet,source_row" });
    if (error) throw error;
  }
}

async function writeActivityLog(supabase, summary) {
  const { error } = await supabase.from("system_activity_logs").insert({
    action: "create",
    entity_type: "finance_import",
    entity_label: "Historical finance import",
    after_data: summary,
    metadata: {
      source_file: SOURCE_FILE,
      source_sheet: SOURCE_SHEET,
      imported_by_script: "scripts/import-financial-transactions.mjs",
    },
    summary: `Imported ${summary.inserted_transactions} historical finance transactions from current data.`,
  });
  if (error) console.warn(`Activity log failed: ${error.message}`);
}

async function main() {
  await loadEnvFile(".env.local");
  await loadEnvFile(".env");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local before importing finance history.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rows = await readSourceRows();
  const { data: existingRows, error: existingError } = await supabase
    .from("financial_transactions")
    .select("id, source_file, source_sheet, source_row, transaction_date, signed_amount, description, original_description")
    .limit(50000);
  if (existingError) throw existingError;

  const classifiedRows = classifyRows(rows, existingRows ?? []);
  const transactionRows = classifiedRows.filter((row) => row.shouldInsert);
  const confirmedRows = transactionRows.filter((row) => row.importStatus === "imported");
  const reviewTransactionRows = transactionRows.filter((row) => row.importStatus === "needs_review");
  const stagedOnlyRows = classifiedRows.filter((row) => !row.shouldInsert && row.importStatus === "needs_review");
  const skippedRows = classifiedRows.filter((row) => row.importStatus === "skipped");

  let insertedRows = [];
  if (!dryRun && transactionRows.length) {
    insertedRows = await insertTransactions(supabase, transactionRows);
  }

  const transactionBySource = new Map();
  for (const row of classifiedRows) {
    if (row.existingTransactionId) transactionBySource.set(`${row.sourceFile}|${row.sourceSheet}|${row.sourceRow}`, row.existingTransactionId);
  }
  for (const row of insertedRows) {
    transactionBySource.set(`${row.source_file}|${row.source_sheet}|${row.source_row}`, row.id);
  }

  const stageRows = classifiedRows.map((row) => stagePayload(row, transactionBySource.get(`${row.sourceFile}|${row.sourceSheet}|${row.sourceRow}`)));
  if (!dryRun && stageRows.length) {
    await upsertStageRows(supabase, stageRows);
  }

  const summary = {
    source_rows: rows.length,
    insertable_transactions: transactionRows.length,
    inserted_transactions: dryRun ? 0 : insertedRows.length,
    confirmed_transactions: confirmedRows.length,
    needs_review_transactions: reviewTransactionRows.length,
    staged_rows: dryRun ? 0 : stageRows.length,
    staged_only_needs_review_rows: stagedOnlyRows.length,
    skipped_existing_rows: skippedRows.length,
    dry_run: dryRun,
  };

  if (!dryRun) await writeActivityLog(supabase, summary);

  console.table(summary);
  if (stagedOnlyRows.length) {
    console.log("Rows staged only:");
    console.table(stagedOnlyRows.map((row) => ({
      source_row: row.sourceRow,
      date: row.record.date,
      signed_amount: row.record.signed_amount,
      money_flow: row.record.money_flow,
      reason: row.reasons.join("; "),
    })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
