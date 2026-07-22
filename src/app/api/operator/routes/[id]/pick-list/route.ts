import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { isRouteStopDoneStatus, isTerminalRouteStatus, ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";
import { formatMachineDisplayName } from "@/lib/machine-site-display";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" ");
}

function isMissingColumn(error: unknown, columns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

function isMissingRpc(error: unknown, functionName: string) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const normalizedFunctionName = functionName.toLowerCase();
  return (
    code === "42883" ||
    code === "PGRST202" ||
    (text.includes(normalizedFunctionName) && (text.includes("schema cache") || text.includes("function")))
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const row = error as { message?: unknown; details?: unknown; hint?: unknown };
    return String(row.message ?? row.details ?? row.hint ?? "Unknown database error");
  }
  return "Unknown database error";
}

function supabaseErrorSummary(error: unknown) {
  if (!error || typeof error !== "object") return { message: errorMessage(error) };
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return {
    code: row.code ?? null,
    message: row.message ?? errorMessage(error),
    details: row.details ?? null,
    hint: row.hint ?? null,
  };
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeChecklistSaveItem({
  routeId,
  routeStopItem,
  savedItem,
  isChecked,
  localOnly = false,
}: {
  routeId: string;
  routeStopItem: { id?: unknown; route_stop_id?: unknown; machine_id?: unknown; product_id?: unknown; planned_quantity?: unknown };
  savedItem?: Record<string, unknown> | null;
  isChecked: boolean;
  localOnly?: boolean;
}) {
  return {
    id: stringOrNull(savedItem?.id ?? routeStopItem.id) ?? String(routeStopItem.id ?? ""),
    routeId,
    routeStopItemId: stringOrNull(savedItem?.route_stop_item_id ?? savedItem?.id ?? routeStopItem.id) ?? String(routeStopItem.id ?? ""),
    routeStopId: stringOrNull(savedItem?.route_stop_id ?? routeStopItem.route_stop_id),
    machineId: stringOrNull(savedItem?.machine_id ?? routeStopItem.machine_id),
    productId: stringOrNull(savedItem?.product_id ?? routeStopItem.product_id),
    plannedQty: unitQuantity(savedItem?.planned_quantity ?? routeStopItem.planned_quantity),
    isChecked: booleanValue(savedItem?.is_checked ?? savedItem?.isChecked, isChecked),
    checkedAt: stringOrNull(savedItem?.checked_at),
    checkedBy: stringOrNull(savedItem?.checked_by),
    localOnly,
  };
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function routeStopProductKey(routeStopId: string | null | undefined, productId: string | null | undefined) {
  return `${routeStopId ?? ""}:${productId ?? ""}`;
}

function isPreparedPickupBatch(batch: any) {
  return Boolean(batch?.prepared_at) && !batch?.confirmed_at && !batch?.returned_to_assigned_at;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  if (!routeId) {
    return NextResponse.json({ error: "Route id is required" }, { status: 400 });
  }

  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  let route: any = null;
  let routeExists = false;
  let operatorHasAccess = false;
  let failingStep = "load_route";
  let failingResource: string | null = "routes";
  let routeItemCount = 0;
  let pickupItemCount = 0;
  let stopCount = 0;
  let pendingStopCount = 0;
  let itemSource = "route_stop_items";
  let fallbackUsed = false;

  const logContext = (extra: Record<string, unknown> = {}) => ({
    route_id: routeId,
    current_user_id: profile?.id ?? null,
    current_user_role: profile?.role ?? null,
    current_user_roles: profile?.roles ?? [],
    operator_profile_id: profile?.team_member_id ?? null,
    route_exists: routeExists,
    operator_has_access: operatorHasAccess,
    route_status: route?.status ?? null,
    assigned_operator_id: route?.operator_id ?? null,
    route_item_count: routeItemCount,
    pickup_item_count: pickupItemCount,
    stop_count: stopCount,
    pending_stop_count: pendingStopCount,
    item_source: itemSource,
    fallback_used: fallbackUsed,
    ...extra,
  });

  const logOptionalFailure = ({
    step,
    resource,
    error,
    extra = {},
  }: {
    step: string;
    resource: string;
    error: unknown;
    extra?: Record<string, unknown>;
  }) => {
    const summary = supabaseErrorSummary(error);
    console.warn("[operator:pick-list] Optional pick list data failed", logContext({
      loader_step: step,
      loader_resource: resource,
      optional_data_failed: true,
      db_error_code: summary.code ?? null,
      db_error_message: summary.message ?? null,
      db_error_details: summary.details ?? null,
      db_error_hint: summary.hint ?? null,
      ...extra,
    }));
  };

  try {
    failingStep = "load_route";
    failingResource = "routes";
    const { data: routeData, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();
    if (routeError) throw routeError;
    route = routeData;
    routeExists = Boolean(route);

    if (!route) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    operatorHasAccess = canAccessOperatorRoute(routeAccessProfile, route.operator_id);
    if (!operatorHasAccess) {
      return NextResponse.json({ error: "This route is not assigned to you" }, { status: 403 });
    }

    const readClient = getSupabaseAdminClient() ?? supabase;
    const { data: activePickupBatch, error: activePickupBatchError } = await readClient
      .from("route_pickup_batches")
      .select("id, route_id, operator_id, status, selected_stop_ids, product_summary, storage_deducted, prepared_at, prepared_by, confirmed_at, returned_to_assigned_at, returned_to_assigned_reason, created_at, updated_at")
      .eq("route_id", routeId)
      .is("returned_to_assigned_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    let preparedBatch = activePickupBatch && isPreparedPickupBatch(activePickupBatch)
      ? {
          id: String(activePickupBatch.id ?? ""),
          routeId: String(activePickupBatch.route_id ?? routeId),
          operatorId: activePickupBatch.operator_id ? String(activePickupBatch.operator_id) : null,
          status: String(activePickupBatch.status ?? "draft"),
          selectedStopIds: Array.isArray(activePickupBatch.selected_stop_ids) ? activePickupBatch.selected_stop_ids.map((value: unknown) => String(value ?? "")).filter(Boolean) : [],
          productSummary: Array.isArray(activePickupBatch.product_summary)
            ? activePickupBatch.product_summary.map((row: any) => ({
                productId: String(row?.product_id ?? row?.productId ?? ""),
                productName: row?.product_name ?? row?.productName ?? null,
                quantity: Number(row?.quantity ?? 0),
              })).filter((row: any) => row.productId && row.quantity > 0)
            : [],
          storageDeducted: Boolean(activePickupBatch.storage_deducted),
          preparedAt: activePickupBatch.prepared_at ?? null,
          preparedBy: activePickupBatch.prepared_by ? String(activePickupBatch.prepared_by) : null,
          confirmedAt: activePickupBatch.confirmed_at ?? null,
          returnedToAssignedAt: activePickupBatch.returned_to_assigned_at ?? null,
          returnedToAssignedReason: activePickupBatch.returned_to_assigned_reason ?? null,
          createdAt: activePickupBatch.created_at ?? null,
          updatedAt: activePickupBatch.updated_at ?? null,
        }
      : null;
    if (activePickupBatchError) {
      if (isMissingColumn(activePickupBatchError, ["prepared_at", "prepared_by"])) {
        preparedBatch = null;
      } else {
        logOptionalFailure({
          step: "load_route_pickup_batches",
          resource: "route_pickup_batches",
          error: activePickupBatchError,
        });
      }
    }

    failingStep = "load_route_stops";
    failingResource = "route_stops";
    const { data: stopsData, error: stopsError } = await readClient
      .from("route_stops")
      .select("id, machine_id, stop_order, status")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true });
    if (stopsError) throw stopsError;

    const stops = stopsData ?? [];
    stopCount = stops.length;
    pendingStopCount = stops.filter((stop: any) => String(stop.status ?? "") === ROUTE_STOP_PENDING_STATUS).length;

    const stopById = new Map<string, any>();
    const stopByMachine = new Map<string, any>();
    stops.forEach((stop: any) => {
      const stopId = String(stop.id ?? "");
      const machineId = String(stop.machine_id ?? "");
      if (stopId) stopById.set(stopId, stop);
      if (machineId) stopByMachine.set(machineId, stop);
    });

    const pendingStopIds = new Set(
      stops
        .filter((stop: any) => String(stop.status ?? "") === ROUTE_STOP_PENDING_STATUS)
        .map((stop: any) => String(stop.id ?? ""))
        .filter(Boolean),
    );
    const preparedStopIds = new Set(
      Array.isArray(preparedBatch?.selectedStopIds)
        ? preparedBatch.selectedStopIds.map((stopId: unknown) => String(stopId ?? "")).filter(Boolean)
        : [],
    );
    const actionableStopIds = new Set(
      stops
        .filter((stop: any) => !isRouteStopDoneStatus(String(stop.status ?? ROUTE_STOP_PENDING_STATUS)))
        .map((stop: any) => String(stop.id ?? ""))
        .filter(Boolean),
    );
    preparedStopIds.forEach((stopId) => actionableStopIds.add(stopId));
    const relevantStopIds = actionableStopIds.size
      ? actionableStopIds
      : new Set(stops.map((stop: any) => String(stop.id ?? "")).filter(Boolean));

    const loadStopItemsFromRefillOrders = async (reason: string) => {
      failingStep = "load_refill_order_lines_fallback";
      failingResource = "refill_orders";
      const fallback = await readClient
        .from("refill_orders")
        .select(
          `id,
          machine_id,
          refill_order_lines(
            id,
            machine_slot_id,
            product_id,
            final_qty_to_take,
            suggested_qty,
            source
          )`
        )
        .eq("route_id", routeId);
      if (fallback.error) throw fallback.error;
      const fallbackRows = (fallback.data ?? []).flatMap((order: any) =>
        (order.refill_order_lines ?? []).map((line: any) => ({
          id: line.id,
          route_stop_id: stopByMachine.get(String(order.machine_id ?? ""))?.id ?? null,
          machine_id: order.machine_id,
          product_id: line.product_id,
          planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
          is_checked: false,
          checked_at: null,
          checked_by: null,
          source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
        })),
      );
      fallbackUsed = true;
      itemSource = "refill_order_lines";
      console.info("[operator:pick-list] Using refill order fallback for route items", logContext({
        loader_step: failingStep,
        loader_resource: failingResource,
        fallback_reason: reason,
        fallback_item_count: fallbackRows.length,
      }));
      return fallbackRows;
    };

    let stopItems: any[] = [];
    let stopItemsError: any = null;
    failingStep = "load_route_stop_items";
    failingResource = "route_stop_items";
    const stopItemsResponse = await readClient
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, planned_quantity, is_checked, checked_at, checked_by, source")
      .eq("route_id", routeId);
    stopItems = stopItemsResponse.data ?? [];
    stopItemsError = stopItemsResponse.error;

    if (stopItemsError && isMissingColumn(stopItemsError, ["is_checked", "checked_at", "checked_by"])) {
      const fallback = await readClient
        .from("route_stop_items")
        .select("id, route_stop_id, machine_id, product_id, planned_quantity, source")
        .eq("route_id", routeId);
      stopItems = (fallback.data ?? []).map((item: any) => ({
        ...item,
        is_checked: false,
        checked_at: null,
        checked_by: null,
      }));
      stopItemsError = fallback.error;
    }

    if (stopItemsError) {
      logOptionalFailure({
        step: "load_route_stop_items",
        resource: "route_stop_items",
        error: stopItemsError,
        extra: {
          fallback_reason: isMissingTable(stopItemsError, "route_stop_items") ? "route_stop_items_missing" : "route_stop_items_query_failed",
        },
      });
      try {
        stopItems = await loadStopItemsFromRefillOrders(
          isMissingTable(stopItemsError, "route_stop_items") ? "route_stop_items_missing" : "route_stop_items_query_failed",
        );
      } catch (fallbackError) {
        logOptionalFailure({
          step: "load_refill_order_lines_fallback",
          resource: "refill_orders",
          error: fallbackError,
          extra: {
            fallback_reason: isMissingTable(stopItemsError, "route_stop_items") ? "route_stop_items_missing" : "route_stop_items_query_failed",
          },
        });
        stopItems = [];
      }
    } else if (!stopItems.length) {
      try {
        const fallbackStopItems = await loadStopItemsFromRefillOrders("route_stop_items_empty");
        if (fallbackStopItems.length) stopItems = fallbackStopItems;
      } catch (fallbackError) {
        logOptionalFailure({
          step: "load_refill_order_lines_fallback",
          resource: "refill_orders",
          error: fallbackError,
          extra: { fallback_reason: "route_stop_items_empty" },
        });
      }
    }
    routeItemCount = stopItems.length;

    let pickListItems: any[] = [];
    failingStep = "load_route_pick_list_items";
    failingResource = "route_pick_list_items";
    const pickListResponse = await readClient
      .from("route_pick_list_items")
      .select("id, route_stop_id, route_stop_item_id, machine_id, product_id, picked_qty, planned_qty, action_type, reason, notes, is_checked, is_active")
      .eq("route_id", routeId);
    pickListItems = (pickListResponse.data ?? []).filter((item: any) => item.is_active !== false);
    let pickListError: any = pickListResponse.error;

    if (pickListError && isMissingColumn(pickListError, ["is_checked"])) {
      const fallback = await readClient
        .from("route_pick_list_items")
        .select("id, route_stop_id, route_stop_item_id, machine_id, product_id, picked_qty, planned_qty, action_type, reason, notes, is_active")
        .eq("route_id", routeId);
      pickListItems = (fallback.data ?? []).filter((item: any) => item.is_active !== false).map((item: any) => ({ ...item, is_checked: false }));
      pickListError = fallback.error;
    }
    if (pickListError && isMissingColumn(pickListError, ["route_stop_id", "route_stop_item_id", "machine_id"])) {
      const fallback = await readClient
        .from("route_pick_list_items")
        .select("id, product_id, picked_qty, planned_qty, action_type, reason, notes, is_active")
        .eq("route_id", routeId);
      pickListItems = (fallback.data ?? []).filter((item: any) => item.is_active !== false).map((item: any) => ({
        ...item,
        route_stop_id: null,
        route_stop_item_id: null,
        machine_id: null,
        is_checked: false,
      }));
      pickListError = fallback.error;
    }
    if (pickListError) {
      logOptionalFailure({
        step: "load_route_pick_list_items",
        resource: "route_pick_list_items",
        error: pickListError,
      });
      pickListItems = [];
    }
    pickupItemCount = pickListItems.length;

    if (!stopItems.length && pickListItems.length) {
      stopItems = pickListItems
        .filter((line: any) => {
          if (!line.product_id) return false;
          if (String(line.action_type ?? "") === "extra_product") return false;
          return unitQuantity(line.planned_qty ?? line.picked_qty) > 0;
        })
        .map((line: any, index: number) => ({
          id: line.route_stop_item_id ?? `legacy-pick:${String(line.id ?? index)}`,
          route_stop_id: line.route_stop_id ?? null,
          machine_id: line.machine_id ?? stopById.get(String(line.route_stop_id ?? ""))?.machine_id ?? null,
          product_id: line.product_id,
          planned_quantity: Number(line.planned_qty ?? line.picked_qty ?? 0),
          is_checked: Boolean(line.is_checked),
          checked_at: null,
          checked_by: null,
          source: "route_pick_list_items_fallback",
        }));
      if (stopItems.length) {
        fallbackUsed = true;
        itemSource = "route_pick_list_items";
        routeItemCount = stopItems.length;
        console.info("[operator:pick-list] Using route pick list items fallback for route items", logContext({
          loader_step: "load_route_pick_list_items",
          loader_resource: "route_pick_list_items",
          fallback_reason: "route_items_missing_but_pick_list_exists",
          fallback_item_count: stopItems.length,
        }));
      }
    }

    const machineIds = Array.from(new Set([
      ...stops.map((stop: any) => String(stop.machine_id ?? "")).filter(Boolean),
      ...stopItems.map((item: any) => String(item.machine_id ?? "")).filter(Boolean),
    ]));
    const productIds = Array.from(new Set([
      ...stopItems.map((item: any) => String(item.product_id ?? "")).filter(Boolean),
      ...pickListItems.map((item: any) => String(item.product_id ?? "")).filter(Boolean),
    ]));

    const machineById = new Map<string, any>();
    const locationById = new Map<string, any>();
    let productRows: any[] = [];

    if (machineIds.length) {
      failingStep = "load_machines";
      failingResource = "machines";
      let machinesResponse: any = await readClient
        .from("machines")
        .select("id, name, machine_code, location_id")
        .in("id", machineIds);

      if (machinesResponse.error && isMissingColumn(machinesResponse.error, ["location_id"])) {
        machinesResponse = await readClient
          .from("machines")
          .select("id, name, machine_code")
          .in("id", machineIds);
      }

      if (machinesResponse.error) {
        logOptionalFailure({ step: "load_machines", resource: "machines", error: machinesResponse.error });
      } else {
        (machinesResponse.data ?? []).forEach((machine: any) => {
          machineById.set(String(machine.id), machine);
        });
      }
    }

    const locationIds = Array.from(new Set(
      Array.from(machineById.values())
        .map((machine: any) => String(machine.location_id ?? ""))
        .filter(Boolean),
    ));
    if (locationIds.length) {
      failingStep = "load_locations";
      failingResource = "locations";
      const locationsResponse = await readClient
        .from("locations")
        .select("id, name")
        .in("id", locationIds);
      if (locationsResponse.error) {
        logOptionalFailure({ step: "load_locations", resource: "locations", error: locationsResponse.error });
      } else {
        (locationsResponse.data ?? []).forEach((location: any) => {
          locationById.set(String(location.id), location);
        });
      }
    }

    if (productIds.length) {
      failingStep = "load_products_for_route_items";
      failingResource = "products";
      let productsResponse: any = await readClient
        .from("products")
        .select("id, name, sku, category, case_quantity")
        .in("id", productIds);

      if (productsResponse.error && isMissingColumn(productsResponse.error, ["category"])) {
        productsResponse = await readClient
          .from("products")
          .select("id, name, sku, case_quantity")
          .in("id", productIds);
      }
      if (productsResponse.error && isMissingColumn(productsResponse.error, ["sku"])) {
        productsResponse = await readClient
          .from("products")
          .select("id, name")
          .in("id", productIds);
      }

      if (productsResponse.error) {
        logOptionalFailure({ step: "load_products_for_route_items", resource: "products", error: productsResponse.error });
      } else {
        productRows = (productsResponse.data ?? []).map((product: any) => ({
          ...product,
          sku: product?.sku ?? null,
          category: product?.category ?? null,
          case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),
        }));
      }
    }

    const productById = new Map(productRows.map((product: any) => [String(product.id), product]));

    const includesRelevantStop = (routeStopId: string | null | undefined) => {
      if (!routeStopId) return true;
      if (!relevantStopIds.size) return true;
      return relevantStopIds.has(String(routeStopId));
    };

    const pickedByStopItem = new Map<string, { quantity: number; reason: string | null; notes: string | null; isChecked: boolean }>();
    const pickedByStopProduct = new Map<string, { quantity: number; reason: string | null; notes: string | null; isChecked: boolean }>();
    const legacyPickedByProduct = new Map<string, { quantity: number; reason: string | null; notes: string | null; isChecked: boolean }>();
    const pickedByProduct = new Map<string, number>();
    const extraItems = pickListItems
      .filter((line: any) => {
        if (line.action_type !== "extra_product" || !line.product_id || line.route_stop_item_id) return false;
        return includesRelevantStop(line.route_stop_id ? String(line.route_stop_id) : null);
      })
      .map((line: any) => {
        const productId = String(line.product_id ?? "").trim();
        const quantity = unitQuantity(line.picked_qty);
        if (productId) pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
        return {
          productId,
          routeStopId: line.route_stop_id ? String(line.route_stop_id) : null,
          machineId: line.machine_id ? String(line.machine_id) : null,
          quantity,
          reason: line.reason ?? "Customer demand",
          notes: line.notes ?? "",
        };
      });

    pickListItems.forEach((line: any) => {
      const actionType = String(line.action_type ?? "");
      if (actionType !== "planned_pick" && !(actionType === "extra_product" && line.route_stop_item_id)) return;
      const productId = String(line.product_id ?? "").trim();
      if (!productId) return;
      const lineStopId = line.route_stop_id ? String(line.route_stop_id) : null;
      if (!includesRelevantStop(lineStopId)) return;
      const quantity = unitQuantity(line.picked_qty);
      pickedByProduct.set(productId, (pickedByProduct.get(productId) ?? 0) + quantity);
      const next = { quantity, reason: line.reason ?? null, notes: line.notes ?? null, isChecked: Boolean(line.is_checked) };
      if (line.route_stop_item_id) {
        const key = String(line.route_stop_item_id);
        const current = pickedByStopItem.get(key);
        pickedByStopItem.set(key, {
          quantity: (current?.quantity ?? 0) + quantity,
          reason: next.reason ?? current?.reason ?? null,
          notes: next.notes ?? current?.notes ?? null,
          isChecked: current?.isChecked || next.isChecked,
        });
        return;
      }
      if (lineStopId) {
        const key = routeStopProductKey(lineStopId, productId);
        const current = pickedByStopProduct.get(key);
        pickedByStopProduct.set(key, {
          quantity: (current?.quantity ?? 0) + quantity,
          reason: next.reason ?? current?.reason ?? null,
          notes: next.notes ?? current?.notes ?? null,
          isChecked: current?.isChecked || next.isChecked,
        });
        return;
      }
      const current = legacyPickedByProduct.get(productId);
      legacyPickedByProduct.set(productId, {
        quantity: (current?.quantity ?? 0) + quantity,
        reason: next.reason ?? current?.reason ?? null,
        notes: next.notes ?? current?.notes ?? null,
        isChecked: current?.isChecked || next.isChecked,
      });
    });

    const sortedStopItems = [...stopItems].sort((a: any, b: any) => {
      const aStop = stopById.get(String(a.route_stop_id ?? "")) ?? stopByMachine.get(String(a.machine_id ?? ""));
      const bStop = stopById.get(String(b.route_stop_id ?? "")) ?? stopByMachine.get(String(b.machine_id ?? ""));
      const stopOrderDiff = Number(aStop?.stop_order ?? 9999) - Number(bStop?.stop_order ?? 9999);
      if (stopOrderDiff) return stopOrderDiff;
      return String(a.product_id ?? "").localeCompare(String(b.product_id ?? ""));
    });

    const legacyAllocationByStopItem = new Map<string, { quantity: number; reason: string | null; notes: string | null; isChecked: boolean }>();
    legacyPickedByProduct.forEach((legacyPick, productId) => {
      const productLines = sortedStopItems.filter((line: any) => String(line.product_id ?? "") === productId);
      let remaining = legacyPick.quantity;
      productLines.forEach((line: any, index: number) => {
        const lineId = String(line.id ?? "");
        if (!lineId) return;
        const plannedQty = unitQuantity(line.planned_quantity);
        const isLast = index === productLines.length - 1;
        const allocated = isLast ? Math.max(0, remaining) : Math.max(0, Math.min(remaining, plannedQty));
        remaining -= allocated;
        legacyAllocationByStopItem.set(lineId, {
          quantity: allocated,
          reason: legacyPick.reason,
          notes: legacyPick.notes,
          isChecked: legacyPick.isChecked,
        });
      });
    });

    let productOptionsData: any[] = [];
    failingStep = "load_product_options";
    failingResource = "products";
    {
      let productOptionsResponse: any = await readClient
        .from("products")
        .select("id, sku, barcode, name, category, brand, image_url, case_quantity, active")
        .eq("active", true)
        .order("name");

      if (productOptionsResponse.error && isMissingColumn(productOptionsResponse.error, ["category", "brand", "image_url"])) {
        productOptionsResponse = await readClient
          .from("products")
          .select("id, sku, barcode, name, case_quantity, active")
          .eq("active", true)
          .order("name");
      }

      if (productOptionsResponse.error) {
        logOptionalFailure({ step: "load_product_options", resource: "products", error: productOptionsResponse.error });
        productOptionsData = productRows.map((product: any) => ({
          ...product,
          barcode: null,
          brand: null,
          image_url: null,
          active: true,
        }));
      } else {
        productOptionsData = (productOptionsResponse.data ?? []).map((product: any) => ({
          ...product,
          category: product?.category ?? null,
          brand: product?.brand ?? null,
          image_url: product?.image_url ?? null,
          case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),
        }));
      }
    }

    const storageProductIds = Array.from(new Set([
      ...productIds,
      ...productOptionsData.map((product: any) => String(product.id ?? "")).filter(Boolean),
      ...Array.from(pickedByProduct.keys()),
    ].filter(Boolean)));
    const storageByProduct = new Map<string, number>();
    let storageAvailabilityLoaded = false;

    if (storageProductIds.length) {
      failingStep = "load_storage_availability";
      failingResource = "current_inventory_by_location";
      const storageResult = await readClient
        .from("current_inventory_by_location")
        .select("product_id, quantity_on_hand")
        .eq("location_type", "storage")
        .in("product_id", storageProductIds);
      if (storageResult.error) {
        logOptionalFailure({ step: "load_storage_availability", resource: "current_inventory_by_location", error: storageResult.error });
      } else {
        storageAvailabilityLoaded = true;
        (storageResult.data ?? []).forEach((row: any) => {
          const productId = String(row.product_id ?? "").trim();
          if (!productId) return;
          storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + unitQuantity(row.quantity_on_hand));
        });
      }
    }

    const availableStorageQtyForProduct = (productId: string, fallbackQty = 0) => {
      const alreadyPicked = pickedByProduct.get(productId) ?? 0;
      if (storageAvailabilityLoaded) return (storageByProduct.get(productId) ?? 0) + alreadyPicked;
      return Math.max(fallbackQty, alreadyPicked);
    };

    const stopGroupsById = new Map<string, any>();
    stops.forEach((stop: any) => {
      const machine = machineById.get(String(stop.machine_id ?? "")) ?? null;
      const location = machine?.location_id ? locationById.get(String(machine.location_id)) ?? null : null;
      const locationName = location?.name ?? "Unknown location";
      stopGroupsById.set(String(stop.id), {
        route_stop_id: stop.id,
        machine_id: stop.machine_id,
        stop_status: stop.status,
        machine_name: formatMachineDisplayName({ ...machine, location_name: locationName }, { includeArea: true }),
        machine_code: machine?.machine_code ?? "-",
        location_name: locationName,
        stop_order: Number(stop.stop_order ?? 0),
        items: [],
      });
    });

    const plannedByProduct = new Map<string, any>();
    sortedStopItems.forEach((line: any) => {
      const productId = String(line.product_id ?? "").trim();
      const plannedQty = unitQuantity(line.planned_quantity);
      if (!productId || plannedQty <= 0) return;
      const routeStopId = line.route_stop_id ? String(line.route_stop_id) : null;
      const routeStopItemId = String(line.id ?? "");
      const stop = routeStopId ? stopById.get(routeStopId) : stopByMachine.get(String(line.machine_id ?? ""));
      if (stop && !includesRelevantStop(String(stop.id ?? ""))) return;

      const machineId = String(line.machine_id ?? stop?.machine_id ?? "");
      const machine = machineById.get(machineId) ?? null;
      const location = machine?.location_id ? locationById.get(String(machine.location_id)) ?? null : null;
      const locationName = location?.name ?? "Unknown location";
      const product = productById.get(productId) ?? null;
      const savedPick =
        (routeStopItemId ? pickedByStopItem.get(routeStopItemId) : undefined) ??
        pickedByStopProduct.get(routeStopProductKey(routeStopId, productId)) ??
        (routeStopItemId ? legacyAllocationByStopItem.get(routeStopItemId) : undefined) ??
        null;

      const groupId = routeStopId ?? `machine:${machineId}`;
      const group = stopGroupsById.get(groupId) ?? {
        route_stop_id: routeStopId,
        machine_id: machineId || null,
        stop_status: stop?.status ?? null,
        machine_name: formatMachineDisplayName({ ...machine, location_name: locationName }, { includeArea: true }),
        machine_code: machine?.machine_code ?? "-",
        location_name: locationName,
        stop_order: Number(stop?.stop_order ?? 0),
        items: [],
      };
      group.items.push({
        route_stop_item_id: routeStopItemId,
        route_stop_id: routeStopId,
        machine_id: machineId || null,
        product_id: productId,
        product_name: product?.name || "Unknown product",
        sku: product?.sku ?? null,
        category: product?.category ?? "Other",
        case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),
        planned_qty: plannedQty,
        picked_qty: savedPick ? savedPick.quantity : null,
        is_checked: Boolean(line.is_checked ?? savedPick?.isChecked ?? false),
        checked_at: line.checked_at ?? null,
        checked_by: line.checked_by ?? null,
        reason: savedPick?.reason ?? null,
        notes: savedPick?.notes ?? null,
        source: line.source ?? "manual_admin_assignment",
      });
      stopGroupsById.set(groupId, group);

      const current = plannedByProduct.get(productId) ?? {
        product_id: productId,
        product_name: product?.name || "Unknown product",
        sku: product?.sku ?? null,
        category: product?.category ?? "Other",
        case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),
        planned_qty: 0,
        picked_qty: 0,
        has_picked_qty: false,
        machine_items: [],
      };
      current.planned_qty += plannedQty;
      if (savedPick) {
        current.picked_qty += savedPick.quantity;
        current.has_picked_qty = true;
      }
      current.machine_items.push({
        route_stop_item_id: routeStopItemId,
        route_stop_id: routeStopId,
        machine_id: machineId || null,
        machine_name: formatMachineDisplayName({ ...machine, location_name: locationName }, { includeArea: true }),
        machine_code: machine?.machine_code ?? "-",
        location_name: locationName,
        planned_qty: plannedQty,
        picked_qty: savedPick ? savedPick.quantity : null,
        is_checked: Boolean(line.is_checked ?? savedPick?.isChecked ?? false),
        checked_at: line.checked_at ?? null,
        checked_by: line.checked_by ?? null,
        source: line.source ?? "manual_admin_assignment",
      });
      plannedByProduct.set(productId, current);
    });

    const stopGroups = Array.from(stopGroupsById.values())
      .map((group: any) => ({
        ...group,
        items: (group.items ?? []).map((line: any) => ({
          ...line,
          available_storage_qty: availableStorageQtyForProduct(String(line.product_id), unitQuantity(line.planned_qty)),
        })),
      }))
      .filter((group: any) => group.items.length > 0)
      .sort((a: any, b: any) => Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0));

    let confirmed = Boolean(preparedBatch?.confirmedAt);
    failingStep = "load_pickup_confirmation_state";
    failingResource = "inventory_movements";
    const pickMovementsResult = await readClient
      .from("inventory_movements")
      .select("id")
      .eq("related_route_id", routeId)
      .in("reason", ["storage_to_operator_bag"])
      .limit(1);
    if (pickMovementsResult.error) {
      logOptionalFailure({ step: "load_pickup_confirmation_state", resource: "inventory_movements", error: pickMovementsResult.error });
    } else {
      confirmed = Boolean(pickMovementsResult.data?.length);
    }
    const isPrepared = Boolean(preparedBatch && !preparedBatch.confirmedAt && !preparedBatch.returnedToAssignedAt);

    const items = Array.from(plannedByProduct.values()).map((line: any) => ({
      product_id: line.product_id,
      product_name: line.product_name || "Unknown product",
      sku: line.sku ?? null,
      case_quantity: Math.max(1, unitQuantity(line.case_quantity ?? 1)),
      planned_qty: unitQuantity(line.planned_qty),
      picked_qty: line.has_picked_qty ? unitQuantity(line.picked_qty) : null,
      available_storage_qty: availableStorageQtyForProduct(String(line.product_id), unitQuantity(line.planned_qty)),
      machine_items: Array.isArray(line.machine_items) ? line.machine_items : [],
    }));

    const productOptions = productOptionsData.map((product: any) => ({
      id: product.id,
      sku: product.sku ?? null,
      barcode: product.barcode ?? null,
      name: product.name ?? "Unnamed product",
      category: product.category ?? "Other",
      brand: product.brand ?? null,
      imageUrl: product.image_url ?? null,
      caseQuantity: Math.max(1, unitQuantity(product.case_quantity ?? 1)),
      availableStorageQty: availableStorageQtyForProduct(String(product.id ?? ""), 0),
    }));

    return NextResponse.json({
      stopGroups,
      items,
      routeTotals: items,
      productOptions,
      extraItems,
      confirmed,
      prepared: isPrepared,
      preparedBatch,
      locked: isTerminalRouteStatus(route.status),
      routeStatus: route.status,
      pendingStopCount,
      routeItemCount,
      pickupItemCount,
      itemSource,
      debug: process.env.NODE_ENV === "development"
        ? {
            routeId,
            routeExists,
            operatorHasAccess,
            routeStatus: route.status ?? null,
            routeStopItemsCount: routeItemCount,
            routePickListItemsCount: pickupItemCount,
            stopCount,
            pendingStopCount,
            itemSource,
            productOptionsCount: productOptions.length,
            operatorTeamMemberId: profile?.team_member_id ?? null,
          }
        : undefined,
    });
  } catch (error) {
    const summary = supabaseErrorSummary(error);
    console.error("[operator:pick-list] Error fetching pick list", logContext({
      loader_step: failingStep,
      loader_resource: failingResource,
      db_error_code: summary.code ?? null,
      db_error_message: summary.message ?? null,
      db_error_details: summary.details ?? null,
      db_error_hint: summary.hint ?? null,
      error,
    }));
    return NextResponse.json(
      { error: "Failed to fetch pick list", details: errorMessage(error) },
      { status: 500 }
    );
  }
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);
  let checklistSaveContext: Record<string, unknown> = {
    table_name: "route_stop_items",
    row_id: null,
    route_id: routeId,
    product_id: null,
    sent_payload: null,
    current_user_id: profile?.id ?? null,
    current_team_member_id: profile?.team_member_id ?? null,
    user_role: profile?.role ?? null,
    user_roles: profile?.roles ?? [],
  };

  if (!supabase) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  if (!routeId) {
    return NextResponse.json({ error: "Route id is required" }, { status: 400 });
  }

  try {
    const body = await request.json();
    const routeStopItemId = String(body?.routeStopItemId ?? "").trim();
    const hasCheckedFlag = typeof body?.isChecked === "boolean" || typeof body?.is_checked === "boolean";
    const isChecked = typeof body?.isChecked === "boolean" ? body.isChecked : Boolean(body?.is_checked);
    if (!routeStopItemId) {
      return NextResponse.json({ error: "Route stop item is required" }, { status: 400 });
    }
    if (!hasCheckedFlag) {
      return NextResponse.json({ error: "Checklist checked state is required" }, { status: 400 });
    }

    const { data: route, error: routeError } = await supabase
      .from("routes")
      .select("id, operator_id, status")
      .eq("id", routeId)
      .maybeSingle();
    if (routeError) throw routeError;
    if (!route) return NextResponse.json({ error: "Route not found" }, { status: 404 });
    if (!canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return NextResponse.json({ error: "This route is not assigned to you" }, { status: 403 });
    }
    if (isTerminalRouteStatus(route.status)) {
      return NextResponse.json({ error: "Completed or cancelled routes cannot be edited" }, { status: 409 });
    }

    const { data: activePickupBatch, error: activePickupBatchError } = await supabase
      .from("route_pickup_batches")
      .select("id, prepared_at, confirmed_at, returned_to_assigned_at")
      .eq("route_id", routeId)
      .is("returned_to_assigned_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activePickupBatchError) {
      if (!isMissingColumn(activePickupBatchError, ["prepared_at", "prepared_by"])) {
        throw activePickupBatchError;
      }
    } else if (isPreparedPickupBatch(activePickupBatch)) {
      return NextResponse.json({ error: "Items prepared snapshot is locked. Confirm pickup to continue." }, { status: 409 });
    }

    const { data: routeStopItem, error: routeStopItemError } = await supabase
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, planned_quantity")
      .eq("id", routeStopItemId)
      .eq("route_id", routeId)
      .maybeSingle();
    if (routeStopItemError) throw routeStopItemError;
    if (!routeStopItem) return NextResponse.json({ error: "Pickup item not found" }, { status: 404 });

    const { data: routeStop, error: routeStopError } = await supabase
      .from("route_stops")
      .select("id, status")
      .eq("id", routeStopItem.route_stop_id)
      .eq("route_id", routeId)
      .maybeSingle();
    if (routeStopError) throw routeStopError;
    if (routeStop && String(routeStop.status ?? "") !== ROUTE_STOP_PENDING_STATUS) {
      return NextResponse.json({ error: "Only pending pickup items can be checked" }, { status: 409 });
    }

    const payload = {
      p_is_checked: isChecked,
      p_route_id: routeId,
      p_route_stop_item_id: routeStopItem.id,
    };
    checklistSaveContext = {
      ...checklistSaveContext,
      table_name: "route_stop_items",
      query: "rpc:save_route_pickup_checklist_item",
      row_id: routeStopItem.id,
      route_stop_id: routeStopItem.route_stop_id,
      route_id: routeId,
      product_id: routeStopItem.product_id,
      sent_payload: payload,
      request_payload: {
        routeStopItemId,
        isChecked,
        pickedQty: body?.pickedQty ?? null,
        reason: typeof body?.reason === "string" ? body.reason : null,
        notes: typeof body?.notes === "string" ? body.notes : null,
      },
    };
    console.info("[operator:pick-list] Saving pickup checklist item", checklistSaveContext);

    const saveResult = await supabase.rpc("save_route_pickup_checklist_item", payload);
    if (saveResult.error) {
      if (isMissingRpc(saveResult.error, "save_route_pickup_checklist_item")) {
        const responseItem = normalizeChecklistSaveItem({
          routeId,
          routeStopItem,
          isChecked,
          localOnly: true,
        });
        console.warn("[operator:pick-list] Pickup checklist RPC missing; client localStorage state remains source of truth", {
          ...checklistSaveContext,
          supabase_error: supabaseErrorSummary(saveResult.error),
          response_payload: responseItem,
        });
        return NextResponse.json({ ok: true, localOnly: true, item: responseItem });
      }
      console.error("[operator:pick-list] Pickup checklist save query failed", {
        ...checklistSaveContext,
        supabase_error: supabaseErrorSummary(saveResult.error),
      });
      throw saveResult.error;
    }

    const savedItem = Array.isArray(saveResult.data) ? saveResult.data[0] : saveResult.data;
    const responseItem = normalizeChecklistSaveItem({
      routeId,
      routeStopItem,
      savedItem,
      isChecked,
    });
    console.info("[operator:pick-list] Pickup checklist save succeeded", {
      ...checklistSaveContext,
      response_payload: responseItem,
      raw_response_payload: savedItem ?? null,
    });
    return NextResponse.json({ ok: true, item: responseItem });
  } catch (error) {
    console.error("[operator:pick-list] Error saving checklist item", {
      ...checklistSaveContext,
      supabase_error: supabaseErrorSummary(error),
    });
    const details = errorMessage(error);
    return NextResponse.json(
      { error: `Could not save checklist item: ${details}`, details },
      { status: 500 }
    );
  }
}


