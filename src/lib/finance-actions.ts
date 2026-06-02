"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canEditFinancialTransactions, canViewFinancials } from "@/lib/authz";
import { resolveCashCollectionTransactionDateTime } from "@/lib/cash-finance";
import { accountCurrency, financeAccountId, type FinanceAccountId, type FinanceTransactionEffect } from "@/lib/finance-balance";
import { categoryTypeForDirection, type FinanceCategoryType } from "@/lib/finance-categories";
import {
  buildFinanceClarificationPrompts,
  buildFinanceImportStageRow,
  buildFinanceReviewGroups,
  buildFinanceTransaction,
  classifyFinanceRows,
  FINANCE_SOURCE_FILE,
  FINANCE_SOURCE_SHEET,
  forceConfirmClassifiedRow,
  importModeForDate,
  parseFinanceCsvText,
  readFinanceImportRows,
  type ParsedFinanceRow,
} from "@/lib/finance-import";
import { resolvePurchaseFinanceTransactionDate } from "@/lib/purchase-finance-date";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function requireFinance(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }
}

function requireFinanceEdit(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  if (!profile || !canEditFinancialTransactions({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }
}

function toOptionalAmount(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function cleanCurrency(value: FormDataEntryValue | null) {
  const currency = String(value ?? "LYD").trim().toUpperCase();
  return currency === "USD" ? "USD" : "LYD";
}

function cleanFinanceEffect(value: FormDataEntryValue | null, direction?: string | null): FinanceTransactionEffect {
  const effect = String(value ?? "").trim();
  if (effect === "income" || effect === "expense" || effect === "transfer" || effect === "opening_balance") return effect;
  if (direction === "transfer") return "transfer";
  return direction === "money_in" ? "income" : "expense";
}

function cleanFinanceAccount(value: FormDataEntryValue | null, currency: string): FinanceAccountId {
  return financeAccountId(String(value ?? ""), currency);
}

function optionalUuid(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function optionalText(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function parseTransactionAmount(value: FormDataEntryValue | null, fallback: unknown = 0) {
  const raw = String(value ?? fallback ?? "").replace(/,/g, "").trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.abs(parsed) : NaN;
}

function transactionDateTimeFromDate(transactionDate: string) {
  return `${transactionDate}T12:00:00.000Z`;
}

function validDirection(value: FormDataEntryValue | null, fallback?: string | null) {
  const direction = String(value || fallback || "").trim();
  if (direction === "money_in" || direction === "money_out" || direction === "transfer") return direction;
  if (fallback === "transfer") return "transfer";
  return "";
}

function resolveManualLedgerFields(formData: FormData, fallback?: any) {
  const direction = validDirection(formData.get("direction"), fallback?.transaction_effect === "transfer" ? "transfer" : fallback?.direction);
  const requestedCurrency = cleanCurrency(formData.get("currency") ?? fallback?.currency ?? "LYD");
  const transactionEffect = cleanFinanceEffect(formData.get("transaction_effect"), direction || fallback?.direction);
  const accountId = cleanFinanceAccount(formData.get("account_id") ?? fallback?.account_id, requestedCurrency);
  const sourceAccountId = cleanFinanceAccount(formData.get("source_account_id") ?? fallback?.source_account_id ?? accountId, requestedCurrency);
  const destinationAccountId = cleanFinanceAccount(formData.get("destination_account_id") ?? fallback?.destination_account_id ?? accountId, requestedCurrency);
  const currency = transactionEffect === "transfer" ? accountCurrency(sourceAccountId) : accountCurrency(accountId);

  return {
    flowDirection: direction,
    direction: transactionEffect === "transfer" ? "money_out" : direction,
    currency,
    transactionEffect,
    accountId: transactionEffect === "transfer" ? sourceAccountId : accountId,
    sourceAccountId: transactionEffect === "transfer" ? sourceAccountId : null,
    destinationAccountId: transactionEffect === "transfer" ? destinationAccountId : null,
  };
}

function validateManualLedgerFields(fields: ReturnType<typeof resolveManualLedgerFields>, category?: string | null) {
  if (!fields.direction) return "Direction is required.";
  const normalizedCategory = String(category ?? "").trim().toLowerCase();
  if (fields.transactionEffect !== "transfer" && (normalizedCategory === "owner funding" || normalizedCategory === "owner withdrawal")) {
    return `${category} must be saved as a Transfer so it affects balances without counting as profit.`;
  }
  if (fields.transactionEffect === "transfer") {
    if (!fields.sourceAccountId || !fields.destinationAccountId) return "Transfer source and destination accounts are required.";
    if (fields.sourceAccountId === fields.destinationAccountId) return "Transfer source and destination must be different.";
    if (accountCurrency(fields.sourceAccountId) !== accountCurrency(fields.destinationAccountId)) return "Cross-currency transfers need a separate exchange workflow with an explicit rate.";
  }
  return null;
}

async function resolveFinanceCategory(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  formData: FormData,
  direction: string,
  fallback?: string | null,
) {
  const selected = optionalText(formData.get("category"));
  const requestedName = selected === "__new__" ? optionalText(formData.get("new_category_name")) : selected ?? fallback;
  const name = requestedName?.trim();
  if (!name) return { id: null as string | null, name: null as string | null };

  const type = categoryTypeForDirection(direction) as FinanceCategoryType;
  const { data: existing, error: existingError } = await supabase.from("finance_categories").select("id, name, type").eq("name", name).maybeSingle();
  if (!existingError && existing?.id) return { id: existing.id as string, name: existing.name as string };

  const { data: created, error: createError } = await supabase
    .from("finance_categories")
    .insert({ name, type, is_active: true })
    .select("id, name")
    .single();
  if (!createError && created?.id) return { id: created.id as string, name: created.name as string };

  if (createError?.code === "23505") {
    const { data } = await supabase.from("finance_categories").select("id, name").eq("name", name).maybeSingle();
    return { id: data?.id ?? null, name: data?.name ?? name };
  }

  console.error("[finance] Failed to resolve finance category", { name, createError, existingError });
  return { id: null, name };
}

function counterpartyFields(formData: FormData, fields: ReturnType<typeof resolveManualLedgerFields>) {
  const payer = optionalText(formData.get("payer_text"));
  const payee = optionalText(formData.get("payee_text"));
  const counterparty = optionalText(formData.get("counterparty_text"));
  if (fields.transactionEffect === "transfer") {
    return { payerText: null, payeeText: null, counterpartyText: counterparty };
  }
  if (fields.direction === "money_in") {
    return { payerText: payer ?? counterparty, payeeText: null, counterpartyText: payer ?? counterparty };
  }
  return { payerText: null, payeeText: payee ?? counterparty, counterpartyText: payee ?? counterparty };
}

async function loadFinanceClassificationContext(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const [{ data: machines }, aliasResult] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, vms_machine_id").limit(1000),
    supabase.from("machine_aliases").select("alias_name, machine:machines(id, name, machine_code, vms_machine_id)").limit(1000),
  ]);
  const aliases = aliasResult.error
    ? []
    : (aliasResult.data ?? []).map((row: any) => ({
        alias_name: row.alias_name,
        id: row.machine?.id,
        name: row.machine?.name,
        machine_code: row.machine?.machine_code,
        vms_machine_id: row.machine?.vms_machine_id,
      }));
  return { machines: (machines ?? []) as any[], aliases };
}

async function createFinanceImportBatch(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  profile: Awaited<ReturnType<typeof getCurrentProfile>>,
  mode: string,
  rowCount: number,
  sourceFile = FINANCE_SOURCE_FILE,
  sourceSheet = FINANCE_SOURCE_SHEET,
) {
  const { data, error } = await supabase
    .from("finance_import_batches")
    .insert({
      source_file: sourceFile,
      source_sheet: sourceSheet,
      imported_by: profile?.team_member_id ?? null,
      mode,
      row_count: rowCount,
      status: "processing",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

function financeSourceKey(row: { source_file?: string | null; source_sheet?: string | null; source_row?: number | null }) {
  return `${row.source_file ?? ""}|${row.source_sheet ?? ""}|${Number(row.source_row ?? 0)}`;
}

function parsedFinanceSourceKey(row: ParsedFinanceRow) {
  return `${row.sourceFile}|${row.sourceSheet}|${row.sourceRow}`;
}

async function runFinanceImportRows(rows: ParsedFinanceRow[], mode: "import" | "apply_high_confidence" | "confirm_group", groupKey?: string) {
  const profile = await getCurrentProfile();
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/import?error=Supabase%20is%20not%20configured.");
  if (!rows.length) redirect("/finance/import?error=No%20transaction%20rows%20were%20found%20in%20the%20CSV.");

  const sourceFile = rows[0]?.sourceFile ?? FINANCE_SOURCE_FILE;
  const sourceSheet = rows[0]?.sourceSheet ?? FINANCE_SOURCE_SHEET;
  let batchId: string | null = null;
  try {
    batchId = await createFinanceImportBatch(supabase, profile, mode, rows.length, sourceFile, sourceSheet);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create finance import batch.";
    redirect(`/finance/import?error=${encodeURIComponent(message)}`);
  }

  const [{ data: existingRows, error: existingError }, context] = await Promise.all([
    supabase
    .from("financial_transactions")
      .select("id, source_file, source_sheet, source_row, transaction_date, amount, signed_amount, currency, account_id, source_account_id, destination_account_id, transaction_effect, description, original_description, final_bucket")
      .limit(50000),
    loadFinanceClassificationContext(supabase),
  ]);
  if (existingError) redirect(`/finance/import?error=${encodeURIComponent(existingError.message)}`);

  const classifiedRows = classifyFinanceRows(rows, (existingRows ?? []) as any[], context);
  const existingTransactionBySource = new Map(
    ((existingRows ?? []) as any[])
      .filter((row) => row.source_file && row.source_sheet && row.source_row)
      .map((row) => [financeSourceKey(row), row.id as string]),
  );
  const rowsForImport = groupKey
    ? classifiedRows.filter((row) => row.reviewGroupKey === groupKey && row.importStatus === "needs_review").map(forceConfirmClassifiedRow)
    : classifiedRows;
  const transactionRows = rowsForImport.flatMap((row) => {
    const transaction = buildFinanceTransaction(row, profile?.team_member_id, batchId);
    return transaction ? [transaction] : [];
  });
  const importedRows = rowsForImport.filter((row) => row.importStatus === "imported").length;
  const autoClassifiedRows = rowsForImport.filter((row) => row.importStatus === "auto_classified").length;
  const confirmedRows = rowsForImport.filter((row) => row.importStatus === "confirmed").length;
  const reviewRows = classifiedRows.filter((row) => row.importStatus === "needs_review").length;
  const ignoredRows = classifiedRows.filter((row) => row.importStatus === "ignored" || row.importStatus === "skipped").length;
  let insertedTransactions: any[] = [];

  if (transactionRows.length) {
    const { data: inserted, error } = await supabase
      .from("financial_transactions")
      .insert(transactionRows)
      .select("id, source_file, source_sheet, source_row");
    if (error) {
      console.error("[finance:import] Failed to import financial transactions", error);
      redirect(`/finance/import?error=${encodeURIComponent(error.message)}`);
    }
    insertedTransactions = inserted ?? [];
  }

  const insertedBySource = new Map(
    insertedTransactions.map((row) => [`${row.source_file}|${row.source_sheet}|${row.source_row}`, row.id]),
  );
  const stageSource = groupKey ? classifiedRows.map((row) => rowsForImport.find((confirmed) => confirmed.sourceRow === row.sourceRow) ?? row) : classifiedRows;
  const stageRows = stageSource.map((row) => {
    const key = parsedFinanceSourceKey(row);
    return buildFinanceImportStageRow(row, insertedBySource.get(key) ?? existingTransactionBySource.get(key), batchId);
  });
  if (stageRows.length) {
    const { error } = await supabase.from("finance_import_rows").upsert(stageRows, { onConflict: "source_file,source_sheet,source_row" });
    if (error) {
      console.error("[finance:import] Failed to stage import rows", error);
      redirect(`/finance/import?error=${encodeURIComponent(error.message)}`);
    }
  }

  const reviewGroups = buildFinanceReviewGroups(classifiedRows);
  await supabase
    .from("finance_import_batches")
    .update({
      status: "completed",
      imported_count: importedRows,
      auto_classified_count: autoClassifiedRows,
      confirmed_count: confirmedRows,
      needs_review_count: reviewRows,
      ignored_count: ignoredRows,
      review_group_count: reviewGroups.length,
      clarification_prompts: buildFinanceClarificationPrompts(reviewGroups),
      completed_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  await logActivity({
    profile,
    action: "create",
    entityType: "finance_import",
    entityLabel: "Finance import",
    afterData: {
      source_file: FINANCE_SOURCE_FILE,
      source_sheet: FINANCE_SOURCE_SHEET,
      actual_source_file: sourceFile,
      actual_source_sheet: sourceSheet,
      total_rows: rows.length,
      imported_rows: importedRows,
      auto_classified_rows: autoClassifiedRows,
      confirmed_rows: confirmedRows,
      needs_review_rows: reviewRows,
      ignored_rows: ignoredRows,
      import_batch_id: batchId,
    },
    summary: `Imported ${importedRows + autoClassifiedRows + confirmedRows} finance rows, staged ${reviewRows} for review, ignored ${ignoredRows}`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/import");
  revalidatePath("/finance/import/review");
  revalidatePath("/finance/transactions");
  redirect(`/finance/import?total=${rows.length}&imported=${importedRows + autoClassifiedRows + confirmedRows}&autoClassified=${autoClassifiedRows}&needsReview=${reviewRows}&ignored=${ignoredRows}`);
}

async function runHistoricalFinanceImport(mode: "import" | "apply_high_confidence" | "confirm_group", groupKey?: string) {
  await runFinanceImportRows(await readFinanceImportRows(), mode, groupKey);
}

export async function importHistoricalFinanceTransactions() {
  await runHistoricalFinanceImport("import");
}

export async function importUploadedFinanceTransactions(formData: FormData) {
  const file = formData.get("file");
  if (file && typeof file === "object" && "text" in file && "name" in file) {
    const upload = file as File;
    if (upload.size > 0) {
      const parsed = parseFinanceCsvText(await upload.text(), { sourceFile: upload.name || "Snacky - Financial Spreadsheet - Transactions.csv" });
      await runFinanceImportRows(parsed.rows, "import");
    }
  }
  await runHistoricalFinanceImport("import");
}

export async function applyHighConfidenceFinanceSuggestions() {
  await runHistoricalFinanceImport("apply_high_confidence");
}

export async function confirmFinanceReviewGroup(formData: FormData) {
  const groupKey = String(formData.get("review_group_key") || "").trim();
  if (!groupKey) redirect("/finance/import?error=Review%20group%20is%20required.");
  await runHistoricalFinanceImport("confirm_group", groupKey);
}

function importRowRawText(row: any, normalizedKey: string, sourceHeader?: string) {
  const raw = row?.raw_record && typeof row.raw_record === "object" ? row.raw_record : {};
  return optionalText(raw[normalizedKey]) ?? optionalText(sourceHeader ? raw[sourceHeader] : null);
}

function normalizedFinanceName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function importRowReturnPath(row: any) {
  const suffix = row?.source_row ? `?row=${encodeURIComponent(String(row.source_row))}` : "";
  return `/finance/import/review${suffix}`;
}

export async function confirmFinanceImportRow(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinanceEdit(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/import/review?error=Supabase%20is%20not%20configured.");

  const rowId = String(formData.get("row_id") || formData.get("id") || "").trim();
  if (!rowId) redirect("/finance/import/review?error=Import%20row%20is%20required.");

  const { data: row, error: rowError } = await supabase.from("finance_import_rows").select("*").eq("id", rowId).maybeSingle();
  if (rowError) redirect(`/finance/import/review?error=${encodeURIComponent(rowError.message)}`);
  if (!row) redirect("/finance/import/review?error=Import%20row%20not%20found.");
  if (row.import_status === "ignored") redirect(`${importRowReturnPath(row)}&error=Ignored%20rows%20must%20be%20reclassified%20before%20confirming.`);

  const fallback = {
    transaction_effect: row.transaction_effect,
    direction: row.direction,
    currency: row.currency,
    account_id: row.account_id,
    source_account_id: row.source_account_id,
    destination_account_id: row.destination_account_id,
  };
  const amount = parseTransactionAmount(formData.get("amount"), row.amount);
  const transactionDate = String(formData.get("transaction_date") || row.transaction_date || row.raw_date || "").trim();
  const ledgerFields = resolveManualLedgerFields(formData, fallback);
  const fallbackCategory = optionalText(row.category) ?? optionalText(row.suggested_category);
  const categoryRecord = await resolveFinanceCategory(supabase, formData, ledgerFields.flowDirection, fallbackCategory);
  const category = categoryRecord.name;
  const ledgerError = validateManualLedgerFields(ledgerFields, category);
  const returnPath = importRowReturnPath(row);

  if (!transactionDate) redirect(`${returnPath}&error=Transaction%20date%20is%20required.`);
  if (ledgerError) redirect(`${returnPath}&error=${encodeURIComponent(ledgerError)}`);
  if (!Number.isFinite(amount) || amount < 0) redirect(`${returnPath}&error=Amount%20must%20be%20greater%20than%20or%20equal%20to%200.`);
  if (!category) redirect(`${returnPath}&error=Category%20is%20required.`);

  const counterparty = counterpartyFields(formData, ledgerFields);
  const location = optionalText(formData.get("location")) ?? optionalText(row.suggested_machine) ?? importRowRawText(row, "location", "Location");
  const description = optionalText(formData.get("description")) ?? optionalText(row.original_description) ?? importRowRawText(row, "transaction_description", "Transaction Description");
  const rawName = importRowRawText(row, "name", "Name");
  const payerText = counterparty.payerText ?? (ledgerFields.direction === "money_in" ? rawName : null);
  const payeeText = counterparty.payeeText ?? (ledgerFields.direction === "money_out" ? rawName : null);
  const counterpartyText = counterparty.counterpartyText ?? rawName ?? payeeText ?? payerText;
  const payload = {
    transaction_date: transactionDate,
    transaction_datetime: transactionDateTimeFromDate(transactionDate),
    direction: ledgerFields.direction,
    transaction_kind: "spreadsheet_import",
    transaction_type: category,
    location,
    description,
    original_description: description,
    notes: optionalText(formData.get("notes")) ?? description,
    amount,
    signed_amount: ledgerFields.direction === "money_out" ? -Math.abs(amount) : Math.abs(amount),
    currency: ledgerFields.currency,
    account_id: ledgerFields.accountId,
    transaction_effect: ledgerFields.transactionEffect,
    source_account_id: ledgerFields.sourceAccountId,
    destination_account_id: ledgerFields.destinationAccountId,
    finance_category_id: categoryRecord.id,
    payer_text: payerText,
    payee_text: payeeText,
    counterparty_text: counterpartyText,
    bucket: optionalText(row.raw_category),
    final_bucket: category,
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    import_status: "confirmed",
    import_batch_id: row.import_batch_id ?? null,
    source_file: row.source_file,
    source_sheet: row.source_sheet,
    source_row: row.source_row,
    review_reason: null,
    suggested_category: category,
    suggested_account: ledgerFields.accountId,
    suggested_machine: row.suggested_machine ?? null,
    confidence_score: 1,
    related_machine_id: row.suggested_machine_id ?? null,
    created_by: profile?.team_member_id ?? null,
    original_csv_row: row.raw_record ?? {},
    metadata: {
      source_format: row.raw_record?.__source_format ?? null,
      import_mode: importModeForDate(transactionDate),
      opening_balance_cutoff_date: row.raw_record?.opening_balance_cutoff_date ?? null,
      original_name: rawName,
      confirmed_from_import_row_id: row.id,
    },
  };

  let transactionId = row.financial_transaction_id as string | null;
  if (!transactionId) {
    const { data: existing } = await supabase
      .from("financial_transactions")
      .select("id")
      .eq("source_file", row.source_file)
      .eq("source_sheet", row.source_sheet)
      .eq("source_row", row.source_row)
      .maybeSingle();
    transactionId = existing?.id ?? null;
  }

  let savedTransaction: any;
  if (transactionId) {
    const { data, error } = await supabase.from("financial_transactions").update({ ...payload, updated_at: new Date().toISOString() }).eq("id", transactionId).select("*").single();
    if (error) redirect(`${returnPath}&error=${encodeURIComponent(error.message)}`);
    savedTransaction = data;
  } else {
    const { data, error } = await supabase.from("financial_transactions").insert(payload).select("*").single();
    if (error) redirect(`${returnPath}&error=${encodeURIComponent(error.message)}`);
    savedTransaction = data;
    transactionId = data.id;
  }

  const { error: stageError } = await supabase
    .from("finance_import_rows")
    .update({
      import_status: "confirmed",
      financial_transaction_id: transactionId,
      transaction_date: transactionDate,
      amount,
      signed_amount: ledgerFields.direction === "money_out" ? -Math.abs(amount) : Math.abs(amount),
      direction: ledgerFields.direction,
      currency: ledgerFields.currency,
      account_id: ledgerFields.accountId,
      transaction_effect: ledgerFields.transactionEffect,
      source_account_id: ledgerFields.sourceAccountId,
      destination_account_id: ledgerFields.destinationAccountId,
      category,
      original_description: description,
      review_reason: null,
      review_group_key: null,
      suggested_category: category,
      suggested_account: ledgerFields.accountId,
      suggested_currency: ledgerFields.currency,
      suggested_source_account: ledgerFields.sourceAccountId,
      suggested_destination_account: ledgerFields.destinationAccountId,
      confidence_score: 1,
      clarification_question: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (stageError) redirect(`${returnPath}&error=${encodeURIComponent(stageError.message)}`);

  await logActivity({
    profile,
    action: "update",
    entityType: "finance_import_row",
    entityId: row.id,
    entityLabel: `Finance import row ${row.source_row}`,
    beforeData: row,
    afterData: savedTransaction,
    summary: `Confirmed finance import row ${row.source_row}`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/import");
  revalidatePath("/finance/import/review");
  revalidatePath("/finance/transactions");
  redirect(`/finance/import/review?confirmed=${encodeURIComponent(String(row.source_row))}`);
}

export async function ignoreFinanceImportRow(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinanceEdit(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/import/review?error=Supabase%20is%20not%20configured.");

  const rowId = String(formData.get("row_id") || formData.get("id") || "").trim();
  if (!rowId) redirect("/finance/import/review?error=Import%20row%20is%20required.");

  const { data: row, error: rowError } = await supabase.from("finance_import_rows").select("*").eq("id", rowId).maybeSingle();
  if (rowError) redirect(`/finance/import/review?error=${encodeURIComponent(rowError.message)}`);
  if (!row) redirect("/finance/import/review?error=Import%20row%20not%20found.");

  const reason = optionalText(formData.get("ignore_reason")) ?? "Manually ignored during row-by-row finance import review.";
  if (row.financial_transaction_id) {
    const { error: transactionError } = await supabase
      .from("financial_transactions")
      .update({
        import_status: "ignored",
        needs_review: true,
        review_status: "needs_review",
        review_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.financial_transaction_id);
    if (transactionError) redirect(`/finance/import/review?error=${encodeURIComponent(transactionError.message)}`);
  }
  const { data: after, error } = await supabase
    .from("finance_import_rows")
    .update({
      import_status: "ignored",
      review_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select("*")
    .single();
  if (error) redirect(`/finance/import/review?error=${encodeURIComponent(error.message)}`);

  await logActivity({
    profile,
    action: "update",
    entityType: "finance_import_row",
    entityId: row.id,
    entityLabel: `Finance import row ${row.source_row}`,
    beforeData: row,
    afterData: after,
    summary: `Ignored finance import row ${row.source_row}`,
  });

  revalidatePath("/finance/import");
  revalidatePath("/finance/import/review");
  redirect(`/finance/import/review?ignored=${encodeURIComponent(String(row.source_row))}`);
}

export async function updateFinanceSettings(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance?settingsError=Supabase%20is%20not%20configured.");

  const snackyLyd = toOptionalAmount(formData.get("opening_balance_snacky_lyd")) ?? toOptionalAmount(formData.get("opening_balance")) ?? 0;
  const snackyUsd = toOptionalAmount(formData.get("opening_balance_snacky_usd")) ?? 0;
  const ownerLyd = toOptionalAmount(formData.get("opening_balance_owner_lyd")) ?? 0;
  const ownerUsd = toOptionalAmount(formData.get("opening_balance_owner_usd")) ?? 0;
  const exchangeRate = toOptionalAmount(formData.get("exchange_rate_usd_to_lyd"));

  const openingBalanceDate = String(formData.get("opening_balance_date") || new Date().toISOString().slice(0, 10));
  const reconciliationCutoffDate = String(formData.get("reconciliation_cutoff_date") || openingBalanceDate || "2026-05-15");
  const payload = {
    id: "default",
    opening_balance: snackyLyd,
    opening_balance_snacky_lyd: snackyLyd,
    opening_balance_snacky_usd: snackyUsd,
    opening_balance_owner_lyd: ownerLyd,
    opening_balance_owner_usd: ownerUsd,
    opening_balance_date: openingBalanceDate,
    reconciliation_cutoff_date: reconciliationCutoffDate,
    default_currency: cleanCurrency(formData.get("default_currency")),
    exchange_rate_usd_to_lyd: exchangeRate,
    updated_by: profile?.team_member_id ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: before } = await supabase.from("finance_settings").select("*").eq("id", "default").maybeSingle();
  const { data: after, error } = await supabase.from("finance_settings").upsert(payload, { onConflict: "id" }).select("*").single();
  if (error) redirect(`/finance?settingsError=${encodeURIComponent(error.message)}`);

  const openingBalanceRows = [
    { account_id: "snacky_lyd", currency: "LYD", balance_date: reconciliationCutoffDate, opening_balance: snackyLyd, notes: "Finance settings opening balance" },
    { account_id: "snacky_usd", currency: "USD", balance_date: reconciliationCutoffDate, opening_balance: snackyUsd, notes: "Finance settings opening balance" },
    { account_id: "owner_lyd", currency: "LYD", balance_date: reconciliationCutoffDate, opening_balance: ownerLyd, notes: "Finance settings opening balance" },
    { account_id: "owner_usd", currency: "USD", balance_date: reconciliationCutoffDate, opening_balance: ownerUsd, notes: "Finance settings opening balance" },
  ];
  const { error: openingError } = await supabase
    .from("finance_opening_balances")
    .upsert(openingBalanceRows, { onConflict: "account_id,balance_date" });
  if (openingError) console.error("[finance] Failed to sync finance opening balance records", openingError);

  await logActivity({
    profile,
    action: before ? "update" : "create",
    entityType: "settings",
    entityId: "finance_settings",
    entityLabel: "Finance settings",
    beforeData: before,
    afterData: after,
    summary: "Updated finance opening balance settings",
  });

  revalidatePath("/finance");
  redirect("/finance?settingsSaved=1");
}

export async function createManualFinancialTransaction(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinanceEdit(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/transactions/new?error=Supabase%20is%20not%20configured.");

  const amount = parseTransactionAmount(formData.get("amount"));
  const transactionDate = String(formData.get("transaction_date") || "").trim();
  const ledgerFields = resolveManualLedgerFields(formData);
  const categoryRecord = await resolveFinanceCategory(supabase, formData, ledgerFields.flowDirection);
  const category = categoryRecord.name;
  const ledgerError = validateManualLedgerFields(ledgerFields, category);
  if (!transactionDate) redirect("/finance/transactions/new?error=Transaction%20date%20is%20required.");
  if (ledgerError) redirect(`/finance/transactions/new?error=${encodeURIComponent(ledgerError)}`);
  if (!Number.isFinite(amount) || amount < 0) redirect("/finance/transactions/new?error=Amount%20must%20be%20greater%20than%20or%20equal%20to%200.");
  if (!category) redirect("/finance/transactions/new?error=Category%20is%20required.");
  const counterparty = counterpartyFields(formData, ledgerFields);

  const payload = {
    transaction_date: transactionDate,
    transaction_datetime: transactionDateTimeFromDate(transactionDate),
    direction: ledgerFields.direction,
    transaction_kind: ledgerFields.direction === "money_in" ? "manual_money_in" : "manual_money_out",
    transaction_type: optionalText(formData.get("transaction_type")),
    location: optionalText(formData.get("location")),
    description: optionalText(formData.get("description")) ?? counterparty.counterpartyText,
    notes: optionalText(formData.get("notes")),
    payment_method: optionalText(formData.get("payment_method")),
    amount,
    signed_amount: ledgerFields.direction === "money_out" ? -amount : amount,
    currency: ledgerFields.currency,
    account_id: ledgerFields.accountId,
    transaction_effect: ledgerFields.transactionEffect,
    source_account_id: ledgerFields.sourceAccountId,
    destination_account_id: ledgerFields.destinationAccountId,
    finance_category_id: categoryRecord.id,
    payer_text: counterparty.payerText,
    payee_text: counterparty.payeeText,
    counterparty_text: counterparty.counterpartyText,
    bucket: optionalText(formData.get("bucket")),
    final_bucket: category,
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    related_purchase_id: optionalUuid(formData.get("related_purchase_id")),
    related_route_id: optionalUuid(formData.get("related_route_id")),
    related_machine_id: optionalUuid(formData.get("related_machine_id")),
    related_location_id: optionalUuid(formData.get("related_location_id")),
    receipt_url: optionalText(formData.get("receipt_url")),
    created_by: profile?.team_member_id ?? null,
  };

  const { data, error } = await supabase.from("financial_transactions").insert(payload).select("id").single();
  if (error) redirect(`/finance/transactions/new?error=${encodeURIComponent(error.message)}`);

  await logActivity({
    profile,
    action: "create",
    entityType: "financial_transaction",
    entityId: data.id,
    entityLabel: "Financial transaction",
    afterData: payload,
    summary: `Created manual ${ledgerFields.transactionEffect === "transfer" ? "transfer" : ledgerFields.direction.replace("_", " ")} transaction`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  redirect(`/finance/transactions/${data.id}?created=1`);
}

export async function reviewFinancialTransaction(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinanceEdit(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const id = String(formData.get("id") || "");
  const { data: before } = await supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle();
  const amount = parseTransactionAmount(formData.get("amount"), before?.amount);
  const ledgerFields = resolveManualLedgerFields(formData, before);
  const transactionDate = String(formData.get("transaction_date") || before?.transaction_date || "").trim();
  const categoryRecord = await resolveFinanceCategory(supabase, formData, ledgerFields.flowDirection, before?.final_bucket);
  const category = categoryRecord.name;
  const ledgerError = validateManualLedgerFields(ledgerFields, category);
  if (!transactionDate) throw new Error("Transaction date is required.");
  if (ledgerError) throw new Error(ledgerError);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Amount must be greater than or equal to 0.");
  if (!category) throw new Error("Category is required.");
  const counterparty = counterpartyFields(formData, ledgerFields);
  const payload = {
    transaction_date: transactionDate,
    transaction_datetime: transactionDateTimeFromDate(transactionDate),
    direction: ledgerFields.direction,
    transaction_type: optionalText(formData.get("transaction_type")),
    location: optionalText(formData.get("location")),
    description: optionalText(formData.get("description")) ?? counterparty.counterpartyText,
    notes: optionalText(formData.get("notes")),
    payment_method: optionalText(formData.get("payment_method")),
    amount,
    signed_amount: ledgerFields.direction === "money_out" ? -amount : amount,
    currency: ledgerFields.currency,
    account_id: ledgerFields.accountId,
    transaction_effect: ledgerFields.transactionEffect,
    source_account_id: ledgerFields.sourceAccountId,
    destination_account_id: ledgerFields.destinationAccountId,
    finance_category_id: categoryRecord.id,
    payer_text: counterparty.payerText,
    payee_text: counterparty.payeeText,
    counterparty_text: counterparty.counterpartyText,
    final_bucket: category,
    review_status: "reviewed",
    needs_review: false,
    reviewed_by: profile?.team_member_id ?? null,
    reviewed_at: new Date().toISOString(),
    review_notes: optionalText(formData.get("review_notes")),
    import_status: before?.transaction_kind === "spreadsheet_import" ? "imported" : before?.import_status ?? null,
    related_purchase_id: optionalUuid(formData.get("related_purchase_id")),
    related_route_id: optionalUuid(formData.get("related_route_id")),
    related_machine_id: optionalUuid(formData.get("related_machine_id")),
    related_location_id: optionalUuid(formData.get("related_location_id")),
    receipt_url: optionalText(formData.get("receipt_url")),
    updated_at: new Date().toISOString(),
  };

  const { data: after, error } = await supabase.from("financial_transactions").update(payload).eq("id", id).select("*").single();
  if (error) throw error;

  await logActivity({
    profile,
    action: "update",
    entityType: "financial_transaction",
    entityId: id,
    entityLabel: "Financial transaction review",
    beforeData: before,
    afterData: after,
    summary: "Reviewed imported financial transaction",
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
}

export async function updateFinancialTransaction(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinanceEdit(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/transactions?error=Supabase%20is%20not%20configured.");

  const id = String(formData.get("id") || "");
  const { data: before } = await supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle();
  if (!before) redirect("/finance/transactions?error=Transaction%20not%20found.");

  const amount = parseTransactionAmount(formData.get("amount"), before.amount);
  const ledgerFields = resolveManualLedgerFields(formData, before);
  const transactionDate = String(formData.get("transaction_date") || "").trim();
  const categoryRecord = await resolveFinanceCategory(supabase, formData, ledgerFields.flowDirection, before.final_bucket);
  const category = categoryRecord.name;
  const ledgerError = validateManualLedgerFields(ledgerFields, category);
  if (!transactionDate) redirect(`/finance/transactions/${id}/edit?error=Transaction%20date%20is%20required.`);
  if (ledgerError) redirect(`/finance/transactions/${id}/edit?error=${encodeURIComponent(ledgerError)}`);
  if (!Number.isFinite(amount) || amount < 0) redirect(`/finance/transactions/${id}/edit?error=Amount%20must%20be%20greater%20than%20or%20equal%20to%200.`);
  if (!category) redirect(`/finance/transactions/${id}/edit?error=Category%20is%20required.`);
  const counterparty = counterpartyFields(formData, ledgerFields);

  const markReviewed = String(formData.get("mark_reviewed") || "") === "on";
  const needsManualReview = String(formData.get("needs_review") || "") === "on" && !markReviewed;
  const reviewStatus = markReviewed ? "reviewed" : needsManualReview ? "needs_review" : "confirmed";
  const payload = {
    transaction_date: transactionDate,
    transaction_datetime: transactionDateTimeFromDate(transactionDate),
    direction: ledgerFields.direction,
    transaction_type: optionalText(formData.get("transaction_type")),
    location: optionalText(formData.get("location")),
    description: optionalText(formData.get("description")) ?? counterparty.counterpartyText,
    notes: optionalText(formData.get("notes")),
    payment_method: optionalText(formData.get("payment_method")),
    amount,
    signed_amount: ledgerFields.direction === "money_out" ? -amount : amount,
    currency: ledgerFields.currency,
    account_id: ledgerFields.accountId,
    transaction_effect: ledgerFields.transactionEffect,
    source_account_id: ledgerFields.sourceAccountId,
    destination_account_id: ledgerFields.destinationAccountId,
    finance_category_id: categoryRecord.id,
    payer_text: counterparty.payerText,
    payee_text: counterparty.payeeText,
    counterparty_text: counterparty.counterpartyText,
    bucket: optionalText(formData.get("bucket")),
    bucket_override: optionalText(formData.get("bucket_override")),
    final_bucket: category,
    review_status: reviewStatus,
    needs_review: needsManualReview,
    reviewed_by: markReviewed ? profile?.team_member_id ?? null : before.reviewed_by,
    reviewed_at: markReviewed ? new Date().toISOString() : before.reviewed_at,
    review_notes: optionalText(formData.get("review_notes")),
    import_status: before.transaction_kind === "spreadsheet_import" ? (reviewStatus === "needs_review" ? "needs_review" : "imported") : before.import_status ?? null,
    related_purchase_id: optionalUuid(formData.get("related_purchase_id")),
    related_route_id: optionalUuid(formData.get("related_route_id")),
    related_machine_id: optionalUuid(formData.get("related_machine_id")),
    related_location_id: optionalUuid(formData.get("related_location_id")),
    receipt_url: optionalText(formData.get("receipt_url")),
    updated_at: new Date().toISOString(),
  };

  const { data: after, error } = await supabase.from("financial_transactions").update(payload).eq("id", id).select("*").single();
  if (error) redirect(`/finance/transactions/${id}/edit?error=${encodeURIComponent(error.message)}`);

  await logActivity({
    profile,
    action: "update",
    entityType: "financial_transaction",
    entityId: id,
    entityLabel: "Financial transaction",
    beforeData: before,
    afterData: after,
    summary: "Updated financial transaction",
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  revalidatePath(`/finance/transactions/${id}`);
  redirect(`/finance/transactions/${id}?saved=1`);
}

export async function deleteFinancialTransaction(formData: FormData) {
  return updateFinancialTransactionStatus(formData);
}

export async function updateFinancialTransactionStatus(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinanceEdit(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/transactions?error=Supabase%20is%20not%20configured.");

  const id = String(formData.get("id") || "");
  const status = String(formData.get("transaction_status") || "");
  const confirmBalanceRemoval = String(formData.get("confirm_balance_removal") || "") === "yes";
  const statusReason = optionalText(formData.get("status_reason"));
  if (!["voided", "archived"].includes(status)) redirect(`/finance/transactions/${id}?error=Choose%20void%20or%20archive.`);
  if (!confirmBalanceRemoval) redirect(`/finance/transactions/${id}?error=Confirmation%20is%20required.`);
  if (!statusReason) redirect(`/finance/transactions/${id}?error=Reason%20is%20required.`);

  const { data: before } = await supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle();
  if (!before) redirect("/finance/transactions?error=Transaction%20not%20found.");
  if ((before.transaction_status ?? "active") !== "active") redirect(`/finance/transactions/${id}?error=Only%20active%20transactions%20can%20be%20voided%20or%20archived.`);

  const now = new Date().toISOString();
  const payload =
    status === "voided"
      ? {
          transaction_status: "voided",
          voided_at: now,
          voided_by: profile?.team_member_id ?? null,
          status_reason: statusReason,
          updated_at: now,
        }
      : {
          transaction_status: "archived",
          archived_at: now,
          archived_by: profile?.team_member_id ?? null,
          status_reason: statusReason,
          updated_at: now,
        };

  const { data: after, error } = await supabase.from("financial_transactions").update(payload).eq("id", id).select("*").single();
  if (error) redirect(`/finance/transactions/${id}?error=${encodeURIComponent(error.message)}`);

  await logActivity({
    profile,
    action: status === "voided" ? "void" : "archive",
    entityType: "financial_transaction",
    entityId: id,
    entityLabel: "Financial transaction",
    beforeData: before,
    afterData: after,
    metadata: { reason: statusReason },
    summary: status === "voided" ? "Voided financial transaction" : "Archived financial transaction",
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  revalidatePath(`/finance/transactions/${id}`);
  redirect(`/finance/transactions/${id}?status=${status}`);
}

export async function createPurchaseFinancialTransaction(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, profile: Awaited<ReturnType<typeof getCurrentProfile>>, purchase: any, amount: number) {
  if (!purchase?.id || !amount || amount <= 0) return;
  const transactionDate = resolvePurchaseFinanceTransactionDate(purchase);
  const payload = {
    transaction_date: transactionDate,
    transaction_datetime: transactionDateTimeFromDate(transactionDate),
    direction: "money_out",
    transaction_kind: "product_purchase",
    transaction_type: "Products Restocking",
    description: purchase.receipt_number ? `Purchase ${purchase.receipt_number}` : "Purchase received",
    amount,
    signed_amount: -Math.abs(amount),
    currency: "LYD",
    account_id: "snacky_lyd",
    transaction_effect: "expense",
    source_account_id: null,
    destination_account_id: null,
    bucket: "Inventory",
    final_bucket: "Products Restocking",
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    payment_method: purchase.payment_method ?? null,
    receipt_url: purchase.receipt_url ?? null,
    related_purchase_id: purchase.id,
    created_by: profile?.team_member_id ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data: existing, error: existingError } = await supabase.from("financial_transactions").select("id").eq("transaction_kind", "product_purchase").eq("related_purchase_id", purchase.id).maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) {
    const { error } = await supabase.from("financial_transactions").update(payload).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("financial_transactions").insert(payload);
    if (error) throw error;
  }
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
}

export async function createCashCollectionFinancialTransaction(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, profile: Awaited<ReturnType<typeof getCurrentProfile>>, cash: any) {
  if (!cash?.id) return;
  const parsedAmount = Number(cash?.actual_cash_collected ?? 0);
  const amount = Number.isFinite(parsedAmount) ? Math.max(0, Math.round(parsedAmount * 100) / 100) : 0;
  const cashTransactionDateTime = resolveCashCollectionTransactionDateTime(cash);
  const payload = {
    transaction_date: cashTransactionDateTime.transactionDate,
    transaction_datetime: cashTransactionDateTime.transactionDatetime,
    direction: "money_in",
    transaction_kind: "cash_collection",
    transaction_type: "Revenue",
    description: cash.cash_bag_id ? `Cash collection ${cash.cash_bag_id}` : `Confirmed cash collection ${cash.id.slice(0, 8)}`,
    amount,
    signed_amount: Math.abs(amount),
    currency: "LYD",
    account_id: "snacky_lyd",
    transaction_effect: "income",
    source_account_id: null,
    destination_account_id: null,
    bucket: "Revenue",
    final_bucket: "Revenue",
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    payment_method: "cash",
    related_cash_collection_id: cash.id,
    related_route_id: cash.route_id ?? null,
    related_machine_id: cash.machine_id ?? null,
    created_by: profile?.team_member_id ?? cash.operator_id ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data: existingRows, error: existingError } = await supabase
    .from("financial_transactions")
    .select("id, transaction_status, created_at")
    .eq("transaction_kind", "cash_collection")
    .eq("related_cash_collection_id", cash.id)
    .order("created_at", { ascending: true });
  if (existingError) throw existingError;

  const existing = existingRows?.find((row: any) => (row.transaction_status ?? "active") === "active") ?? existingRows?.[0];
  const duplicateActiveIds = (existingRows ?? [])
    .filter((row: any) => row.id !== existing?.id && (row.transaction_status ?? "active") === "active")
    .map((row: any) => row.id);

  if (duplicateActiveIds.length) {
    const { error: duplicateError } = await supabase
      .from("financial_transactions")
      .update({
        transaction_status: "voided",
        voided_at: new Date().toISOString(),
        voided_by: profile?.team_member_id ?? null,
        status_reason: "Duplicate cash collection transaction superseded by the active linked transaction.",
        updated_at: new Date().toISOString(),
      })
      .in("id", duplicateActiveIds);
    if (duplicateError) throw duplicateError;
  }

  if (existing?.id) {
    const { error } = await supabase.from("financial_transactions").update(payload).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("financial_transactions").insert(payload);
    if (error) throw error;
  }
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
}

export async function clearCashCollectionFinancialTransaction(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  profile: Awaited<ReturnType<typeof getCurrentProfile>>,
  cashCollectionId: string,
  reason = "Cash count was cleared before finance confirmation.",
) {
  const { data: activeRows, error: activeError } = await supabase
    .from("financial_transactions")
    .select("*")
    .eq("transaction_kind", "cash_collection")
    .eq("related_cash_collection_id", cashCollectionId)
    .eq("transaction_status", "active");
  if (activeError) throw activeError;
  if (!activeRows?.length) return;

  const now = new Date().toISOString();
  const activeIds = activeRows.map((row: any) => row.id);
  const { data: updatedRows, error: updateError } = await supabase
    .from("financial_transactions")
    .update({
      transaction_status: "voided",
      voided_at: now,
      voided_by: profile?.team_member_id ?? null,
      status_reason: reason,
      updated_at: now,
    })
    .in("id", activeIds)
    .select("*");
  if (updateError) throw updateError;

  for (const financeRow of updatedRows ?? []) {
    await logActivity({
      profile,
      action: "void",
      entityType: "financial_transaction",
      entityId: financeRow.id,
      entityLabel: "Cash collection financial transaction",
      beforeData: activeRows.find((row: any) => row.id === financeRow.id),
      afterData: financeRow,
      metadata: { reason, related_cash_collection_id: cashCollectionId },
      summary: "Voided linked cash finance transaction after the counted amount was cleared",
    });
  }

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
}
