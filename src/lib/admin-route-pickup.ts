import { createHash } from "node:crypto";

export type AdminMissedPickupItemInput = {
  productId: string;
  productName?: string | null;
  quantity: number;
};

export type ExistingRoutePickListRow = {
  id: string;
  route_stop_id?: string | null;
  route_stop_item_id?: string | null;
  machine_id?: string | null;
  product_id: string;
  planned_qty?: number | null;
  picked_qty?: number | null;
  action_type?: string | null;
  pickup_batch_id?: string | null;
  reason?: string | null;
  notes?: string | null;
  needs_review?: boolean | null;
  created_by?: string | null;
  is_active?: boolean | null;
};

export type RouteStopItemForPickup = {
  id: string;
  planned_quantity?: number | null;
};

export type RouteStockLineForPickup = {
  product_id: string;
  planned_qty?: number | null;
  picked_qty?: number | null;
};

type BuildAdminMissedPickupPayloadInput = {
  route: {
    id: string;
    operatorId: string;
    status: string;
    startedAt?: string | null;
  };
  storageLocationId: string;
  items: AdminMissedPickupItemInput[];
  existingPickListRows: ExistingRoutePickListRow[];
  routeStopItems: RouteStopItemForPickup[];
  routeStockLines: RouteStockLineForPickup[];
  actorTeamMemberId: string;
  submissionId: string;
  reason: string;
  recordedAt: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function isUuid(value: unknown) {
  return UUID_PATTERN.test(String(value ?? "").trim());
}

export function stableRoutePickupUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function normalizeAdminMissedPickupItems(items: AdminMissedPickupItemInput[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Add at least one product that physically left storage.");
  }
  if (items.length > 50) {
    throw new Error("Record no more than 50 products in one correction.");
  }

  const combined = new Map<string, { productId: string; productName: string | null; quantity: number }>();
  items.forEach((item) => {
    const productId = String(item?.productId ?? "").trim();
    const quantity = unitQuantity(item?.quantity);
    if (!isUuid(productId)) throw new Error("A selected product is invalid. Remove it and add it again.");
    if (quantity <= 0) throw new Error("Every recorded product must have a quantity greater than zero.");
    if (quantity > 10000) throw new Error("A recorded quantity is too large. Check the unit count and try again.");

    const current = combined.get(productId);
    combined.set(productId, {
      productId,
      productName: String(item?.productName ?? current?.productName ?? "").trim() || null,
      quantity: (current?.quantity ?? 0) + quantity,
    });
  });

  return Array.from(combined.values()).sort((a, b) => (
    String(a.productName ?? "").localeCompare(String(b.productName ?? ""))
      || a.productId.localeCompare(b.productId)
  ));
}

export function buildAdminMissedPickupRpcPayload(input: BuildAdminMissedPickupPayloadInput) {
  const routeId = String(input.route.id ?? "").trim();
  const operatorId = String(input.route.operatorId ?? "").trim();
  const actorTeamMemberId = String(input.actorTeamMemberId ?? "").trim();
  const storageLocationId = String(input.storageLocationId ?? "").trim();
  const submissionId = String(input.submissionId ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const recordedAt = String(input.recordedAt ?? "").trim();

  if (![routeId, operatorId, actorTeamMemberId, storageLocationId, submissionId].every(isUuid)) {
    throw new Error("The route, operator, storage location, or correction id is invalid.");
  }
  if (!reason) throw new Error("Enter why this pickup was not recorded by the operator.");
  if (reason.length > 500) throw new Error("Keep the correction reason under 500 characters.");
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) throw new Error("The correction time is invalid.");

  const items = normalizeAdminMissedPickupItems(input.items);
  const activePickRows = (input.existingPickListRows ?? []).filter((row) => row.is_active !== false);
  const requiredPlannedQtyByStopItemId = new Map(
    (input.routeStopItems ?? [])
      .map((item) => [String(item.id ?? "").trim(), unitQuantity(item.planned_quantity)] as const)
      .filter(([id, plannedQuantity]) => isUuid(id) && plannedQuantity > 0),
  );
  const requiredStopItemIds = Array.from(requiredPlannedQtyByStopItemId.keys());
  const activeRowByStopItemId = new Map<string, ExistingRoutePickListRow>();
  activePickRows.forEach((row) => {
    const stopItemId = String(row.route_stop_item_id ?? "").trim();
    if (stopItemId && !activeRowByStopItemId.has(stopItemId)) activeRowByStopItemId.set(stopItemId, row);
  });

  const missingRequiredRows = requiredStopItemIds.filter((id) => !activeRowByStopItemId.has(id));
  if (missingRequiredRows.length) {
    throw new Error("The existing confirmed pick list is incomplete. Repair the route pickup before recording a correction.");
  }

  const pickupBatchId = stableRoutePickupUuid(`admin-missed-route-pickup-batch:${submissionId}`);
  const existingChecklistRows = requiredStopItemIds.map((stopItemId) => {
    const row = activeRowByStopItemId.get(stopItemId)!;
    return {
      id: row.id,
      route_stop_id: row.route_stop_id ?? null,
      route_stop_item_id: row.route_stop_item_id ?? null,
      machine_id: row.machine_id ?? null,
      product_id: row.product_id,
      planned_qty: Math.max(unitQuantity(row.planned_qty), requiredPlannedQtyByStopItemId.get(stopItemId) ?? 0),
      picked_qty: unitQuantity(row.picked_qty),
      action_type: row.action_type ?? "planned_pick",
      pickup_batch_id: row.pickup_batch_id ?? null,
      reason: row.reason ?? null,
      notes: row.notes ?? null,
      needs_review: Boolean(row.needs_review),
      created_by: row.created_by ?? operatorId,
      is_checked: true,
    };
  });

  const correctionPickListRows = items.map((item) => ({
    id: stableRoutePickupUuid(`admin-missed-route-pickup-row:${submissionId}:${item.productId}`),
    route_stop_id: null,
    route_stop_item_id: null,
    machine_id: null,
    product_id: item.productId,
    planned_qty: 0,
    picked_qty: item.quantity,
    action_type: "extra_product",
    pickup_batch_id: pickupBatchId,
    reason: "Admin recorded missed storage pickup",
    notes: reason,
    needs_review: false,
    created_by: actorTeamMemberId,
    is_checked: true,
  }));

  const stockLineByProductId = new Map(
    (input.routeStockLines ?? []).map((line) => [String(line.product_id ?? ""), line]),
  );
  const stockLineRows = items.map((item) => {
    const current = stockLineByProductId.get(item.productId);
    return {
      route_id: routeId,
      product_id: item.productId,
      planned_qty: unitQuantity(current?.planned_qty),
      picked_qty: unitQuantity(current?.picked_qty) + item.quantity,
      updated_at: recordedAt,
    };
  });

  const inventoryMovements = items.map((item) => ({
    product_id: item.productId,
    quantity: item.quantity,
    from_entity_type: "storage",
    from_entity_id: storageLocationId,
    to_entity_type: "operator_bag",
    to_entity_id: operatorId,
    reason: "storage_to_operator_bag",
    related_pickup_batch_id: pickupBatchId,
    idempotency_key: `admin-missed-route-pickup:${submissionId}:${item.productId}`,
    source_type: "admin_missed_route_pickup",
    source_id: submissionId,
    created_by: actorTeamMemberId,
    notes: `Admin recorded missed pickup for route ${routeId}: ${reason}`,
  }));

  const productSummary = items.map((item) => ({
    product_id: item.productId,
    product_name: item.productName,
    quantity: item.quantity,
  }));

  return {
    items,
    pickupBatchId,
    correctionPickListRowIds: correctionPickListRows.map((row) => row.id),
    rpcArgs: {
      p_route_id: routeId,
      p_expected_route_status: input.route.status,
      p_next_route_status: input.route.status,
      p_started_at: input.route.startedAt ?? recordedAt,
      p_replace_pick_list: false,
      p_pickup_batch: {
        id: pickupBatchId,
        route_id: routeId,
        operator_id: operatorId,
        workflow_kind: "admin_missed_pickup",
        status: "confirmed",
        selected_stop_ids: [],
        product_summary: productSummary,
        storage_deducted: true,
        confirmed_at: recordedAt,
      },
      p_batch_stop_ids: [],
      p_new_stop_item_rows: [],
      p_inventory_movements: inventoryMovements,
      p_pick_list_rows: [...existingChecklistRows, ...correctionPickListRows],
      p_stock_line_rows: stockLineRows,
      p_stop_item_picks: [],
      p_refill_line_picks: [],
      p_selected_stop_ids: [],
      p_acknowledged_pickup_line_ids: requiredStopItemIds,
      p_selected_machine_ids: [],
    },
  };
}
