"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function errorMessage(error: unknown, fallback = "Action failed.") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? row.code ?? fallback);
  }
  return fallback;
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
}

function isMissingColumnError(error: unknown, columns: string[]) {
  const text = errorText(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

function isMissingOnConflictConstraint(error: unknown) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return (
    code === "42P10"
    || text.includes("there is no unique or exclusion constraint matching the on conflict specification")
    || text.includes("missing unique constraint")
  );
}

function quantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function routeAdminPaths(routeId?: string | null) {
  revalidatePath("/admin/tools");
  revalidatePath("/routes");
  revalidatePath("/operator/routes");
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  if (routeId) {
    revalidatePath(`/routes/${routeId}`);
    revalidatePath(`/operator/routes/${routeId}`);
    revalidatePath(`/operator/routes/${routeId}/leftovers`);
    revalidatePath(`/operator/routes/${routeId}/pick-list`);
  }
}

function dashboardPaths() {
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/sales");
  revalidatePath("/products-dashboard");
  revalidatePath("/machines-dashboard");
  revalidatePath("/inventory-dashboard");
  revalidatePath("/refills");
  revalidatePath("/routes/new");
}

function safeReturnTo(value: FormDataEntryValue | string | null | undefined) {
  const path = String(value ?? "").trim();
  return path.startsWith("/admin") ? path : "/admin/tools";
}

function redirectTools(params: { success?: string; error?: string }, returnTo = "/admin/tools") {
  const search = new URLSearchParams();
  if (params.success) search.set("success", params.success);
  if (params.error) search.set("error", params.error);
  redirect(`${returnTo}${search.size ? `?${search.toString()}` : ""}`);
}

function backfillRow(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  const result = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const purchaseTransactionsSkippedExisting = Number(result.purchase_transactions_skipped_existing ?? 0);
  const cashCollectionTransactionsSkippedExisting = Number(result.cash_collection_transactions_skipped_existing ?? 0);
  const skippedExisting = Number(result.skipped_existing ?? result.transactions_skipped ?? purchaseTransactionsSkippedExisting + cashCollectionTransactionsSkippedExisting);
  return {
    purchasesChecked: Number(result.purchases_checked ?? 0),
    purchaseTransactionsCreated: Number(result.purchase_transactions_created ?? result.transactions_created ?? 0),
    purchaseTransactionsSkippedExisting,
    cashCollectionsChecked: Number(result.cash_collections_checked ?? 0),
    cashCollectionTransactionsCreated: Number(result.cash_collection_transactions_created ?? 0),
    cashCollectionTransactionsSkippedExisting,
    skippedExisting,
    errors,
  };
}

function formatBackfillSummary(label: string, row: ReturnType<typeof backfillRow>) {
  return `${label}: purchases checked ${row.purchasesChecked}, purchase transactions created ${row.purchaseTransactionsCreated}, purchase transactions skipped existing ${row.purchaseTransactionsSkippedExisting}, cash collections checked ${row.cashCollectionsChecked}, cash collection transactions created ${row.cashCollectionTransactionsCreated}, cash collection transactions skipped existing ${row.cashCollectionTransactionsSkippedExisting}, skipped existing total ${row.skippedExisting}, errors ${row.errors.length}`;
}

function refillRecommendationRefreshRow(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  const result = row && typeof row === "object" ? row as Record<string, unknown> : {};
  return {
    refreshedAt: String(result.refreshed_at ?? ""),
    latestImportBatchId: String(result.latest_import_batch_id ?? ""),
    latestFileName: String(result.latest_file_name ?? ""),
    latestReportType: String(result.latest_report_type ?? ""),
    latestStatus: String(result.latest_status ?? ""),
    snapshotRows: Number(result.snapshot_rows ?? 0),
    mappedProductRows: Number(result.mapped_product_rows ?? 0),
    mappedMachineRows: Number(result.mapped_machine_rows ?? 0),
    recommendationRows: Number(result.recommendation_rows ?? 0),
    zeroStorageRecommendationRows: Number(result.zero_storage_recommendation_rows ?? 0),
    warning: String(result.warning ?? ""),
  };
}

function formatRefillRecommendationRefreshSummary(row: ReturnType<typeof refillRecommendationRefreshRow>) {
  return `Latest import ${row.latestFileName || row.latestImportBatchId || "unknown"}: snapshot rows ${row.snapshotRows}, mapped products ${row.mappedProductRows}, mapped machines ${row.mappedMachineRows}, recommendation rows ${row.recommendationRows}, zero-storage recommendation rows ${row.zeroStorageRecommendationRows}`;
}

async function requireAdmin(path = "/admin/tools") {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect(`${path}?error=Supabase%20is%20not%20configured.`);
  return { profile, supabase };
}

function requireReason(formData: FormData, returnTo = "/admin/tools") {
  const reason = clean(formData.get("reason"));
  if (!reason) redirectTools({ error: "Reason is required for admin recovery actions." }, returnTo);
  return reason;
}

function requireRouteId(formData: FormData, returnTo = "/admin/tools") {
  const routeId = clean(formData.get("route_id"));
  if (!routeId) redirectTools({ error: "Route is required." }, returnTo);
  return routeId;
}

async function recalculateRouteInventoryLedgerRows({
  supabase,
  routeId,
}: {
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
  routeId: string;
}) {
  const [
    { data: route, error: routeError },
    { data: routeMovements, error: movementError },
    { data: stockLines, error: stockLineError },
    { data: stopItems, error: stopItemError },
  ] = await Promise.all([
    supabase.from("routes").select("id, status, operator_id").eq("id", routeId).maybeSingle(),
    supabase
      .from("inventory_movements")
      .select("product_id, quantity, reason, from_entity_type, to_entity_type")
      .eq("related_route_id", routeId)
      .limit(5000),
    supabase.from("route_stock_lines").select("id, product_id, planned_qty, picked_qty, returned_qty").eq("route_id", routeId),
    supabase.from("route_stop_items").select("product_id, planned_quantity").eq("route_id", routeId),
  ]);

  if (routeError) throw routeError;
  if (!route?.id) throw new Error("Route not found.");
  if (movementError) throw movementError;
  if (stockLineError) throw stockLineError;
  if (stopItemError && !errorText(stopItemError).includes("route_stop_items")) throw stopItemError;

  const plannedByProduct = new Map<string, number>();
  (stopItems ?? []).forEach((item: any) => {
    const productId = String(item.product_id ?? "");
    if (!productId) return;
    plannedByProduct.set(productId, (plannedByProduct.get(productId) ?? 0) + quantity(item.planned_quantity));
  });

  (stockLines ?? []).forEach((line: any) => {
    const productId = String(line.product_id ?? "");
    if (!productId) return;
    plannedByProduct.set(productId, Math.max(plannedByProduct.get(productId) ?? 0, quantity(line.planned_qty)));
  });

  const pickedByProduct = new Map<string, number>();
  const returnedByProduct = new Map<string, number>();
  (routeMovements ?? []).forEach((movement: any) => {
    const productId = String(movement.product_id ?? "");
    const qty = quantity(movement.quantity);
    if (!productId || qty <= 0) return;
    if (movement.reason === "storage_to_operator_bag" || (movement.from_entity_type === "storage" && movement.to_entity_type === "operator_bag")) {
      pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + qty);
    }
    if (movement.reason === "operator_bag_to_storage" || (movement.from_entity_type === "operator_bag" && movement.to_entity_type === "storage")) {
      returnedByProduct.set(productId, (returnedByProduct.get(productId) ?? 0) + qty);
    }
  });

  const productIds = Array.from(new Set([
    ...plannedByProduct.keys(),
    ...pickedByProduct.keys(),
    ...returnedByProduct.keys(),
  ]));

  const now = new Date().toISOString();
  const rows = productIds.map((productId) => ({
    route_id: routeId,
    product_id: productId,
    planned_qty: Math.max(plannedByProduct.get(productId) ?? 0, pickedByProduct.get(productId) ?? 0),
    picked_qty: pickedByProduct.get(productId) ?? 0,
    returned_qty: returnedByProduct.get(productId) ?? 0,
    updated_at: now,
  }));

  if (rows.length) {
    const upsertResult = await supabase.from("route_stock_lines").upsert(rows, { onConflict: "route_id,product_id" });
    if (upsertResult.error) {
      if (!isMissingOnConflictConstraint(upsertResult.error)) throw upsertResult.error;

      console.warn("[admin-tools] route_stock_lines upsert missing unique conflict target; replacing route stock lines instead", {
        routeId,
        onConflict: "route_id,product_id",
        error: upsertResult.error,
      });

      const deleteResult = await supabase.from("route_stock_lines").delete().eq("route_id", routeId);
      if (deleteResult.error) throw deleteResult.error;

      const insertResult = await supabase.from("route_stock_lines").insert(rows);
      if (insertResult.error) throw insertResult.error;
    }
  }

  return { route, rows, movementCount: routeMovements?.length ?? 0 };
}

export async function recalculateRouteInventoryLedger(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const routeId = requireRouteId(formData, returnTo);
  const reason = requireReason(formData, returnTo);
  const { profile, supabase } = await requireAdmin(returnTo);

  try {
    const result = await recalculateRouteInventoryLedgerRows({ supabase, routeId });
    await logActivity({
      profile,
      action: "recalculate_route_inventory_ledger",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      afterData: { stock_lines: result.rows, movement_count: result.movementCount },
      metadata: { reason },
      summary: `Recalculated ${result.rows.length} route stock line(s) from inventory movements`,
    });
    routeAdminPaths(routeId);
    redirectTools({ success: `Route ledger recalculated from ${result.movementCount} inventory movement(s).` }, returnTo);
  } catch (error) {
    console.error("[admin-tools] Route ledger recalculation failed", { routeId, error });
    redirectTools({ error: "Could not save route changes. Please try again." }, returnTo);
  }
}

export async function repairStuckRoute(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const routeId = requireRouteId(formData, returnTo);
  const reason = requireReason(formData, returnTo);
  const { profile, supabase } = await requireAdmin(returnTo);

  try {
    const result = await recalculateRouteInventoryLedgerRows({ supabase, routeId });
    const { error: updateError } = await supabase
      .from("routes")
      .update({ last_completion_error: null, repaired_at: new Date().toISOString(), repaired_by: profile.team_member_id })
      .eq("id", routeId);
    if (updateError && !isMissingColumnError(updateError, ["last_completion_error", "repaired_at", "repaired_by"])) throw updateError;

    await logActivity({
      profile,
      action: "repair_stuck_route",
      entityType: "route",
      entityId: routeId,
      entityLabel: `Route ${routeId.slice(0, 8)}`,
      afterData: { stock_lines: result.rows, status: result.route.status },
      metadata: { reason },
      summary: "Repaired route ledger metadata and cleared completion error",
    });
    routeAdminPaths(routeId);
    redirectTools({ success: "Route repair completed. The operator can retry the route workflow." }, returnTo);
  } catch (error) {
    console.error("[admin-tools] Route repair failed", { routeId, error });
    redirectTools({ error: "Could not save route changes. Please try again." }, returnTo);
  }
}

export async function forceCompleteRouteWithAudit(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const routeId = requireRouteId(formData, returnTo);
  await requireAdmin(returnTo);

  // Completion always requires a person to enter and confirm the physical bag
  // count. A zero ledger is not proof that the physical bag is empty.
  redirect(`/operator/routes/${routeId}/leftovers?mode=complete`);
}

export async function recalculateStorageBalances(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const reason = requireReason(formData, returnTo);
  const { profile, supabase } = await requireAdmin(returnTo);

  try {
    const [{ count, error }, { count: negativeCount, error: negativeError }] = await Promise.all([
      supabase.from("current_inventory_by_location").select("product_id", { count: "exact", head: true }),
      supabase.from("current_inventory_by_location").select("product_id", { count: "exact", head: true }).lt("quantity_on_hand", 0),
    ]);
    if (error) throw error;
    if (negativeError) throw negativeError;

    routeAdminPaths();
    dashboardPaths();
    await logActivity({
      profile,
      action: "recalculate_storage_balances",
      entityType: "inventory",
      afterData: { balance_rows: count ?? 0, negative_balance_rows: negativeCount ?? 0 },
      metadata: { reason },
      summary: "Checked ledger-derived storage balances and refreshed inventory dashboards",
    });
    redirectTools({ success: `Storage balances refreshed from the ledger. ${count ?? 0} balance row(s), ${negativeCount ?? 0} negative row(s).` }, returnTo);
  } catch (error) {
    console.error("[admin-tools] Storage balance recalculation failed", { error });
    redirectTools({ error: `Storage balance check failed: ${errorMessage(error)}` }, returnTo);
  }
}

export async function backfillMissingFinanceTransactions(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const reason = clean(formData.get("reason")) || "Backfill missing source-generated finance transactions.";
  const { profile, supabase } = await requireAdmin(returnTo);

  try {
    const result = await supabase.rpc("backfill_missing_finance_transactions");
    if (result.error) throw result.error;

    const backfill = backfillRow(result.data);

    await logActivity({
      profile,
      action: "backfill_missing_finance_transactions",
      entityType: "finance",
      entityLabel: "Finance source transaction backfill",
      afterData: { ...backfill, reason },
      summary: "Backfilled missing purchase and cash collection finance transactions",
    });

    revalidatePath("/admin/tools");
    revalidatePath("/finance");
    revalidatePath("/finance/transactions");
    revalidatePath("/purchases");
    revalidatePath("/cash-collections");
    redirectTools({
      success: `Finance transaction backfill complete. ${formatBackfillSummary("All current data", backfill)}.`,
    }, returnTo);
  } catch (error) {
    console.error("[admin-tools] Finance transaction backfill failed", { error });
    redirectTools({ error: `Finance transaction backfill failed: ${errorMessage(error)}. Confirm the latest finance migration has been applied.` }, returnTo);
  }
}

export const backfillMissingPurchaseTransactions = backfillMissingFinanceTransactions;

export async function rebuildRefillRecommendations(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const reason = requireReason(formData, returnTo);
  const { profile, supabase } = await requireAdmin(returnTo);

  try {
    const result = await supabase.rpc("refresh_refill_recommendations_from_latest_stock_snapshot");
    if (result.error) throw result.error;

    const refresh = refillRecommendationRefreshRow(result.data);

    revalidatePath("/admin/tools");
    revalidatePath("/vms-import");
    dashboardPaths();
    await logActivity({
      profile,
      action: "rebuild_refill_recommendations",
      entityType: "refill_recommendation",
      entityLabel: refresh.latestFileName || refresh.latestImportBatchId || "Latest VMS stock snapshot",
      afterData: { ...refresh, reason },
      summary: "Rebuilt refill recommendation diagnostics from the latest active stock snapshot",
    });

    const warningSuffix = refresh.warning ? ` Warning: ${refresh.warning}` : "";
    redirectTools({
      success: `Refill recommendations refreshed. ${formatRefillRecommendationRefreshSummary(refresh)}.${warningSuffix}`,
    }, returnTo);
  } catch (error) {
    console.error("[admin-tools] Refill recommendation rebuild failed", { error });
    redirectTools({ error: `Refill recommendation rebuild failed: ${errorMessage(error)}. Confirm the latest VMS migration has been applied.` }, returnTo);
  }
}

export async function recalculateDashboards(formData: FormData) {
  const returnTo = safeReturnTo(formData.get("return_to"));
  const reason = requireReason(formData, returnTo);
  const { profile } = await requireAdmin(returnTo);
  dashboardPaths();
  await logActivity({
    profile,
    action: "recalculate_dashboards",
    entityType: "dashboard",
    metadata: { reason },
    summary: "Refreshed dashboard paths and KPI source pages",
  });
  redirectTools({ success: "Dashboard paths refreshed." }, returnTo);
}
