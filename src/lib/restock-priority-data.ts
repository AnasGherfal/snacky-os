import "server-only";
import { supabaseQueryErrorMessage } from "@/lib/safe-supabase-query";
import { readCompleteList, type ListPageRequest } from "@/lib/complete-list-read";
import { ROUTE_RESERVATION_STATUSES } from "@/lib/route-workflow";
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
  storageLoaded: boolean;
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

// Report loading is strictly read-only. Repairs require an explicit audited command.
async function complete<T>(
  fetch: (page: ListPageRequest) => PromiseLike<any>,
  key: (row: T) => string,
  signal: AbortSignal,
) {
  const result = await readCompleteList<T>(fetch, { key, signal, maxRows: 20000 });
  return result.error
    ? { data: [] as T[], count: 0, error: supabaseQueryErrorMessage(result.error) }
    : { data: result.data, count: result.count, error: null as string | null };
}
async function loadProducts(supabase: SupabaseLike, errors: Record<string, string>, signal: AbortSignal) {
  const baseSelect = "id,sku,barcode,name,category,brand,active,image_url,current_cost_price_lyd,last_purchase_cost_lyd,average_cost_lyd,last_purchase_date";
  const catalog = (legacy = false) => readCompleteList<RestockProductInput>(
    ({from,to,signal}) => supabase.from("products")
      .select(legacy ? baseSelect : [baseSelect,...restockProductColumns].join(","), {count:"exact"})
      .eq("active",true).order("id").range(from,to).abortSignal(signal),
    {key:row=>row.id,signal,maxRows:20000},
  );
  let result = await catalog();
  let usedFallback = false;
  if (result.error && isMissingRestockColumn(result.error)) {
    usedFallback = true;
    errors.productRestockColumns = "Product restock fields are unavailable. Manual thresholds were not used.";
    result = await catalog(true);
  }
  if (result.error) errors.products = supabaseQueryErrorMessage(result.error);
  return {products:result.data ?? [],usedFallback};
}

export async function loadRestockPriorityData(
  supabase: SupabaseLike,
  options: {
    salesQueryTimeoutMs?: number;
    /** @deprecated Kept for caller compatibility; report reads never write repairs. */
    repairMissingRouteStockLines?: boolean;
    recommendationsPromise?: PromiseLike<RestockRecommendationRow[]>;
  } = {},
): Promise<RestockPriorityLoadResult> {
  const errors: Record<string, string> = {};
  // Every caller authorizes its page before reaching this server-only helper.
  // Use one protected read client for the internal operational aggregates so
  // security-invoker views do not repeat profile-policy lookups thousands of
  // times and hit PostgREST's statement timeout. If the protected client is
  // unavailable, the caller-scoped client and its RLS policies remain valid.
  const inventoryReadClient = getSupabaseAdminClient() ?? supabase;
  const signal = AbortSignal.timeout(10000);
  const productsPromise = loadProducts(inventoryReadClient, errors, signal);
  const activeStatuses = [...ROUTE_RESERVATION_STATUSES, "available", "ready", "started", "filling", "machine_filling", "partially_completed", "stop_completed"];
  const monthParts = new Intl.DateTimeFormat("en-GB", {timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit"}).formatToParts(new Date());
  const salesMonth = `${monthParts.find(p=>p.type==="year")?.value}-${monthParts.find(p=>p.type==="month")?.value}-01`;
  const salesSignal = options.salesQueryTimeoutMs
    ? AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(10000,options.salesQueryTimeoutMs)))])
    : signal;
  const recommendationsPromise = options.recommendationsPromise
    ? Promise.resolve(options.recommendationsPromise).then(data=>({data,count:data.length,error:null as string|null}))
    : complete<RestockRecommendationRow & {recommendation_key:string}>(
        ({from,to,signal})=>inventoryReadClient.from("refill_recommendations")
          .select("recommendation_key,product_id,product_name,machine_id,machine_name,current_qty,suggested_qty,final_qty_to_take,priority",{count:"exact"})
          .order("recommendation_key").range(from,to).abortSignal(signal), row=>row.recommendation_key,signal);

  const [{products,usedFallback},storage,recommendations,routeNeeds,routeStopNeeds,machineSlots,vmsStock,sales] = await Promise.all([
    productsPromise,
    complete<RestockStorageRow>(
      ({from,to,signal})=>inventoryReadClient.from("route_storage_stock_by_product")
        .select("product_id,quantity_on_hand",{count:"exact"}).order("product_id").range(from,to).abortSignal(signal),
      row=>String(row.product_id??""),signal),
    recommendationsPromise,
    complete<any>(
      ({from,to,signal})=>inventoryReadClient.from("route_stock_lines")
        .select("id,route_id,product_id,planned_qty,picked_qty,routes!inner(status,route_date)",{count:"exact"})
        .in("routes.status",activeStatuses).order("id").range(from,to).abortSignal(signal),row=>row.id,signal),
    complete<any>(
      ({from,to,signal})=>inventoryReadClient.from("route_stop_items")
        .select("id,route_id,product_id,planned_quantity,routes!inner(status,route_date)",{count:"exact"})
        .in("routes.status",activeStatuses).order("id").range(from,to).abortSignal(signal),row=>row.id,signal),
    complete<any>(
      ({from,to,signal})=>inventoryReadClient.from("machine_slots")
        .select("id,product_id,machine_id,active,machine:machines!machine_slots_machine_id_fkey(id,name,machine_code,status)",{count:"exact"})
        .eq("active",true).order("id").range(from,to).abortSignal(signal),row=>row.id,signal),
    complete<any>(
      ({from,to,signal})=>inventoryReadClient.from("latest_vms_stock_by_slot")
        .select("id,product_id,machine_id,current_qty,capacity",{count:"exact"})
        .order("id").range(from,to).abortSignal(signal),row=>row.id,signal),
    complete<RestockSalesRow>(
      ({from,to,signal})=>inventoryReadClient.from("kpi_product_monthly")
        .select("product_id,product_name,sales_month,units_sold,stock_velocity_units_per_day",{count:"exact"})
        .eq("sales_month",salesMonth).order("product_id").range(from,to).abortSignal(signal),
      row=>String(row.product_id??""),salesSignal),
  ]);
  Object.entries({storage:storage.error,recommendations:recommendations.error,routeNeeds:routeNeeds.error,routeStopNeeds:routeStopNeeds.error,machineSlots:machineSlots.error,vmsStock:vmsStock.error,salesVelocity:sales.error})
    .forEach(([key,error])=>{if(error) errors[key]=error;});
  // A failed stock/catalog read is not an empty warehouse and must never suggest buying everything.
  if (errors.products || storage.error) return {items:[],errors,productCount:products.length,storageLoaded:false,usedProductFallback:usedFallback};

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
  if (stopFallbackByRouteProduct.size > 0) {
    errors.routeStockRepair = `${stopFallbackByRouteProduct.size} route/product summaries are missing. Planning uses a read-only fallback; no route records were repaired by opening this report.`;
  }

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
    storageLoaded: !storage.error,
    usedProductFallback: usedFallback,
  };
}
