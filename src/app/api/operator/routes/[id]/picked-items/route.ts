import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, isAdminRole } from "@/lib/authz";
import { normalizeInventoryEntityType } from "@/lib/inventory-movement";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { summarizeRouteInventoryMovements, type RouteInventoryMovementRow } from "@/lib/route-inventory-summary";
import { isRouteInventoryFinalizableStatus, isRouteStopDoneStatus, isTerminalRouteStatus } from "@/lib/route-workflow";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
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

function isMissingBagSnapshotRpc(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = errorMessage(error).toLowerCase();
  return code === "PGRST202" || code === "42883" || (message.includes("schema cache") && message.includes("snacky_route_bag_snapshot"));
}

function isMissingInventoryCountOptionsRpc(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = errorMessage(error).toLowerCase();
  return code === "PGRST202"
    || code === "42883"
    || (message.includes("schema cache") && message.includes("snacky_route_inventory_count_options"));
}

function isMissingTable(error: unknown, tableName: string) {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = errorMessage(error).toLowerCase();
  return code === "42P01"
    || code === "PGRST205"
    || (message.includes("schema cache") && message.includes(tableName.toLowerCase()))
    || (message.includes("relation") && message.includes(tableName.toLowerCase()));
}

type CustodyItem = {
  productId: string;
  bagOwnerId: string | null;
  bagOwnerName?: string | null;
  signedQuantity: number;
  quantity: number;
};

type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
};

type CustodyBalanceRow = {
  bag_owner_id?: string | null;
  product_id?: string | null;
  signed_quantity?: number | string | null;
};

type InventoryCountOptionsPayload = {
  active_product_options?: unknown;
  return_storage_options?: unknown;
};

type RouteStopStatusRow = {
  id?: string | null;
  machine_id?: string | null;
  stop_order?: number | string | null;
  status?: string | null;
};
type BagOwnerRow = { id?: string | null; full_name?: string | null };
type MachineContextRow = {
  id?: string | null;
  name?: string | null;
  machine_code?: string | null;
  location?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

async function loadAllRouteMovements(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, routeId: string) {
  const pageSize = 1000;
  const rows: RouteInventoryMovementRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, reason, from_entity_type, from_entity_id, to_entity_type, to_entity_id")
      .eq("related_route_id", routeId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as RouteInventoryMovementRow[]));
    if ((data?.length ?? 0) < pageSize) return rows;
  }
}

async function loadOptionalRouteMovements(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  routeId: string,
) {
  try {
    return { rows: await loadAllRouteMovements(supabase, routeId), error: null };
  } catch (error) {
    return { rows: [] as RouteInventoryMovementRow[], error };
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: routeId } = await params;
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  const profile = await getCurrentProfile();
  const routeAccessProfile = await buildOperatorRouteAccessContext(supabase, profile);

  if (!supabase) {
    return noStoreJson({ error: "Database not available" }, 500);
  }

  try {
    const { data: route, error: routeError } = await supabase.from("routes").select("id, route_date, operator_id, status").eq("id", routeId).maybeSingle();
    if (routeError) throw routeError;
    if (!route || !canAccessOperatorRoute(routeAccessProfile, route.operator_id)) {
      return noStoreJson({ error: "Route not available" }, 403);
    }

    const [
      { rows: routeMovements, error: routeMovementsError },
      { data: custodySnapshot, error: custodyError },
      { data: inventoryCountOptionsData, error: inventoryCountOptionsError },
      { data: routeStopRows, error: routeStopsError },
    ] = await Promise.all([
      loadOptionalRouteMovements(supabase, routeId),
      supabase.rpc("snacky_route_bag_snapshot", { p_route_id: routeId }),
      supabase.rpc("snacky_route_inventory_count_options", { p_route_id: routeId }),
      supabase.from("route_stops").select("id, machine_id, stop_order, status").eq("route_id", routeId).order("stop_order", { ascending: true }),
    ]);

    if (custodyError && !isMissingBagSnapshotRpc(custodyError)) throw custodyError;
    if (routeStopsError) throw routeStopsError;
    if (inventoryCountOptionsError && !isMissingInventoryCountOptionsRpc(inventoryCountOptionsError)) {
      throw inventoryCountOptionsError;
    }
    if (routeMovementsError) {
      console.warn("[operator:route-leftovers] Descriptive route movement summary is unavailable; the atomic count snapshot remains authoritative", {
        route_id: routeId,
        error_code: String((routeMovementsError as { code?: unknown } | null)?.code ?? ""),
      });
    }

    const rawInventoryCountOptions: unknown = Array.isArray(inventoryCountOptionsData)
      ? inventoryCountOptionsData[0]
      : inventoryCountOptionsData;
    const inventoryCountOptions = rawInventoryCountOptions && typeof rawInventoryCountOptions === "object"
      ? rawInventoryCountOptions as InventoryCountOptionsPayload
      : null;
    const inventoryCountOptionsAvailable = !inventoryCountOptionsError
      && Boolean(inventoryCountOptions)
      && Array.isArray(inventoryCountOptions?.active_product_options)
      && Array.isArray(inventoryCountOptions?.return_storage_options);
    const activeProductOptions: ProductOption[] = inventoryCountOptionsAvailable
      ? (inventoryCountOptions?.active_product_options as Array<Record<string, unknown>>)
          .map((product) => ({
            id: String(product.id ?? ""),
            name: String(product.name ?? "Unknown Product"),
            sku: product.sku ? String(product.sku) : null,
          }))
          .filter((product) => product.id)
      : [];
    const returnStorageOptions = inventoryCountOptionsAvailable
      ? (inventoryCountOptions?.return_storage_options as Array<Record<string, unknown>>)
          .map((storage) => ({
            id: String(storage.id ?? ""),
            name: String(storage.name ?? "Storage"),
            locationType: String(storage.location_type ?? "storage"),
          }))
          .filter((storage) => storage.id)
      : [];

    if (!inventoryCountOptionsAvailable) {
      console.warn("[operator:route-leftovers] Route-authorized count options are unavailable; finalization remains locked", {
        route_id: routeId,
        error_code: inventoryCountOptionsError?.code ?? null,
      });
    }

    const snapshotValue = Array.isArray(custodySnapshot) ? custodySnapshot[0] : custodySnapshot;
    const snapshot = snapshotValue && typeof snapshotValue === "object"
      ? snapshotValue as { ledger_token?: unknown; balances?: unknown }
      : null;
    const ledgerToken = typeof snapshot?.ledger_token === "string" && /^[0-9a-f]{32}$/.test(snapshot.ledger_token)
      ? snapshot.ledger_token
      : null;
    const snapshotBalances = Array.isArray(snapshot?.balances) ? snapshot.balances as CustodyBalanceRow[] : [];

    if (!custodyError && !ledgerToken) {
      throw new Error("Route bag snapshot returned an invalid ledger token.");
    }

    const authoritativeCustodyRows = custodyError
      ? Array.from(routeMovements.reduce((balances, movement) => {
          const productId = String(movement.product_id ?? "");
          const rawQuantity = Number(movement.quantity ?? 0);
          const quantity = Number.isFinite(rawQuantity) ? Math.max(0, rawQuantity) : 0;
          if (!productId || quantity <= 0) return balances;
          if (normalizeInventoryEntityType(movement.to_entity_type) === "operator_bag") {
            const ownerId = movement.to_entity_id ? String(movement.to_entity_id) : null;
            const key = `${ownerId ?? "unassigned"}:${productId}`;
            const row = balances.get(key) ?? { bag_owner_id: ownerId, product_id: productId, signed_quantity: 0 };
            row.signed_quantity += quantity;
            balances.set(key, row);
          }
          if (normalizeInventoryEntityType(movement.from_entity_type) === "operator_bag") {
            const ownerId = movement.from_entity_id ? String(movement.from_entity_id) : null;
            const key = `${ownerId ?? "unassigned"}:${productId}`;
            const row = balances.get(key) ?? { bag_owner_id: ownerId, product_id: productId, signed_quantity: 0 };
            row.signed_quantity -= quantity;
            balances.set(key, row);
          }
          return balances;
        }, new Map<string, { bag_owner_id: string | null; product_id: string; signed_quantity: number }>()).values())
      : snapshotBalances;

    if (custodyError) {
      console.warn("[operator:route-leftovers] Atomic bag snapshot is not installed; finalization remains locked during the deployment transition", {
        route_id: routeId,
        error_code: custodyError.code ?? null,
      });
    }

    const balanceByProduct = new Map<string, number>();
    const summaryByProduct = new Map(summarizeRouteInventoryMovements(routeMovements).map((row) => [row.productId, row]));

    const allCustodyItems: CustodyItem[] = (authoritativeCustodyRows as CustodyBalanceRow[]).map((row): CustodyItem => {
      const productId = String(row.product_id ?? "");
      const bagOwnerId = row.bag_owner_id ? String(row.bag_owner_id) : null;
      const rawQuantity = Number(row.signed_quantity ?? 0);
      const signedQuantity = Number.isFinite(rawQuantity) ? rawQuantity : 0;
      if (productId) {
        balanceByProduct.set(productId, (balanceByProduct.get(productId) ?? 0) + signedQuantity);
      }
      return {
        productId,
        bagOwnerId,
        signedQuantity,
        quantity: Math.max(0, signedQuantity),
      };
    }).filter((item: { productId: string }) => item.productId);
    const custodyItems = allCustodyItems.filter((item) => item.signedQuantity !== 0);

    // The snapshot includes every historical route bag key, including net-zero
    // rows. Keep that exact key set for physical confirmation; rebuilding it
    // from a separate raw movement query would create a stale-count race.
    const bagHistoryItems = allCustodyItems;

    const productIds = Array.from(new Set([
      ...custodyItems.map((item) => item.productId),
      ...bagHistoryItems.map((item) => item.productId),
      ...summaryByProduct.keys(),
    ]));
    const activeProductById = new Map(activeProductOptions.map((product) => [product.id, product]));
    const missingReferencedProductIds = productIds.filter((productId) => !activeProductById.has(productId));
    const serverOnlyClient = getSupabaseAdminClient();
    const protectedReadClient = serverOnlyClient ?? supabase;
    const { data: products, error: productError } = missingReferencedProductIds.length
      ? await protectedReadClient.from("products").select("id, name, sku").in("id", missingReferencedProductIds)
      : { data: [], error: null };
    if (productError) throw productError;
    const productById = new Map(activeProductOptions.map((product) => [product.id, product.name]));
    for (const product of products ?? []) {
      productById.set(String(product.id), String(product.name ?? "Unknown Product"));
    }

    const bagOwnerIds = Array.from(new Set([
      ...custodyItems.map((item) => item.bagOwnerId),
      ...bagHistoryItems.map((item) => item.bagOwnerId),
      route.operator_id,
    ].map((ownerId) => String(ownerId ?? "")).filter(Boolean)));
    const { data: bagOwnerRows, error: bagOwnerError } = bagOwnerIds.length
      ? await protectedReadClient.from("team_members").select("id, full_name").in("id", bagOwnerIds)
      : { data: [], error: null };
    if (bagOwnerError) throw bagOwnerError;
    const bagOwnerNameById = new Map(((bagOwnerRows ?? []) as BagOwnerRow[]).map((owner) => [
      String(owner.id ?? ""),
      String(owner.full_name ?? "").trim() || null,
    ]));
    if (profile?.team_member_id && profile.full_name) {
      bagOwnerNameById.set(String(profile.team_member_id), String(profile.full_name));
    }

    let stopCompletionReceiptCheckAvailable = Boolean(serverOnlyClient);
    let pendingStopIds: string[] = [];
    if (serverOnlyClient) {
      const { data: pendingReceiptRows, error: pendingReceiptError } = await serverOnlyClient
        .from("route_stop_inventory_commits")
        .select("route_stop_id, committed_at")
        .eq("route_id", routeId)
        .is("workflow_completed_at", null)
        .order("committed_at", { ascending: true });
      if (pendingReceiptError) {
        stopCompletionReceiptCheckAvailable = false;
        console.warn("[operator:route-leftovers] Stop completion receipt readiness could not be verified; finalization remains locked", {
          route_id: routeId,
          migration_missing: isMissingTable(pendingReceiptError, "route_stop_inventory_commits"),
          error_code: pendingReceiptError.code ?? null,
        });
      } else {
        pendingStopIds = Array.from(new Set((pendingReceiptRows ?? [])
          .map((receipt) => String(receipt.route_stop_id ?? "").trim())
          .filter(Boolean)));
      }
    } else {
      console.warn("[operator:route-leftovers] Protected stop completion receipt client is unavailable; finalization remains locked", {
        route_id: routeId,
      });
    }

    const routeStopStatusRows = (routeStopRows ?? []) as RouteStopStatusRow[];
    const machineIds = Array.from(new Set(routeStopStatusRows
      .map((stop) => String(stop.machine_id ?? "").trim())
      .filter(Boolean)));
    const { data: machineRows, error: machineContextError } = machineIds.length
      ? await protectedReadClient
          .from("machines")
          .select("id, name, machine_code, location:locations(name)")
          .in("id", machineIds)
      : { data: [], error: null };
    if (machineContextError) {
      console.warn("[operator:route-leftovers] Machine context could not be loaded for the terminal count header", {
        route_id: routeId,
        error_code: machineContextError.code ?? null,
      });
    }
    const machineById = new Map(((machineRows ?? []) as MachineContextRow[]).map((machine) => [
      String(machine.id ?? ""),
      machine,
    ]));
    const stopSummaries = routeStopStatusRows.map((stop) => {
      const machineId = String(stop.machine_id ?? "").trim();
      const machine = machineById.get(machineId);
      const locationRelation = Array.isArray(machine?.location) ? machine?.location[0] : machine?.location;
      return {
        id: String(stop.id ?? ""),
        machineId: machineId || null,
        machineName: String(machine?.name ?? "").trim() || null,
        machineCode: String(machine?.machine_code ?? "").trim() || null,
        locationName: String(locationRelation?.name ?? "").trim() || null,
        stopOrder: Math.max(0, Number(stop.stop_order ?? 0)),
        status: String(stop.status ?? ""),
      };
    });

    const activeReturnStorageIds = new Set(returnStorageOptions.map((storage) => storage.id));
    const pickupOriginIds = Array.from(new Set(routeMovements
      .filter((movement) => (
        normalizeInventoryEntityType(movement.from_entity_type) === "storage"
        && normalizeInventoryEntityType(movement.to_entity_type) === "operator_bag"
        && movement.from_entity_id
      ))
      .map((movement) => String(movement.from_entity_id))
      .filter((storageId) => activeReturnStorageIds.has(storageId))));
    const suggestedStorageLocationId = pickupOriginIds.length === 1
      ? pickupOriginIds[0]
      : pickupOriginIds.length === 0 && returnStorageOptions.length === 1
        ? returnStorageOptions[0].id
        : null;

    const items = custodyItems.map((item) => ({
      productId: item.productId,
      productName: productById.get(item.productId) ?? "Unknown Product",
      quantity: item.quantity,
      signedQuantity: item.signedQuantity,
      bagOwnerId: item.bagOwnerId,
      bagOwnerName: item.bagOwnerId ? bagOwnerNameById.get(item.bagOwnerId) ?? null : null,
    })).sort((a, b) => a.productName.localeCompare(b.productName));
    const historyItems = bagHistoryItems.map((item) => ({
      productId: item.productId,
      productName: productById.get(item.productId) ?? "Unknown Product",
      quantity: item.quantity,
      signedQuantity: item.signedQuantity,
      bagOwnerId: item.bagOwnerId,
      bagOwnerName: item.bagOwnerId ? bagOwnerNameById.get(item.bagOwnerId) ?? null : null,
    })).sort((a, b) => a.productName.localeCompare(b.productName));
    const reconciliation = Array.from(summaryByProduct.values())
      .map((row) => ({
        ...row,
        adjustmentQty: row.adjustmentInQty - row.adjustmentOutQty,
        productName: productById.get(row.productId) ?? "Unknown Product",
        remainingQty: balanceByProduct.get(row.productId) ?? 0,
      }))
      .filter((row) => [
        row.loadedQty,
        row.filledQty,
        row.returnedQty,
        row.damagedQty,
        row.soldQty,
        row.compensatedQty,
        row.machineStorageQty,
        row.machineReturnQty,
        row.adjustmentQty,
        row.remainingQty,
      ].some((value) => value !== 0))
      .sort((a, b) => a.productName.localeCompare(b.productName));

    const routeStatus = String(route.status ?? "");
    const stopStatuses = routeStopStatusRows.map((stop) => String(stop.status ?? ""));
    const unfinishedStopCount = stopStatuses.filter((status) => !isRouteStopDoneStatus(status)).length;
    const routeIsTerminal = isTerminalRouteStatus(routeStatus);
    const pendingStopId = pendingStopIds[0] ?? null;
    const routeReadyForCompletion = Boolean(route.operator_id)
      && isRouteInventoryFinalizableStatus(routeStatus)
      && stopStatuses.length > 0
      && pendingStopIds.length === 0
      && unfinishedStopCount === 0;
    const isManager = isAdminRole(routeAccessProfile);
    const canCancel = isManager && !routeIsTerminal;
    const assignedBagOwnerId = route.operator_id ? String(route.operator_id) : null;
    const hasUnassignedCustody = bagHistoryItems.some((item) => !item.bagOwnerId);
    const requiresManagerReconciliation = Boolean(assignedBagOwnerId)
      && bagHistoryItems.some((item) => item.bagOwnerId && item.bagOwnerId !== assignedBagOwnerId)
      && !isManager;
    const inventoryFinalizationBlockCode = !ledgerToken || !inventoryCountOptionsAvailable || !stopCompletionReceiptCheckAvailable
      ? "SERVICES_UNAVAILABLE"
      : hasUnassignedCustody
        ? "UNASSIGNED_CUSTODY"
        : requiresManagerReconciliation
          ? "MANAGER_RECONCILIATION_REQUIRED"
          : null;
    const completionReadinessCode = routeIsTerminal
      ? "ROUTE_TERMINAL"
      : !route.operator_id
        ? "ROUTE_UNASSIGNED"
        : !isRouteInventoryFinalizableStatus(routeStatus)
          ? "ROUTE_NOT_ACTIVE"
          : stopStatuses.length === 0
            ? "ROUTE_HAS_NO_STOPS"
            : pendingStopId
              ? "STOP_INVENTORY_COMMIT_PENDING"
              : unfinishedStopCount > 0
                ? "ROUTE_STOPS_UNFINISHED"
                : null;

    return noStoreJson({
      items,
      bagHistoryItems: historyItems,
      activeProductOptions,
      assignedBagOwnerId,
      assignedBagOwnerName: assignedBagOwnerId ? bagOwnerNameById.get(assignedBagOwnerId) ?? null : null,
      ledgerToken,
      inventoryFinalizationAvailable: inventoryFinalizationBlockCode === null,
      inventoryFinalizationBlockCode,
      inventoryCountOptionsAvailable,
      hasUnassignedCustody,
      requiresManagerReconciliation,
      stopCompletionReceiptCheckAvailable,
      pendingStopId,
      pendingStopIds,
      reconciliation,
      descriptiveReconciliationAvailable: !routeMovementsError,
      returnStorageOptions,
      suggestedStorageLocationId,
      requiresStorageSelection: returnStorageOptions.length > 1 && suggestedStorageLocationId === null,
      routeStatus,
      routeIsTerminal,
      routeReadyForCompletion,
      canCancel,
      managerRouteAccess: isManager,
      routeDate: route.route_date ? String(route.route_date) : null,
      routeReference: String(route.id).slice(0, 8).toUpperCase(),
      stopSummaries,
      totalStopCount: stopStatuses.length,
      unfinishedStopCount,
      completionReadinessCode,
    });
  } catch (error) {
    console.error("Error fetching picked items:", error);
    return noStoreJson(
      { error: "Failed to fetch picked items", details: process.env.NODE_ENV === "development" ? errorMessage(error) : undefined },
      500,
    );
  }
}
