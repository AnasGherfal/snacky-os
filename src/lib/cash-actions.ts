"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { UserProfile } from "@/lib/auth";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import {
  canApproveCashVariance,
  canCountCash,
  canReceiveCashStorage,
  canRecordCashRemoval,
  canReconcileCash,
  canViewFinancials,
  hasAnyRole,
  type AuthUserContext,
} from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";
import { CASH_DENOMINATIONS, denominationFieldName } from "@/lib/cash-custody";
import { removeCashEvidence, uploadCashEvidence, type CashEvidenceUpload } from "@/lib/cash-evidence";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
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

function normalizeLibyaDateTime(value: FormDataEntryValue | null) {
  const raw = clean(value);
  if (!raw) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}:00+02:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function profileContext(profile: UserProfile): AuthUserContext {
  return {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  };
}

async function requireCapability(path: string, allowed: (user: AuthUserContext) => boolean) {
  const profile = await getCurrentProfile();
  if (!profile || !allowed(profileContext(profile))) redirect("/unauthorized");
  if (!profile.team_member_id) fail(path, "Your account must be linked to a team member before handling cash.");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

function requireConfirmation(formData: FormData, path: string) {
  if (clean(formData.get("confirm_action")) !== "yes") fail(path, "Confirmation is required.");
  const reason = clean(formData.get("reason"));
  if (!reason) fail(path, "A detailed reason is required.");
  return reason;
}

function rpcMessage(error: { message?: string | null } | null | undefined, fallback: string) {
  const message = String(error?.message ?? "").replace(/^.*?error:\s*/i, "").trim();
  return message && message.length <= 300 ? message : fallback;
}

async function requiredEvidence(
  value: FormDataEntryValue | null,
  path: string,
  options: { scopeId: string; stage: "removed" | "stored" | "counted" },
): Promise<CashEvidenceUpload> {
  try {
    const upload = await uploadCashEvidence(value, { ...options, required: true });
    if (!upload) fail(path, "Required cash evidence is missing.");
    return upload;
  } catch (error) {
    console.error("[cash] Failed to upload custody evidence", error);
    fail(path, error instanceof Error ? error.message : "Could not securely upload the required evidence.");
  }
}

function revalidateCashPaths(id?: string) {
  revalidatePath("/cash-collections");
  revalidatePath("/finance");
  revalidatePath("/finance/operations");
  revalidatePath("/finance/transactions");
  if (id) revalidatePath(`/cash-collections/${id}`);
}

async function rollbackEvidence(upload: CashEvidenceUpload | null | undefined) {
  await removeCashEvidence(upload ?? null);
}

export async function createCashRemoval(formData: FormData) {
  const path = "/cash-collections/new";
  const { profile, supabase } = await requireCapability(path, canRecordCashRemoval);
  const machineIds = Array.from(new Set(formData.getAll("machine_ids").map(clean).filter(Boolean)));
  const compartments = Array.from(new Set(formData.getAll("compartments").map(clean).filter(Boolean)));
  const removalType = clean(formData.get("removal_type"));
  const bagId = clean(formData.get("cash_bag_id")).toUpperCase();
  const notes = optionalText(formData.get("notes"));
  const submissionId = clean(formData.get("client_submission_id")) || crypto.randomUUID();

  if (!machineIds.length) fail(path, "Select at least one machine.");
  if (!compartments.length) fail(path, "Select every cash compartment that was emptied.");
  if (removalType !== "full" && removalType !== "partial") fail(path, "Choose full or partial cash removal.");
  if (!bagId) fail(path, "A unique tamper-evident bag or seal ID is required.");
  if (removalType === "partial" && !notes) fail(path, "Explain what cash remained inside the machine.");

  const evidence = await requiredEvidence(formData.get("evidence_file"), path, { scopeId: submissionId, stage: "removed" });
  const { data: collectionId, error } = await supabase.rpc("record_standalone_cash_removal", {
    p_machine_ids: machineIds,
    p_removed_at: normalizeLibyaDateTime(formData.get("removed_at")),
    p_removal_type: removalType,
    p_cash_bag_id: bagId,
    p_compartments: compartments,
    p_removal_evidence_path: evidence.path,
    p_removal_evidence_file_name: evidence.fileName,
    p_notes: notes,
    p_client_submission_id: submissionId,
  });
  if (error || !collectionId) {
    await rollbackEvidence(evidence);
    console.error("[cash] Failed to record standalone cash removal", error);
    fail(path, rpcMessage(error, "Could not record cash removal. No cash amount was posted."));
  }

  await logActivity({
    profile,
    action: "record_cash_removal",
    entityType: "cash_collection",
    entityId: String(collectionId),
    entityLabel: `Cash bag ${bagId}`,
    afterData: { custody_status: "removed", cash_bag_id: bagId, collected_at: normalizeLibyaDateTime(formData.get("removed_at")) },
    metadata: { machine_ids: machineIds, removal_type: removalType, compartments, route_id: null, evidence_path: evidence.path },
    summary: `Sealed route-independent cash removal from ${machineIds.length} machine${machineIds.length === 1 ? "" : "s"}`,
  });

  revalidateCashPaths(String(collectionId));
  const selfReceiptAllowed = hasAnyRole(profileContext(profile), ["owner", "admin"]);
  redirect(`/cash-collections/${collectionId}?success=${encodeURIComponent(selfReceiptAllowed
    ? "Removal saved. As owner/admin, you may receive this bag into storage yourself; the self-receipt will be logged."
    : "Removal saved. A different authorized person must now receive the sealed bag into storage.")}`);
}

export async function receiveCashIntoStorage(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCapability(path, canReceiveCashStorage);
  const submissionId = clean(formData.get("client_submission_id")) || crypto.randomUUID();
  const location = clean(formData.get("storage_location"));
  const sealCondition = clean(formData.get("seal_condition"));
  const notes = optionalText(formData.get("notes"));
  if (!location) fail(path, "Storage or safe location is required.");
  if (!["intact", "broken", "mismatch"].includes(sealCondition)) fail(path, "Record the seal condition.");
  if (sealCondition !== "intact" && !notes) fail(path, "Explain the broken or mismatched seal.");

  const evidence = await requiredEvidence(formData.get("evidence_file"), path, { scopeId: id, stage: "stored" });
  const { error } = await supabase.rpc("receive_cash_into_storage", {
    p_collection_id: id,
    p_received_at: normalizeLibyaDateTime(formData.get("received_at")),
    p_storage_location: location,
    p_seal_condition: sealCondition,
    p_evidence_path: evidence.path,
    p_evidence_file_name: evidence.fileName,
    p_notes: notes,
    p_client_submission_id: submissionId,
  });
  if (error) {
    await rollbackEvidence(evidence);
    console.error("[cash] Failed to receive cash into storage", error);
    fail(path, rpcMessage(error, "Could not save the storage handoff."));
  }

  await logActivity({
    profile,
    action: "receive_cash_into_storage",
    entityType: "cash_collection",
    entityId: id,
    afterData: { custody_status: "in_storage", storage_location: location, seal_condition: sealCondition },
    metadata: { evidence_path: evidence.path },
    summary: "Acknowledged sealed cash bag into storage",
  });
  revalidateCashPaths(id);
  redirect(`${path}?success=${encodeURIComponent("Storage receipt saved. The bag is ready for a witnessed count.")}`);
}

function denominationCounts(formData: FormData, path: string) {
  const counts: Record<string, number> = {};
  for (const denomination of CASH_DENOMINATIONS) {
    const raw = clean(formData.get(denominationFieldName(denomination)));
    const quantity = raw ? Number(raw) : 0;
    if (!Number.isInteger(quantity) || quantity < 0) fail(path, `Quantity for ${denomination} LYD must be a whole number.`);
    counts[String(denomination)] = quantity;
  }
  return counts;
}

export async function confirmCashCollectionCount(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCapability(path, canCountCash);
  const submissionId = clean(formData.get("client_submission_id")) || crypto.randomUUID();
  const sealCondition = clean(formData.get("seal_condition"));
  const countWitnessId = clean(formData.get("count_witness_id"));
  const notes = optionalText(formData.get("notes"));
  const denominations = denominationCounts(formData, path);
  const otherRaw = clean(formData.get("other_amount_lyd"));
  const parsedOtherAmount = optionalAmount(formData.get("other_amount_lyd"));
  if (otherRaw && parsedOtherAmount === null) fail(path, "Other counted cash must be a valid amount.");
  const otherAmount = parsedOtherAmount ?? 0;
  if (otherAmount < 0) fail(path, "Other counted cash cannot be negative.");
  if (otherAmount > 0 && !notes) fail(path, "Explain the amount entered outside the standard denominations.");
  if (!["intact", "broken", "mismatch"].includes(sealCondition)) fail(path, "Record the seal condition before opening the bag.");
  if (sealCondition !== "intact" && !notes) fail(path, "Explain the broken or mismatched seal.");
  if (!countWitnessId) fail(path, "Select the second person who witnessed the cash count.");
  if (countWitnessId === profile.team_member_id) fail(path, "The person counting cash cannot also be the count witness.");

  const evidence = await requiredEvidence(formData.get("evidence_file"), path, { scopeId: id, stage: "counted" });
  const { error } = await supabase.rpc("confirm_cash_count", {
    p_collection_id: id,
    p_counted_at: normalizeLibyaDateTime(formData.get("counted_at")),
    p_seal_condition: sealCondition,
    p_count_witness_id: countWitnessId,
    p_denominations: denominations,
    p_other_amount_lyd: otherAmount,
    p_evidence_path: evidence.path,
    p_evidence_file_name: evidence.fileName,
    p_notes: notes,
    p_client_submission_id: submissionId,
  });
  if (error) {
    await rollbackEvidence(evidence);
    console.error("[cash] Failed to confirm cash count", error);
    fail(path, rpcMessage(error, "Could not save the cash count."));
  }

  await logActivity({
    profile,
    action: "confirm_cash_count",
    entityType: "cash_collection",
    entityId: id,
    afterData: { custody_status: "counted", seal_condition: sealCondition, count_witness_id: countWitnessId, denominations, other_amount_lyd: otherAmount },
    metadata: { evidence_path: evidence.path, count_witness_id: countWitnessId, related_finance: true },
    summary: "Counted stored cash by denomination with a second witness; amount is available in Snacky LYD and reconciliation is pending",
  });
  revalidateCashPaths(id);
  redirect(`${path}?success=${encodeURIComponent("Count saved and added to Snacky LYD. Compare the combined batch total against VMS next.")}`);
}

export async function calculateCashExpectation(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCapability(path, canReconcileCash);
  const { data, error } = await supabase.rpc("calculate_cash_collection_expectation", {
    p_collection_id: id,
    p_client_submission_id: clean(formData.get("client_submission_id")) || crypto.randomUUID(),
  });
  if (error) {
    console.error("[cash] Failed to calculate VMS expectation", error);
    fail(path, rpcMessage(error, "Could not calculate the VMS cash expectation."));
  }
  await logActivity({
    profile,
    action: "calculate_cash_expectation",
    entityType: "cash_collection",
    entityId: id,
    afterData: data,
    summary: "Calculated collection-interval VMS expectation for the combined cash batch",
  });
  revalidateCashPaths(id);
  const ready = Boolean((data as { ready?: boolean } | null)?.ready);
  redirect(`${path}?success=${encodeURIComponent(ready ? "Exact VMS expectation calculated. Review and reconcile the total." : "Automatic calculation is incomplete. Review the machine diagnostics and enter one verified combined VMS total.")}`);
}

export async function reconcileCashCollection(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCapability(path, canReconcileCash);
  const manualRaw = clean(formData.get("manual_expected_cash_lyd"));
  const manualExpected = optionalAmount(formData.get("manual_expected_cash_lyd"));
  const overrideReason = optionalText(formData.get("override_reason"));
  if (manualRaw && (manualExpected === null || manualExpected < 0)) fail(path, "Verified VMS total must be zero or greater.");
  if (manualExpected !== null && !overrideReason) fail(path, "State the VMS report, dates, and reason for the verified total.");

  const { error } = await supabase.rpc("reconcile_cash_collection", {
    p_collection_id: id,
    p_manual_expected_cash_lyd: manualExpected,
    p_override_reason: overrideReason,
    p_notes: optionalText(formData.get("notes")),
    p_client_submission_id: clean(formData.get("client_submission_id")) || crypto.randomUUID(),
  });
  if (error) {
    console.error("[cash] Failed to reconcile cash collection", error);
    fail(path, rpcMessage(error, "Could not reconcile the cash batch."));
  }
  await logActivity({
    profile,
    action: "reconcile_cash_collection",
    entityType: "cash_collection",
    entityId: id,
    metadata: { expectation_source: manualExpected === null ? "automatic_vms" : "manual_verified_total" },
    summary: manualExpected === null ? "Reconciled combined batch against exact VMS intervals" : "Submitted verified combined VMS total for owner review",
  });
  revalidateCashPaths(id);
  redirect(`${path}?success=${encodeURIComponent("Reconciliation saved. Counted cash is already available in Snacky LYD; any shortage or exception still requires owner review.")}`);
}

export async function resolveCashVariance(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCapability(path, canApproveCashVariance);
  const resolution = clean(formData.get("resolution"));
  const reason = clean(formData.get("reason"));
  if (!resolution || !reason) fail(path, "Resolution category and detailed evidence-based reason are required.");
  const { error } = await supabase.rpc("resolve_cash_variance", {
    p_collection_id: id,
    p_resolution: resolution,
    p_reason: reason,
    p_client_submission_id: clean(formData.get("client_submission_id")) || crypto.randomUUID(),
  });
  if (error) {
    console.error("[cash] Failed to resolve variance", error);
    fail(path, rpcMessage(error, "Could not resolve the cash variance."));
  }
  await logActivity({
    profile,
    action: "resolve_cash_variance",
    entityType: "cash_collection",
    entityId: id,
    metadata: { resolution },
    summary: "Owner/admin resolved a cash variance or custody exception",
  });
  revalidateCashPaths(id);
  redirect(`${path}?success=${encodeURIComponent("Owner resolution saved. This batch is reconciled and available in Snacky LYD.")}`);
}

export async function voidCashCollection(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const reason = requireConfirmation(formData, path);
  const { profile, supabase } = await requireCapability(path, canApproveCashVariance);
  const { error } = await supabase.rpc("void_cash_collection", {
    p_collection_id: id,
    p_reason: reason,
    p_client_submission_id: crypto.randomUUID(),
  });
  if (error) {
    console.error("[cash] Failed to void cash collection", error);
    fail(path, rpcMessage(error, "Could not void the cash batch."));
  }
  await logActivity({
    profile,
    action: "void_cash_collection",
    entityType: "cash_collection",
    entityId: id,
    metadata: { reason },
    summary: "Owner/admin voided immutable cash custody batch",
  });
  revalidateCashPaths(id);
  redirect(`${path}?success=${encodeURIComponent("Cash batch voided. The record remains in audit history.")}`);
}

export async function createMissingCashFinanceLinks() {
  const path = "/cash-collections";
  const { profile, supabase } = await requireCapability(path, canViewFinancials);
  const result = await supabase.rpc("backfill_missing_finance_transactions");
  if (result.error) {
    console.error("[cash] Failed to create missing finance links", result.error);
    fail(path, "Could not create missing finance links.");
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  const cashCreated = Number(row?.cash_collection_transactions_created ?? row?.cash_collection_finance_transactions_synced ?? 0);
  await logActivity({
    profile,
    action: "create_missing_cash_finance_links",
    entityType: "finance",
    afterData: row ?? result.data,
    summary: "Created missing cash finance links",
  });
  revalidateCashPaths();
  redirect(`${path}?success=${encodeURIComponent(`Created ${cashCreated} missing cash finance link${cashCreated === 1 ? "" : "s"}.`)}`);
}

export async function reviewCashCollection(formData: FormData) {
  return confirmCashCollectionCount(formData);
}
