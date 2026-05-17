"use server";

import fs from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const sourceSheet = "financial_transactions.csv";

function requireFinance(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }
}

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
  return rows.slice(1).map((values, index) => ({
    sourceRow: index + 2,
    record: Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] ?? ""])),
  }));
}

function moneyDirection(value: string) {
  return value.trim().toLowerCase() === "money out" ? "money_out" : "money_in";
}

function toAmount(value: string) {
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function needsReview(record: Record<string, string>) {
  return Object.values(record).some((value) => value.trim() === "TO_CONFIRM") || record.auto_bucket === "Review" || record.final_bucket === "Review";
}

function rowToTransaction(record: Record<string, string>, sourceRow: number, createdBy?: string | null) {
  const signedAmount = toAmount(record.signed_amount || record.transaction);
  const direction = moneyDirection(record.money_flow);
  const review = needsReview(record);

  return {
    transaction_date: record.date,
    direction,
    transaction_kind: "spreadsheet_import",
    transaction_type: record.transaction_type || null,
    location: record.location || null,
    description: record.transaction_description || null,
    amount: Math.abs(signedAmount),
    signed_amount: direction === "money_out" ? -Math.abs(signedAmount) : Math.abs(signedAmount),
    bucket: record.auto_bucket || null,
    bucket_override: record.bucket_override || null,
    final_bucket: record.final_bucket || null,
    review_status: review ? "needs_review" : "confirmed",
    needs_review: review,
    source_sheet: sourceSheet,
    source_row: sourceRow,
    created_by: createdBy ?? null,
    metadata: {
      original_transaction: record.transaction || null,
      original_money_flow: record.money_flow || null,
      original_row: record,
    },
  };
}

export async function importHistoricalFinanceTransactions() {
  const profile = await getCurrentProfile();
  requireFinance(profile);
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/import?error=Supabase%20is%20not%20configured.");

  const csvPath = path.join(process.cwd(), "docs", "current-data", sourceSheet);
  const text = await fs.readFile(csvPath, "utf8");
  const rows = parseCsv(text);
  const sourceRows = rows.map((row) => row.sourceRow);
  const { data: existing } = sourceRows.length
    ? await supabase.from("financial_transactions").select("source_row").eq("source_sheet", sourceSheet).in("source_row", sourceRows)
    : { data: [] };
  const existingRows = new Set((existing ?? []).map((row: any) => Number(row.source_row)));
  const inserts = rows.filter((row) => !existingRows.has(row.sourceRow)).map(({ record, sourceRow }) => rowToTransaction(record, sourceRow, profile?.team_member_id));

  if (inserts.length) {
    const { error } = await supabase.from("financial_transactions").insert(inserts);
    if (error) {
      console.error("[finance:import] Failed to import financial transactions", error);
      redirect(`/finance/import?error=${encodeURIComponent(error.message)}`);
    }
  }

  await logActivity({
    profile,
    action: "create",
    entityType: "settings",
    entityLabel: "Finance import",
    afterData: { source_sheet: sourceSheet, inserted_rows: inserts.length, skipped_existing_rows: rows.length - inserts.length },
    summary: `Imported ${inserts.length} historical finance transactions`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/import");
  revalidatePath("/finance/transactions");
  redirect(`/finance/import?imported=${inserts.length}&skipped=${rows.length - inserts.length}`);
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
    transaction_type: String(formData.get("transaction_type") || "").trim() || null,
    location: String(formData.get("location") || "").trim() || null,
    description: String(formData.get("description") || "").trim() || null,
    amount,
    signed_amount: direction === "money_out" ? -amount : amount,
    bucket: String(formData.get("bucket") || "").trim() || null,
    final_bucket: String(formData.get("final_bucket") || "").trim() || null,
    review_status: "confirmed",
    needs_review: false,
    created_by: profile?.team_member_id ?? null,
  };

  const { data, error } = await supabase.from("financial_transactions").insert(payload).select("id").single();
  if (error) redirect(`/finance/transactions/new?error=${encodeURIComponent(error.message)}`);

  await logActivity({
    profile,
    action: "create",
    entityType: "settings",
    entityId: data.id,
    entityLabel: "Financial transaction",
    afterData: payload,
    summary: `Created manual ${direction.replace("_", " ")} transaction`,
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  redirect("/finance/transactions");
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
    transaction_type: String(formData.get("transaction_type") || "").trim() || null,
    location: String(formData.get("location") || "").trim() || null,
    description: String(formData.get("description") || "").trim() || null,
    amount,
    signed_amount: direction === "money_out" ? -amount : amount,
    final_bucket: String(formData.get("final_bucket") || "").trim() || null,
    review_status: "reviewed",
    needs_review: false,
    reviewed_by: profile?.team_member_id ?? null,
    reviewed_at: new Date().toISOString(),
    review_notes: String(formData.get("review_notes") || "").trim() || null,
    updated_at: new Date().toISOString(),
  };

  const { data: after, error } = await supabase.from("financial_transactions").update(payload).eq("id", id).select("*").single();
  if (error) throw error;

  await logActivity({
    profile,
    action: "update",
    entityType: "settings",
    entityId: id,
    entityLabel: "Financial transaction review",
    beforeData: before,
    afterData: after,
    summary: "Reviewed imported financial transaction",
  });

  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
}

export async function createPurchaseFinancialTransaction(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, profile: Awaited<ReturnType<typeof getCurrentProfile>>, purchase: any, amount: number) {
  if (!purchase?.id || !amount || amount <= 0) return;
  await supabase.from("financial_transactions").insert({
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
    related_purchase_id: purchase.id,
    created_by: profile?.team_member_id ?? null,
  });
}

export async function createCashCollectionFinancialTransaction(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, profile: Awaited<ReturnType<typeof getCurrentProfile>>, cash: any) {
  const amount = Number(cash?.actual_cash_collected ?? 0);
  if (!cash?.id || amount <= 0) return;
  await supabase.from("financial_transactions").insert({
    transaction_date: String(cash.collected_at ?? new Date().toISOString()).slice(0, 10),
    direction: "money_in",
    transaction_kind: "cash_collection",
    transaction_type: "Cash Collection",
    description: `Confirmed cash collection ${cash.id}`,
    amount,
    signed_amount: Math.abs(amount),
    bucket: "Inflow",
    final_bucket: "Inflow",
    review_status: "confirmed",
    needs_review: false,
    related_cash_collection_id: cash.id,
    created_by: profile?.team_member_id ?? cash.operator_id ?? null,
  });
}
