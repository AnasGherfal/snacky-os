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
  isOperatorRole,
  type AuthUserContext,
} from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";
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

function failCashRemoval(path: string, message: string, submissionId: string): never {
  const params = new URLSearchParams({ error: message, submission_id: submissionId });
  redirect(`${path}?${params.toString()}`);
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

const cashRemovedAmountPattern = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;
const cashBoxKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

type CashRemovalPlan = {
  boxes: Array<{
    box_key: string;
    cash_bag_id: string;
    machines: Array<{ machine_id: string; removed_amount_lyd: string }>;
  }>;
};

function parseCashRemovalPlan(formData: FormData, path: string, submissionId: string): CashRemovalPlan {
  const raw = clean(formData.get("cash_removal_plan"));
  if (!raw) failCashRemoval(path, "Select at least one machine and enter its removed cash amount.", submissionId);

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    failCashRemoval(path, "The machine and cash-box selection is invalid. Reload and try again.", submissionId);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) failCashRemoval(path, "The cash removal plan is invalid.", submissionId);
  const boxes = (value as { boxes?: unknown }).boxes;
  if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > 12) failCashRemoval(path, "Use between 1 and 12 physical cash boxes.", submissionId);

  const normalized: CashRemovalPlan["boxes"] = [];
  const seenMachines = new Set<string>();
  const seenBoxes = new Set<string>();
  const seenBags = new Set<string>();

  for (const input of boxes) {
    if (!input || typeof input !== "object" || Array.isArray(input)) failCashRemoval(path, "Each cash box must be complete.", submissionId);
    const box = input as { box_key?: unknown; cash_bag_id?: unknown; machines?: unknown };
    const boxKey = String(box.box_key ?? "").trim();
    const bagId = String(box.cash_bag_id ?? "").trim().toUpperCase();
    if (!cashBoxKeyPattern.test(boxKey) || seenBoxes.has(boxKey)) failCashRemoval(path, "Each physical cash box must have a unique box reference.", submissionId);
    if (!bagId || bagId.length > 120 || seenBags.has(bagId.toLowerCase())) failCashRemoval(path, "Each physical cash box needs a different seal ID.", submissionId);
    if (!Array.isArray(box.machines) || box.machines.length < 1) failCashRemoval(path, "Every cash box must contain at least one selected machine.", submissionId);

    const machines: CashRemovalPlan["boxes"][number]["machines"] = [];
    for (const inputMachine of box.machines) {
      if (!inputMachine || typeof inputMachine !== "object" || Array.isArray(inputMachine)) failCashRemoval(path, "Review the selected machine amounts.", submissionId);
      const machine = inputMachine as { machine_id?: unknown; removed_amount_lyd?: unknown };
      const machineId = String(machine.machine_id ?? "").trim();
      const amount = String(machine.removed_amount_lyd ?? "").trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(machineId)) failCashRemoval(path, "One selected machine is invalid.", submissionId);
      if (!cashRemovedAmountPattern.test(amount)) failCashRemoval(path, "Enter a valid LYD amount for every selected machine.", submissionId);
      if (seenMachines.has(machineId)) failCashRemoval(path, "A machine can belong to only one physical cash box in one removal.", submissionId);
      seenMachines.add(machineId);
      machines.push({ machine_id: machineId, removed_amount_lyd: Number(amount).toFixed(2) });
    }

    seenBoxes.add(boxKey);
    seenBags.add(bagId.toLowerCase());
    normalized.push({ box_key: boxKey, cash_bag_id: bagId, machines });
  }

  if (seenMachines.size > 100) failCashRemoval(path, "Too many machines in one cash removal.", submissionId);
  return { boxes: normalized };
}

export async function createCashRemoval(formData: FormData) {
  const legacyPath = "/cash-collections/new";
  const { profile, supabase } = await requireCapability(legacyPath, canRecordCashRemoval);
  const path = isOperatorRole(profileContext(profile)) ? "/cash-handling" : legacyPath;
  const submissionId = clean(formData.get("client_submission_id")) || crypto.randomUUID();
  const plan = parseCashRemovalPlan(formData, path, submissionId);
  const compartments = Array.from(new Set(formData.getAll("compartments").map(clean).filter(Boolean)));
  const removalType = clean(formData.get("removal_type"));
  const notes = optionalText(formData.get("notes"));
  const removedAt = normalizeLibyaDateTime(formData.get("removed_at"));

  if (!compartments.length) failCashRemoval(path, "Select every cash compartment that was emptied.", submissionId);
  if (removalType !== "full" && removalType !== "partial") failCashRemoval(path, "Choose full or partial cash removal.", submissionId);
  if (removalType === "partial" && !notes) failCashRemoval(path, "Explain what cash remained inside the machine.", submissionId);

  const uploads: CashEvidenceUpload[] = [];
  const boxesWithEvidence: Array<CashRemovalPlan["boxes"][number] & {
    removal_evidence_path: string;
    removal_evidence_file_name: string;
  }> = [];

  try {
    for (const box of plan.boxes) {
      const upload = await uploadCashEvidence(formData.get(`box_evidence_${box.box_key}`), {
        scopeId: `${submissionId}-${box.box_key}`,
        stage: "removed",
        required: true,
      });
      if (!upload) throw new Error(`A sealed-box photo is required for ${box.cash_bag_id}.`);
      uploads.push(upload);
      boxesWithEvidence.push({
        ...box,
        removal_evidence_path: upload.path,
        removal_evidence_file_name: upload.fileName,
      });
    }
  } catch (error) {
    await Promise.all(uploads.map((upload) => rollbackEvidence(upload)));
    console.error("[cash] Failed to upload grouped cash evidence", error);
    failCashRemoval(
      path,
      error instanceof Error ? error.message : "Could not prepare cash removal evidence.",
      submissionId,
    );
  }

  const rpcArgs = {
    p_boxes: boxesWithEvidence,
    p_removed_at: removedAt,
    p_removal_type: removalType,
    p_compartments: compartments,
    p_notes: notes,
    p_client_submission_id: submissionId,
  };

  type GroupedCashResult = {
    replayed?: boolean;
    collection_ids?: string[];
    boxes?: Array<{
      box_key?: string;
      collection_id?: string;
      cash_bag_id?: string;
      machine_count?: number;
      declared_total_lyd?: string;
    }>;
  };

  let result: GroupedCashResult | null = null;
  let rpcError: { code?: string | null; message?: string | null; details?: string | null } | null = null;
  let transportUncertain = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await supabase.rpc("record_standalone_cash_removal_group_v1", rpcArgs);
      result = response.data as GroupedCashResult | null;
      rpcError = response.error;

      if (!rpcError) break;

      const detail = `${rpcError.message ?? ""} ${rpcError.details ?? ""}`;
      transportUncertain = !rpcError.code && /fetch failed|network|socket|connection|closed/i.test(detail);
      if (!transportUncertain) break;
    } catch (error) {
      transportUncertain = true;
      rpcError = { message: error instanceof Error ? error.message : String(error) };
    }

    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 180));
  }

  const collectionIds = Array.isArray(result?.collection_ids)
    ? result.collection_ids.map(String).filter(Boolean)
    : [];
  const responseUncertain = !rpcError && (!result || collectionIds.length !== plan.boxes.length);

  if (rpcError || responseUncertain) {
    if (!transportUncertain && !responseUncertain) {
      await Promise.all(uploads.map((upload) => rollbackEvidence(upload)));
    }

    console.error("[cash] Failed to confirm grouped cash removal", rpcError ?? { responseUncertain: true });
    failCashRemoval(
      path,
      transportUncertain || responseUncertain
        ? "Save not confirmed. Do not create a second removal. Reattach the same box photos and retry this saved removal."
        : rpcMessage(rpcError, "Could not record the machine cash amounts and physical boxes."),
      submissionId,
    );
  }

  if (result?.replayed) {
    // The original committed boxes retain their original evidence paths.
    // New evidence uploaded only for this replay is not referenced and is safe to remove.
    await Promise.all(uploads.map((upload) => rollbackEvidence(upload)));
  }

  const machineCount = plan.boxes.reduce((sum, box) => sum + box.machines.length, 0);
  const declaredTotal = plan.boxes.reduce(
    (sum, box) => sum + box.machines.reduce((boxSum, machine) => boxSum + Number(machine.removed_amount_lyd), 0),
    0,
  );

  try {
    await logActivity({
      profile,
      action: "record_cash_removal",
      entityType: "cash_removal_group",
      entityId: submissionId,
      entityLabel: `${plan.boxes.length} cash box${plan.boxes.length === 1 ? "" : "es"}`,
      afterData: {
        custody_status: "removed",
        collection_ids: collectionIds,
        box_count: plan.boxes.length,
        machine_count: machineCount,
        declared_total_lyd: Number(declaredTotal.toFixed(2)),
        collected_at: removedAt,
      },
      metadata: {
        boxes: result?.boxes ?? null,
        removal_type: removalType,
        compartments,
        route_id: null,
        replayed: Boolean(result?.replayed),
      },
      summary: `Recorded ${machineCount} machine cash amount${machineCount === 1 ? "" : "s"} into ${plan.boxes.length} physical box${plan.boxes.length === 1 ? "" : "es"}`,
    });
  } catch (error) {
    // Primary cash custody is already committed. A secondary activity-log
    // failure must never delete evidence or turn a committed removal into a false failure.
    console.error("[cash] Cash removal committed but activity logging failed", error);
  }

  for (const id of collectionIds) revalidateCashPaths(id);

  const selfReceiptAllowed = hasAnyRole(profileContext(profile), ["owner", "admin"]);
  const successMessage = `Removal saved: ${machineCount} machine${machineCount === 1 ? "" : "s"} in ${plan.boxes.length} cash box${plan.boxes.length === 1 ? "" : "es"}. Each machine amount is recorded separately.${
    selfReceiptAllowed
      ? " Owner/admin may continue the custody process from Cash."
      : " Continue the handover from Cash."
  }`;

  const target = isOperatorRole(profileContext(profile))
    ? collectionIds.length === 1
      ? `/cash-handling?id=${collectionIds[0]}&success=${encodeURIComponent(successMessage)}`
      : `/cash-handling?success=${encodeURIComponent(successMessage)}`
    : collectionIds.length === 1
      ? `/cash-collections/${collectionIds[0]}?success=${encodeURIComponent(successMessage)}`
      : `/cash-collections?success=${encodeURIComponent(successMessage)}`;

  redirect(target);
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
  redirect(`${path}?success=${encodeURIComponent("Storage receipt saved. The bag is ready to count.")}`);
}

export async function confirmCashCollectionCount(formData: FormData) {
  const id = clean(formData.get("id"));
  if (!id) redirect("/cash-collections");
  const path = `/cash-collections/${id}`;
  const { profile, supabase } = await requireCapability(path, canCountCash);
  const submissionId = clean(formData.get("client_submission_id")) || crypto.randomUUID();
  const useRecordedMachineTotal = clean(formData.get("use_recorded_machine_total")) === "yes";
  let totalAmount: number | null = null;

  if (useRecordedMachineTotal) {
    const { data: machineAmounts, error: machineAmountError } = await supabase
      .from("cash_collection_machines")
      .select("machine_id, removed_amount_lyd")
      .eq("cash_collection_id", id);

    if (machineAmountError) {
      console.error("[cash] Failed to load recorded machine amounts", machineAmountError);
      fail(path, "Could not verify the machine cash amounts.");
    }

    const rows = machineAmounts ?? [];
    if (!rows.length || rows.some((row) => row.removed_amount_lyd === null || row.removed_amount_lyd === undefined || !Number.isFinite(Number(row.removed_amount_lyd)) || Number(row.removed_amount_lyd) < 0)) {
      fail(path, "One or more machine amounts are missing. Review this cash collection before confirming it.");
    }

    totalAmount = Math.round(rows.reduce((sum, row) => sum + Number(row.removed_amount_lyd), 0) * 100) / 100;
  } else {
    const totalRaw = clean(formData.get("total_amount_lyd"));
    totalAmount = optionalAmount(formData.get("total_amount_lyd"));
    if (!totalRaw || totalAmount === null || totalAmount < 0) fail(path, "Enter a valid total cash amount.");
  }

  const { data: automaticPeriod, error } = await supabase.rpc("confirm_cash_count_auto_period_v1", {
    p_collection_id: id,
    p_total_amount_lyd: totalAmount,
    p_client_submission_id: submissionId,
  });
  if (error) {
    console.error("[cash] Failed to confirm cash count", error);
    fail(path, rpcMessage(error, "Could not save the cash count."));
  }

  await logActivity({
    profile,
    action: "confirm_cash_count",
    entityType: "cash_collection",
    entityId: id,
    afterData: { custody_status: "counted", total_amount_lyd: totalAmount, automatic_period: automaticPeriod ?? null },
    metadata: { related_finance: true, period_source: "previous_full_cash_removal", amount_source: useRecordedMachineTotal ? "recorded_machine_amounts" : "manual_legacy_total" },
    summary: useRecordedMachineTotal ? "Confirmed stored cash from the per-machine amounts recorded at removal" : "Saved one combined stored-cash total; VMS reconciliation remains available for later",
  });
  revalidateCashPaths(id);
  redirect(`${path}?success=${encodeURIComponent("Cash total saved and added to Snacky LYD. You can compare it with VMS later.")}`);
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
