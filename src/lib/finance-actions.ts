"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import {
  buildFinanceImportStageRow,
  buildFinanceTransaction,
  classifyFinanceRows,
  FINANCE_SOURCE_FILE,
  FINANCE_SOURCE_SHEET,
  readFinanceImportRows,
} from "@/lib/finance-import";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function requireFinance(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
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
  return currency ? currency.slice(0, 8) : "LYD";
}

function optionalUuid(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function optionalText(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function transactionCategory(formData: FormData, fallback?: string | null) {
  return optionalText(formData.get("category")) ?? optionalText(formData.get("final_bucket")) ?? fallback ?? null;
}

export async function importHistoricalFinanceTransactions() {
  const profile = await getCurrentProfile();
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/import?error=Supabase%20is%20not%20configured.");

  const rows = await readFinanceImportRows();
  const { data: existingRows, error: existingError } = await supabase
    .from("financial_transactions")
    .select("id, source_file, source_sheet, source_row, transaction_date, signed_amount, description, original_description")
    .limit(20000);
  if (existingError) redirect(`/finance/import?error=${encodeURIComponent(existingError.message)}`);

  const classifiedRows = classifyFinanceRows(rows, (existingRows ?? []) as any[]);
  const transactionRows = classifiedRows.flatMap((row) => {
    const transaction = buildFinanceTransaction(row, profile?.team_member_id);
    return transaction ? [transaction] : [];
  });
  const importedRows = classifiedRows.filter((row) => row.importStatus === "imported").length;
  const reviewRows = classifiedRows.filter((row) => row.importStatus === "needs_review").length;
  const skippedRows = classifiedRows.filter((row) => row.importStatus === "skipped").length;
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
  const stageRows = classifiedRows.map((row) => buildFinanceImportStageRow(row, insertedBySource.get(`${row.sourceFile}|${row.sourceSheet}|${row.sourceRow}`)));
  if (stageRows.length) {
    const { error } = await supabase.from("finance_import_rows").upsert(stageRows, { onConflict: "source_file,source_sheet,source_row" });
    if (error) {
      console.error("[finance:import] Failed to stage import rows", error);
      redirect(`/finance/import?error=${encodeURIComponent(error.message)}`);
    }
  }

  await logActivity({
    profile,
    action: "create",
    entityType: "finance_import",
    entityLabel: "Finance import",
    afterData: {
      source_file: FINANCE_SOURCE_FILE,
      source_sheet: FINANCE_SOURCE_SHEET,
      total_rows: rows.length,
      imported_rows: importedRows,
      needs_review_rows: reviewRows,
      skipped_rows: skippedRows,
    },
    summary: `Imported ${importedRows} valid finance rows, staged ${reviewRows} for review, skipped ${skippedRows}`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/import");
  revalidatePath("/finance/transactions");
  redirect(`/finance/import?total=${rows.length}&imported=${importedRows}&needsReview=${reviewRows}&skipped=${skippedRows}`);
}

export async function updateFinanceSettings(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance?settingsError=Supabase%20is%20not%20configured.");

  const openingBalance = toOptionalAmount(formData.get("opening_balance"));
  if (openingBalance === null) redirect("/finance?settingsError=Opening%20balance%20is%20required.");

  const openingBalanceDate = String(formData.get("opening_balance_date") || new Date().toISOString().slice(0, 10));
  const payload = {
    id: "default",
    opening_balance: openingBalance,
    opening_balance_date: openingBalanceDate,
    default_currency: cleanCurrency(formData.get("default_currency")),
    updated_by: profile?.team_member_id ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: before } = await supabase.from("finance_settings").select("*").eq("id", "default").maybeSingle();
  const { data: after, error } = await supabase.from("finance_settings").upsert(payload, { onConflict: "id" }).select("*").single();
  if (error) redirect(`/finance?settingsError=${encodeURIComponent(error.message)}`);

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
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/transactions/new?error=Supabase%20is%20not%20configured.");

  const direction = String(formData.get("direction") || "money_out");
  const amount = Math.abs(Number(formData.get("amount") || 0));
  const transactionDate = String(formData.get("transaction_date") || new Date().toISOString().slice(0, 10));
  if (!amount || amount <= 0) redirect("/finance/transactions/new?error=Amount%20must%20be%20greater%20than%200.");

  const payload = {
    transaction_date: transactionDate,
    direction,
    transaction_kind: direction === "money_in" ? "manual_money_in" : "manual_money_out",
    transaction_type: optionalText(formData.get("transaction_type")),
    location: optionalText(formData.get("location")),
    description: optionalText(formData.get("description")),
    notes: optionalText(formData.get("notes")),
    payment_method: optionalText(formData.get("payment_method")),
    amount,
    signed_amount: direction === "money_out" ? -amount : amount,
    bucket: optionalText(formData.get("bucket")),
    final_bucket: transactionCategory(formData),
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
    summary: `Created manual ${direction.replace("_", " ")} transaction`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  redirect(`/finance/transactions/${data.id}?created=1`);
}

export async function reviewFinancialTransaction(formData: FormData) {
  const profile = await getCurrentProfile();
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const id = String(formData.get("id") || "");
  const { data: before } = await supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle();
  const amount = Math.abs(Number(formData.get("amount") || before?.amount || 0));
  const direction = String(formData.get("direction") || before?.direction || "money_out");
  const payload = {
    transaction_date: String(formData.get("transaction_date") || before?.transaction_date),
    direction,
    transaction_type: optionalText(formData.get("transaction_type")),
    location: optionalText(formData.get("location")),
    description: optionalText(formData.get("description")),
    notes: optionalText(formData.get("notes")),
    payment_method: optionalText(formData.get("payment_method")),
    amount,
    signed_amount: direction === "money_out" ? -amount : amount,
    final_bucket: transactionCategory(formData, before?.final_bucket),
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
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/transactions?error=Supabase%20is%20not%20configured.");

  const id = String(formData.get("id") || "");
  const { data: before } = await supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle();
  if (!before) redirect("/finance/transactions?error=Transaction%20not%20found.");

  const direction = String(formData.get("direction") || before.direction || "money_out");
  const amount = Math.abs(Number(formData.get("amount") || before.amount || 0));
  if (!amount || amount <= 0) redirect(`/finance/transactions/${id}/edit?error=Amount%20must%20be%20greater%20than%200.`);

  const markReviewed = String(formData.get("mark_reviewed") || "") === "on";
  const needsManualReview = String(formData.get("needs_review") || "") === "on" && !markReviewed;
  const reviewStatus = markReviewed ? "reviewed" : needsManualReview ? "needs_review" : "confirmed";
  const payload = {
    transaction_date: String(formData.get("transaction_date") || before.transaction_date),
    direction,
    transaction_type: optionalText(formData.get("transaction_type")),
    location: optionalText(formData.get("location")),
    description: optionalText(formData.get("description")),
    notes: optionalText(formData.get("notes")),
    payment_method: optionalText(formData.get("payment_method")),
    amount,
    signed_amount: direction === "money_out" ? -amount : amount,
    bucket: optionalText(formData.get("bucket")),
    bucket_override: optionalText(formData.get("bucket_override")),
    final_bucket: transactionCategory(formData, before.final_bucket),
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
  requireFinance(profile);
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
  const payload = {
    transaction_date: purchase.received_date ?? new Date().toISOString().slice(0, 10),
    direction: "money_out",
    transaction_kind: "product_purchase",
    transaction_type: "Product Restocking",
    description: purchase.receipt_number ? `Purchase ${purchase.receipt_number}` : "Purchase received",
    amount,
    signed_amount: -Math.abs(amount),
    bucket: "Inventory",
    final_bucket: "Inventory",
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
  const payload = {
    transaction_date: String(cash.counted_at ?? cash.collected_at ?? new Date().toISOString()).slice(0, 10),
    direction: "money_in",
    transaction_kind: "cash_collection",
    transaction_type: "Cash Collection",
    description: cash.cash_bag_id ? `Cash collection ${cash.cash_bag_id}` : `Confirmed cash collection ${cash.id.slice(0, 8)}`,
    amount,
    signed_amount: Math.abs(amount),
    bucket: "Cash Collection",
    final_bucket: "Cash Collection",
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
