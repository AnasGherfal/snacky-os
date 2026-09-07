"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { calculateCashVariance, statusForConfirmedCash } from "@/lib/cash-collections";
import { clearCashCollectionFinancialTransaction, createCashCollectionFinancialTransaction } from "@/lib/finance-actions";
import { getRequiredFinanceWriteClient } from "@/lib/finance-write-client";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function optionalUuid(value: FormDataEntryValue | null) {
  return clean(value) || null;
}

function optionalText(value: FormDataEntryValue | null) {
  return clean(value) || null;
}

function optionalAmount(value: FormDataEntryValue | null) {
  const raw = clean(value).replace(/,/g, "");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function requiredAmount(value: FormDataEntryValue | null, path: string, label: string) {
  const amount = optionalAmount(value);
  if (amount === null || amount < 0) fail(path, `${label} is required.`);
  return amount;
}

function normalizeCollectedAt(value: FormDataEntryValue | null) {
  const raw = clean(value);
  if (!raw) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00.000Z`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function requireConfirmedReason(formData: FormData, path: string) {
  if (clean(formData.get("confirm_action")) !== "yes") fail(path, "Confirmation is required.");
  const reason = clean(formData.get("reason"));
  if (!reason) fail(path, "Reason is required.");
  return reason;
}

async function requireCashReviewAccess(path: string) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

function revalidateCashPaths(id?: string) {
  revalidatePath("/cash-collections");
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  if (id) {
    revalidatePath(`/cash-collections/${id}`);
    revalidatePath(`/cash-collections/${id}/edit`);
  }
}

export async function createManualCashCollection(formData: FormData) {
  const { profile, supabase } = await requireCashReviewAccess("/cash-collections/new");
  const machineId = optionalUuid(formData.get("machine_id"));
  if (!machineId) fail("/cash-collections/new", "Machine is required.");

  const countedAmount = requiredAmount(formData.get("counted_amount_lyd"), "/cash-collections/new", "Counted amount");
  const expectedCash = null;
  const variance = calculateCashVariance(countedAmount, expectedCash);
  const reviewStatus = statusForConfirmedCash(variance);
  const payload = {
    machine_id: machineId,
    route_id: optionalUuid(formData.get("route_id")),
    operator_id: optionalUuid(formData.get("operator_id")),
    collected_at: normalizeCollectedAt(formData.get("collected_at")),
    vms_expected_cash: expectedCash,
    actual_cash_collected: countedAmount,
    review_status: reviewStatus,
    cash_bag_id: optionalText(formData.get("cash_bag_id")),
    counted_at: new Date().toISOString(),
    counted_by: profile.team_member_id,
    notes: optionalText(formData.get("notes")),
  };

  const { data: cash, error } = await supabase
    .from("cash_collections")
    .insert(payload)
    .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, counted_at, counted_by, notes, collected_at")
    .single();
  if (error || !cash) {
    console.error("[cash] Failed to create manual cash collection", error);
    fail("/cash-collections/new", "Could not create cash collection.");
  }

  try {
    await createCashCollectionFinancialTransaction(supabase, profile, cash);
  } catch (error) {
    console.error("[cash] Failed to post manual cash collection to finance", error);
    revalidateCashPaths(cash.id);
    redirect(`/cash-collections/${cash.id}?error=${encodeURIComponent("Cash collection was saved, but the finance transaction could not be posted. Review this collection before closing cash.")}`);
  }
  await logActivity({
    profile,
    action: "create_cash_collection",
    entityType: "cash_collection",
    entityId: cash.id,
    entityLabel: `Cash ${cash.id.slice(0, 8)}`,
    afterData: cash,
    metadata: { source: "manual", variance },
    summary: "Created and confirmed manual cash collection",
  });

  revalidateCashPaths(cash.id);
  redirect(`/cash-collections/${cash.id}`);
}

export async function confirmCashCollectionCount(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCashReviewAccess(path);
  const countedAmount = requiredAmount(formData.get("counted_amount_lyd"), path, "Counted amount");

  const { data: before, error: beforeError } = await supabase.from("cash_collections").select("*").eq("id", id).maybeSingle();
  if (beforeError || !before) fail("/cash-collections", "Cash collection not found.");
  if (before.review_status === "voided") fail(path, "Voided cash collections cannot be counted.");

  const expectedCash = null;
  const variance = calculateCashVariance(countedAmount, expectedCash);
  const reviewStatus = statusForConfirmedCash(variance);

  const payload = {
    vms_expected_cash: expectedCash,
    actual_cash_collected: countedAmount,
    review_status: reviewStatus,
    cash_bag_id: optionalText(formData.get("cash_bag_id")) ?? before.cash_bag_id ?? null,
    counted_at: new Date().toISOString(),
    counted_by: profile.team_member_id,
    notes: optionalText(formData.get("notes")),
  };

  const { data: cash, error } = await supabase
    .from("cash_collections")
    .update(payload)
    .eq("id", id)
    .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, counted_at, counted_by, notes, collected_at")
    .single();
  if (error || !cash) {
    console.error("[cash] Failed to confirm cash count", error);
    fail(path, "Could not confirm cash count.");
  }

  try {
    await createCashCollectionFinancialTransaction(supabase, profile, cash);
  } catch (error) {
    console.error("[cash] Failed to post confirmed cash count to finance", error);
    revalidateCashPaths(id);
    redirect(`${path}?error=${encodeURIComponent("Cash count was saved, but the finance transaction could not be posted. Review this collection before closing cash.")}`);
  }
  await logActivity({
    profile,
    action: "confirm_cash_count",
    entityType: "cash_collection",
    entityId: id,
    entityLabel: `Cash ${id.slice(0, 8)}`,
    beforeData: before,
    afterData: cash,
    metadata: { variance, related_finance: true },
    summary: reviewStatus === "variance_review" ? "Confirmed cash count with variance review" : "Confirmed cash count and posted finance transaction",
  });

  revalidateCashPaths(id);
  redirect(path);
}

export async function updateCashCollection(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}/edit`;
  const { profile, supabase } = await requireCashReviewAccess(path);

  const { data: before, error: beforeError } = await supabase.from("cash_collections").select("*").eq("id", id).maybeSingle();
  if (beforeError || !before) fail("/cash-collections", "Cash collection not found.");
  if (before.review_status === "voided") fail(`/cash-collections/${id}`, "Voided cash collections cannot be edited.");

  const machineId = optionalUuid(formData.get("machine_id"));
  if (!machineId) fail(path, "Machine is required.");
  const countedAmount = optionalAmount(formData.get("counted_amount_lyd"));
  const expectedCash = null;
  const hasCount = countedAmount !== null;
  const variance = hasCount ? calculateCashVariance(countedAmount, expectedCash) : null;
  const reviewStatus = hasCount ? statusForConfirmedCash(variance) : "collected_pending_count";

  const payload = {
    machine_id: machineId,
    route_id: optionalUuid(formData.get("route_id")),
    operator_id: optionalUuid(formData.get("operator_id")),
    collected_at: normalizeCollectedAt(formData.get("collected_at")),
    vms_expected_cash: expectedCash,
    actual_cash_collected: countedAmount,
    review_status: reviewStatus,
    cash_bag_id: optionalText(formData.get("cash_bag_id")),
    counted_at: hasCount ? before.counted_at ?? new Date().toISOString() : null,
    counted_by: hasCount ? before.counted_by ?? profile.team_member_id : null,
    notes: optionalText(formData.get("notes")),
  };

  const { data: cash, error } = await supabase
    .from("cash_collections")
    .update(payload)
    .eq("id", id)
    .select("id, route_id, machine_id, operator_id, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, counted_at, counted_by, notes, collected_at")
    .single();
  if (error || !cash) {
    console.error("[cash] Failed to update cash collection", error);
    fail(path, "Could not update cash collection.");
  }

  try {
    if (hasCount) {
      await createCashCollectionFinancialTransaction(supabase, profile, cash);
    } else {
      await clearCashCollectionFinancialTransaction(supabase, profile, id, "Cash collection was moved back to pending count.");
    }
  } catch (error) {
    console.error("[cash] Failed to sync cash collection finance transaction", error);
    revalidateCashPaths(id);
    redirect(`/cash-collections/${id}?error=${encodeURIComponent("Cash collection was saved, but its finance transaction could not be synced. Review this collection before closing cash.")}`);
  }

  await logActivity({
    profile,
    action: "update_cash_collection",
    entityType: "cash_collection",
    entityId: id,
    entityLabel: `Cash ${id.slice(0, 8)}`,
    beforeData: before,
    afterData: cash,
    metadata: { variance, related_finance: hasCount },
    summary: hasCount ? "Updated counted cash collection and linked finance transaction" : "Updated pending cash collection",
  });

  revalidateCashPaths(id);
  redirect(`/cash-collections/${id}`);
}

export async function voidCashCollection(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const reason = requireConfirmedReason(formData, path);
  const { profile, supabase } = await requireCashReviewAccess(path);
  const financeWriteSupabase = getRequiredFinanceWriteClient();

  const { data: before, error: beforeError } = await supabase.from("cash_collections").select("*").eq("id", id).maybeSingle();
  if (beforeError || !before) fail("/cash-collections", "Cash collection not found.");
  if (before.review_status === "voided") fail(path, "This cash collection is already voided.");

  const now = new Date().toISOString();
  const { data: cash, error } = await supabase
    .from("cash_collections")
    .update({
      review_status: "voided",
      voided_at: now,
      voided_by: profile.team_member_id,
      void_reason: reason,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !cash) {
    console.error("[cash] Failed to void cash collection", error);
    fail(path, "Could not void cash collection.");
  }

  const { data: financeBefore } = await supabase
    .from("financial_transactions")
    .select("*")
    .eq("transaction_kind", "cash_collection")
    .or(`linked_cash_collection_id.eq.${id},and(source_type.eq.cash_collection,source_id.eq.${id})`)
    .eq("transaction_status", "active");

  if (financeBefore?.length) {
    const financeIds = financeBefore.map((row: any) => row.id);
    const { data: financeAfter, error: financeError } = await financeWriteSupabase
      .from("financial_transactions")
      .update({
        transaction_status: "voided",
        voided_at: now,
        voided_by: profile.team_member_id,
        status_reason: reason,
        updated_at: now,
      })
      .in("id", financeIds)
      .select("*");
    if (financeError) {
      console.error("[cash] Failed to void linked finance transaction", financeError);
      fail(path, "Cash was voided, but linked finance transaction could not be voided.");
    }

    for (const financeRow of financeAfter ?? []) {
      await logActivity({
        profile,
        action: "void",
        entityType: "financial_transaction",
        entityId: financeRow.id,
        entityLabel: "Cash collection financial transaction",
        beforeData: financeBefore.find((row: any) => row.id === financeRow.id),
        afterData: financeRow,
        metadata: { reason, linked_cash_collection_id: id },
        summary: "Voided financial transaction linked to a voided cash collection",
      });
    }
  }

  await logActivity({
    profile,
    action: "void",
    entityType: "cash_collection",
    entityId: id,
    entityLabel: `Cash ${id.slice(0, 8)}`,
    beforeData: before,
    afterData: cash,
    metadata: { reason, financial_transaction_count: financeBefore?.length ?? 0 },
    summary: "Voided cash collection and linked finance transaction",
  });

  revalidateCashPaths(id);
  redirect(path);
}

export async function reviewCashCollection(formData: FormData) {
  return confirmCashCollectionCount(formData);
}

export async function createMissingCashFinanceLinks() {
  const path = "/cash-collections";
  const { profile, supabase } = await requireCashReviewAccess(path);
  let successMessage = "Missing finance links created.";

  try {
    const result = await supabase.rpc("backfill_missing_finance_transactions");
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    const cashCreated = Number(row?.cash_collection_transactions_created ?? row?.cash_collection_finance_transactions_synced ?? 0);
    const purchaseCreated = Number(row?.purchase_transactions_created ?? row?.purchase_finance_transactions_synced ?? 0);
    successMessage = `Created ${cashCreated} cash finance link(s) and ${purchaseCreated} purchase finance link(s).`;

    await logActivity({
      profile,
      action: "create_missing_cash_finance_links",
      entityType: "finance",
      entityLabel: "Cash collection finance links",
      afterData: row ?? result.data,
      summary: "Created missing finance links from the cash collections page",
    });

    revalidateCashPaths();
  } catch (error) {
    console.error("[cash] Failed to create missing finance links", error);
    fail(path, "Could not create missing finance links. Confirm the latest finance migration has been applied and your role can manage finance.");
  }

  redirect(`${path}?success=${encodeURIComponent(successMessage)}`);
}
