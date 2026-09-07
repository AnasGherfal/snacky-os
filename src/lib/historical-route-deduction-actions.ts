"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { HISTORICAL_DEDUCTION_NOTE, parseHistoricalRouteDeductionText } from "@/lib/historical-route-deduction";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function fail(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

function contentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function requireOwnerAdmin(path: string) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = getSupabaseAdminClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

async function requireOwnerAdminAuthenticated(path: string) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

async function getDefaultStorage(supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>) {
  const { data: mainStorage, error: mainStorageError } = await supabase
    .from("storage_locations")
    .select("id, name")
    .eq("active", true)
    .eq("location_type", "main_storage")
    .order("name")
    .limit(1)
    .maybeSingle();
  if (mainStorageError) throw mainStorageError;
  if (mainStorage?.id) return mainStorage;

  const { data: storage, error } = await supabase
    .from("storage_locations")
    .select("id, name")
    .eq("active", true)
    .in("location_type", ["vehicle", "temporary", "other"])
    .order("name")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return storage ?? null;
}

export async function previewHistoricalRouteDeduction(formData: FormData) {
  const path = "/admin/historical-route-deduction";
  const { profile, supabase: adminSupabase } = await requireOwnerAdmin(path);
  const authenticatedSupabase = await getAuthenticatedSupabaseServerClient();
  if (!authenticatedSupabase) fail(path, "Supabase is not configured.");
  const originalText = clean(formData.get("original_text"));
  const notes = clean(formData.get("notes"));

  if (!originalText) fail(path, "Paste old route text before previewing.");

  const [
    { data: products, error: productsError },
    { data: machines, error: machinesError },
    { data: storageRows, error: storageError },
    defaultStorage,
  ] = await Promise.all([
    adminSupabase.from("products").select("id, name, sku, barcode").eq("active", true).order("name"),
    adminSupabase.from("machines").select("id, name, machine_code, vms_machine_id").order("name"),
    adminSupabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
    getDefaultStorage(adminSupabase),
  ]);

  const loadError = productsError ?? machinesError ?? storageError;
  if (loadError) {
    console.error("[historical-route-deduction] Failed to load preview references", loadError);
    fail(path, "Could not load products, machines, or storage balances for preview.");
  }
  if (!defaultStorage?.id) fail(path, "No active storage location found.");

  const parsed = parseHistoricalRouteDeductionText({
    text: originalText,
    products: products ?? [],
    machines: machines ?? [],
    storageBalances: storageRows ?? [],
  });

  if (!parsed.lines.length) fail(path, "No product rows were found in the pasted text.");

  const lines = parsed.lines.map((line) => ({
    line_number: line.lineNumber,
    section_name: line.sectionName,
    machine_alias: line.machineAlias,
    machine_id: line.machineId,
    product_alias: line.productAlias,
    product_id: line.productId,
    quantity: line.quantity,
    original_text: line.originalText,
    status: line.status,
    review_reason: line.reviewReasons.join(" "),
    storage_qty_before: line.storageQtyBefore,
    storage_qty_after: line.storageQtyAfter,
    storage_negative_warning: line.storageNegativeWarning,
  }));

  const clientSubmissionId = `historical-route-deduction:preview:${contentHash(JSON.stringify({
    contractVersion: 1,
    actorUserId: profile.id,
    originalText,
    notes,
  }))}`;
  const { data, error } = await authenticatedSupabase.rpc("snacky_preview_historical_route_deduction_v1", {
    p_client_submission_id: clientSubmissionId,
    p_original_text: originalText,
    p_notes: notes || null,
    p_default_storage_location_id: defaultStorage.id,
    p_lines: lines,
  });

  if (error) {
    console.error("[historical-route-deduction] Atomic preview failed", error);
    if (String(error.code ?? "") === "PGRST202" || String(error.code ?? "") === "42883") {
      fail(path, "The atomic historical preview database update is not active yet. No batch was created.");
    }
    fail(path, error.message || "Could not create historical deduction preview. No partial batch was saved.");
  }

  const result = Array.isArray(data) ? data[0] : data;
  const batchId = String(result?.batch_id ?? "");
  const rowCount = Number(result?.row_count);
  const readyRowCount = Number(result?.ready_row_count);
  const needsReviewCount = Number(result?.needs_review_count);
  const totalQuantity = Number(result?.total_quantity);
  if (
    !batchId
    || !Number.isSafeInteger(rowCount)
    || rowCount !== parsed.lines.length
    || !Number.isSafeInteger(readyRowCount)
    || readyRowCount !== parsed.readyLines.length
    || !Number.isSafeInteger(needsReviewCount)
    || needsReviewCount !== parsed.needsReviewLines.length
    || !Number.isSafeInteger(totalQuantity)
    || totalQuantity !== parsed.totalQuantity
  ) {
    console.error("[historical-route-deduction] Atomic preview returned an invalid receipt", { result });
    fail(path, "The historical deduction preview result could not be verified. Retry the same preview safely.");
  }

  await logActivity({
    profile,
    action: "preview_historical_route_deduction",
    entityType: "historical_route_deduction_batch",
    entityId: batchId,
    entityLabel: `Historical deduction ${batchId.slice(0, 8)}`,
    afterData: {
      status: "previewed",
      row_count: rowCount,
      ready_row_count: readyRowCount,
      needs_review_count: needsReviewCount,
      total_quantity: totalQuantity,
      original_text_length: originalText.length,
      default_storage_id: defaultStorage.id,
      default_storage_name: defaultStorage.name,
    },
    metadata: {
      ready_rows: readyRowCount,
      needs_review_rows: needsReviewCount,
      already_previewed: Boolean(result?.already_previewed),
    },
    summary: `Previewed historical route deduction with ${readyRowCount} ready rows and ${needsReviewCount} review rows`,
    idempotencyKey: clientSubmissionId,
  });

  revalidatePath(path);
  redirect(`${path}?batchId=${batchId}`);
}

export async function applyHistoricalRouteDeduction(formData: FormData) {
  const basePath = "/admin/historical-route-deduction";
  const batchId = clean(formData.get("batch_id"));
  const confirmAction = clean(formData.get("confirm_action"));
  if (!batchId) redirect(basePath);
  const path = `${basePath}?batchId=${batchId}`;
  if (confirmAction !== "yes") fail(path, "Confirmation is required.");

  const { profile, supabase } = await requireOwnerAdminAuthenticated(path);
  if (!profile.team_member_id) fail(path, "Your profile is not linked to a team member.");

  const { data: beforeBatch, error: beforeError } = await supabase
    .from("historical_route_deduction_batches")
    .select("id, status, row_count, ready_row_count, needs_review_count, total_quantity")
    .eq("id", batchId)
    .maybeSingle();

  if (beforeError || !beforeBatch) fail(path, "Historical deduction batch was not found.");

  const { data, error } = await supabase.rpc("apply_historical_route_deduction_batch", {
    target_batch_id: batchId,
    p_client_submission_id: `historical-route-deduction:apply:${batchId}`,
  });

  if (error) {
    console.error("[historical-route-deduction] Failed to apply batch", error);
    if (String(error.code ?? "") === "PGRST202" || String(error.code ?? "") === "42883") {
      fail(path, "The atomic historical deduction database update is not active yet. No inventory was changed.");
    }
    fail(path, error.message || "Could not apply historical route deduction batch.");
  }

  const result = Array.isArray(data) ? data[0] : data;
  const insertedMovements = Number(result?.inserted_movements ?? 0);
  const skippedReviewRows = Number(result?.skipped_review_rows ?? 0);
  if (!Number.isSafeInteger(insertedMovements) || insertedMovements <= 0 || !Number.isSafeInteger(skippedReviewRows) || skippedReviewRows < 0) {
    console.error("[historical-route-deduction] Atomic apply returned an invalid receipt", { batch_id: batchId, result });
    fail(path, "The historical deduction result could not be verified. Refresh this batch before trying again.");
  }

  await logActivity({
    profile,
    action: "apply_historical_route_deduction",
    entityType: "historical_route_deduction_batch",
    entityId: batchId,
    entityLabel: `Historical deduction ${batchId.slice(0, 8)}`,
    beforeData: beforeBatch,
    afterData: {
      status: "applied",
      inserted_movements: insertedMovements,
      skipped_review_rows: skippedReviewRows,
      already_applied: Boolean(result?.already_applied),
      note: HISTORICAL_DEDUCTION_NOTE,
    },
    metadata: {
      movement_reason: "historical_route_deduction",
      affects_finance: false,
      affects_purchases: false,
      creates_sales: false,
    },
    summary: `Applied historical route deduction batch with ${insertedMovements} ledger movements`,
    idempotencyKey: `historical-route-deduction-apply:${batchId}`,
  });

  revalidatePath(basePath);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  redirect(`${path}&applied=${insertedMovements}`);
}

export async function cancelHistoricalRouteDeduction(formData: FormData) {
  const basePath = "/admin/historical-route-deduction";
  const batchId = clean(formData.get("batch_id"));
  const confirmAction = clean(formData.get("confirm_action"));
  if (!batchId) redirect(basePath);
  const path = `${basePath}?batchId=${batchId}`;
  if (confirmAction !== "yes") fail(path, "Confirmation is required.");

  const { profile, supabase } = await requireOwnerAdmin(path);

  const { data: beforeBatch, error: beforeError } = await supabase
    .from("historical_route_deduction_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();

  if (beforeError || !beforeBatch) fail(path, "Historical deduction batch was not found.");
  if (beforeBatch.status === "applied") fail(path, "Applied batches cannot be cancelled.");

  const { data: afterBatch, error } = await supabase
    .from("historical_route_deduction_batches")
    .update({
      status: "cancelled",
      cancelled_by: profile.team_member_id,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId)
    .neq("status", "applied")
    .select("*")
    .single();

  if (error) {
    console.error("[historical-route-deduction] Failed to cancel batch", error);
    fail(path, "Could not cancel historical deduction batch.");
  }

  await logActivity({
    profile,
    action: "cancel_historical_route_deduction",
    entityType: "historical_route_deduction_batch",
    entityId: batchId,
    entityLabel: `Historical deduction ${batchId.slice(0, 8)}`,
    beforeData: beforeBatch,
    afterData: afterBatch,
    summary: `Cancelled historical route deduction batch ${batchId.slice(0, 8)}`,
  });

  revalidatePath(basePath);
  redirect(`${path}&cancelled=1`);
}
