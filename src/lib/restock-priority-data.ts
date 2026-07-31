import "server-only";
import { safeSupabaseQuery, supabaseQueryErrorMessage } from "@/lib/safe-supabase-query";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  computeRestockPriority,
  type RestockMachineSlotRow,
  type RestockPriorityItem,
  type RestockProductInput,
  type RestockRecommendationRow,
  type RestockRouteNeedRow,
  type RestockSalesRow,
  type RestockStorageRow,
  type RestockVmsStockRow,
} from "@/lib/restock-priority";

type SupabaseLike = {
  from: (table: string) => any;
};

export type RestockPriorityLoadResult = {
  items: RestockPriorityItem[];
  errors: Record<string, string>;
  productCount: number;
  usedProductFallback: boolean;
};

const restockProductColumns = ["restock_priority", "min_storage_qty", "target_storage_qty", "reorder_point", "reorder_qty"];

function errorText(error: unknown) {
  return supabaseQueryErrorMessage(error).toLowerCase();
}

function isMissingRestockColumn(error: unknown) {
  const text = errorText(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return restockProductColumns.some((column) => text.includes(column));
}

function relationRow(value: unknown) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function routeProductKey(routeId: unknown, productId: unknown) {
  const route = String(routeId ?? "").trim();
  const product = String(productId ?? "").trim();
  return route && product ? `${route}:${product}` : "";
}

function positiveWhole(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

async function loadProducts(supabase: SupabaseLike, errors: Record<string, string>) {
  const baseSelect = [
    "id",
    "sku",
    "barcode",
    "name",
    "category",
    "brand",
    "active",
    "image_url",
    "current_cost_price_lyd",
    "last_purchase_cost_lyd",
    "average_cost_lyd",
    "last_purchase_date",
  ].join(",");
  const restockSelect = [baseSelect, ...restockProductColumns].join(",");

  try {
    const result = await supabase.from("products").select(restockSelect).eq("active", true).order("name").limit(5000);
    if (!result.error) return { products: (result.data ?? []) as RestockProductInput[], usedFallback: false };

    if (!isMissingRestockColumn(result.error)) {
      errors.products = supabaseQueryErrorMessage(result.error);
      console.error("[restock-priority] Product query failed", { select: restockSelect, error: result.error });
      return { products: [] as RestockProductInput[], usedFallback: false };
    }

    errors.productRestockColumns = "Product restock fields are not applied yet. Using storage and VMS signals without manual thresholds.";
    console.warn("[restock-priority] Product restock columns missing; using fallback product select", { error: result.error });
  } catch (error) {
    if (!isMissingRestockColumn(error)) {
      errors.products = supabaseQueryErrorMessage(error);
      console.error("[restock-priority] Product query threw", { select: restockSelect, error });
      return { products: [] as RestockProductInput[], usedFallback: false };
    }
    errors.productRestockColumns = "Product restock fields are not applied yet. Using storage and VMS signals without manual thresholds.";
    console.warn("[restock-priority] Product restock columns missing; using fallback product select", { error });
  }

  const fallback = await safeSupabaseQuery<RestockProductInput>({
    label: "restock-priority.products.fallback",
    promise: supabase.from("products").select(baseSelect).eq("active", true).order("name").limit(5000),
  });
  if (fallback.error) errors.products = fallback.error;
  return { products: fallback.data, usedFallback: true };
}

async function repairMissingRouteStockLines({
  routeNeeds,
  routeStopNeeds,
  errors,
}: {
  routeNeeds: any[];
  routeStopNeeds: any[];
  errors: Record<string, string>;
}) {
  const existingKeys = new Set(routeNeeds.map((row) => routeProductKey(row.route_id, row.product_id)).filter(Boolean));
  const missingByKey = new Map<string, { route_id: string; product_id: string; planned_qty: number }>();

  routeStopNeeds.forEach((row) => {
    const key = routeProductKey(row.route_id, row.product_id);
    if (!key || existingKeys.has(key)) return;
    const routeId = String(row.route_id ?? "").trim();
    const productId = String(row.product_id ?? "").trim();
    const plannedQty = positiveWhole(row.planned_quantity);
    if (!routeId || !productId || plannedQty <= 0) return;
    const current = missingByKey.get(key);
    missingByKey.set(key, {
      route_id: routeId,
      product_id: productId,
      planned_qty: (current?.planned_qty ?? 0) + plannedQty,
    });
  });

  const rows = Array.from(missingByKey.values()).filter((row) => row.planned_qty > 0);
  if (!rows.length) return;

  const repairClient = getSupabaseAdminClient();
  if (!repairClient) {
    errors.routeStockRepair = "Some routes have product assignments but no route stock summary. Database admin access is unavailable for automatic repair.";
    return;
  }

  const payload = rows.map((row) => ({ ...row, picked_qty: 0, returned_qty: 0, updated_at: new Date().toISOString() }));
  const { error } = await repairClient.from("route_stock_lines").upsert(payload, {
    onConflict: "route_id,product_id",
    ignoreDuplicates: true,
  });

  if (error) {
    errors.routeStockRepair = `Could not repair missing route stock summaries: ${supabaseQueryErrorMessage(error)}`;
    console.error("[restock-priority] Missing route stock summary repair failed", { rows: payload.length, error });
  }
}

export async function loadRestockPriorityData(supabase: SupabaseLike): Promise<RestockPriorityLoadResult> {
  const errors: Record<string, string> = {};
  const { products, usedFallback } = await loadProducts(supabase, errors);

  const [storage, recommendations, routeNeeds, routeStopNeeds, machineSlots, vmsStock, sales] = await Promise.all([
    safeSupabaseQuery<RestockStorageRow>({
      label: "restock-priority.current_inventory_by_location.storage",
      promise: supabase.from("current_inventory_by_location").select("product_id, product_name, quantity_on_hand").eq("location_type", "storage").limit(10000),
    }),
    safeSupabaseQuery<any>({
      label: "restock-priority.refill_recommendations",
      promise: supabase.from("refill_recommendations").select("product_id, product_name, machine_id, machine_name, current_qty, suggested_qty, final_qty_to_take, priority").limit(10000),
    }),
    safeSupabaseQuery<any>({
      label: "restock-priority.route_stock_lines.active",
      promise: supabase.from("route_stock_lines").select("route_id, product_id, planned_qty, picked_qty, routes!inner(status, route_date)").limit(10000),
    }),
    safeSupabaseQuery<any>({
      label: "restock-priority.route_stop_items.active-fallback",
      promise: supabase.from("route_stop_items").select("route_id, product_id, planned_quantity, routes!inner(status, route_date)").limit(20000),
    }),
    safeSupabaseQuery<any>({
      label: "restock-priority.machine_slots",
      promise: supabase.from("machine_slots").select("product_id, machine_id, active, machine:machines!machine_slots_machine_id_fkey(id, name, machine_code, status)").eq("active", true).limit(10000),
    }),
    safeSupabaseQuery<any>({
      label: "restock-priority.latest_vms_stock_by_slot",
      promise: supabase.from("latest_vms_stock_by_slot").select("product_id, machine_id, current_qty, capacity").limit(10000),
    }),
    safeSupabaseQuery<RestockSalesRow>({
      label: "restock-priority.kpi_product_monthly",
      promise: supabase.from("kpi_product_monthly").select("product_id, product_name, sales_month, units_sold, stock_velocity_units_per_day").order("sales_month", { ascending: false }).limit(2000),
    }),
  ]);

  Object.entries({ storage: storage.error, recommendations: recommendations.error, routeNeeds: routeNeeds.error, routeStopNeeds: routeStopNeeds.error, machineSlots: machineSlots.error, vmsStock: vmsStock.error, salesVelocity: sales.error })
    .forEach(([key, error]) => { if (error) errors[key] = error; });

  if (!routeNeeds.error && !routeStopNeeds.error) {
    await repairMissingRouteStockLines({ routeNeeds: routeNeeds.data ?? [], routeStopNeeds: routeStopNeeds.data ?? [], errors });
  }

  const normalizedMachineSlots: RestockMachineSlotRow[] = (machineSlots.data ?? []).map((row: any) => ({
    product_id: row.product_id,
    machine_id: row.machine_id,
    active: row.active,
    machine_name: row.machine?.name ?? null,
    machine_code: row.machine?.machine_code ?? null,
  }));
  const machineNameById = new Map<string, string>();
  normalizedMachineSlots.forEach((row) => {
    if (row.machine_id && (row.machine_name || row.machine_code)) machineNameById.set(row.machine_id, row.machine_name ?? row.machine_code ?? row.machine_id);
  });

  const normalizedRecommendations: RestockRecommendationRow[] = (recommendations.data ?? []).map((row: any) => ({
    product_id: row.product_id,
    product_name: row.product_name,
    machine_id: row.machine_id,
    machine_name: row.machine_name ?? (row.machine_id ? machineNameById.get(row.machine_id) : null),
    current_qty: row.current_qty,
    suggested_qty: row.suggested_qty,
    final_qty_to_take: row.final_qty_to_take,
    priority: row.priority,
  }));

  const routeStockKeys = new Set<string>();
  const normalizedRouteNeeds: RestockRouteNeedRow[] = (routeNeeds.data ?? []).map((row: any) => {
    const key = routeProductKey(row.route_id, row.product_id);
    if (key) routeStockKeys.add(key);
    const route = relationRow(row.routes);
    return {
      product_id: row.product_id,
      planned_qty: row.planned_qty,
      picked_qty: row.picked_qty,
      route_status: route?.status == null ? null : String(route.status),
      route_date: route?.route_date == null ? null : String(route.route_date),
    };
  });

  const stopFallbackByRouteProduct = new Map<string, RestockRouteNeedRow>();
  (routeStopNeeds.data ?? []).forEach((row: any) => {
    const key = routeProductKey(row.route_id, row.product_id);
    if (!key || routeStockKeys.has(key)) return;
    const route = relationRow(row.routes);
    const current = stopFallbackByRouteProduct.get(key);
    stopFallbackByRouteProduct.set(key, {
      product_id: row.product_id,
      planned_qty: Number(current?.planned_qty ?? 0) + positiveWhole(row.planned_quantity),
      picked_qty: 0,
      route_status: route?.status == null ? null : String(route.status),
      route_date: route?.route_date == null ? null : String(route.route_date),
    });
  });
  normalizedRouteNeeds.push(...stopFallbackByRouteProduct.values());

  const normalizedVmsStock: RestockVmsStockRow[] = (vmsStock.data ?? []).map((row: any) => ({
    product_id: row.product_id,
    machine_id: row.machine_id,
    machine_name: row.machine_id ? machineNameById.get(row.machine_id) ?? null : null,
    current_qty: row.current_qty,
    capacity: row.capacity,
  }));

  return {
    items: computeRestockPriority({
      products,
      storageRows: storage.data,
      recommendations: normalizedRecommendations,
      routeNeeds: normalizedRouteNeeds,
      machineSlots: normalizedMachineSlots,
      vmsStockRows: normalizedVmsStock,
      salesRows: sales.data,
    }),
    errors,
    productCount: products.length,
    usedProductFallback: usedFallback,
  };
}
