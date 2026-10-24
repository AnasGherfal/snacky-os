import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  computeStorageOverview, type StorageOverview, type StorageProduct, type StorageLocation,
  type StorageBalance, type StorageReservationLine, type StorageStopNeed,
} from "@/lib/storage-overview";

type SupabaseLike = { from: (name: string) => any };
type Result<T> = { data: T[] | null; error: { message: string } | null };
const routeStatuses = ["draft", "assigned", "in_progress", "pickup_confirmed", "available", "ready", "started", "filling", "machine_filling"];

/** Read-only, deliberately small Storage loader. A missing reservation query never claims stock is available. */
export async function loadStorageOverview(userClient: SupabaseLike): Promise<{
  overview: StorageOverview;
  reservationWarning: string | null;
}> {
  // Caller must authorize /inventory before invoking this server-only method.
  const db = getSupabaseAdminClient() ?? userClient;
  const [products, locations, balances, routes, stops] = await Promise.all([
    db.from("products").select("id,name,sku,category,brand,active,case_quantity,min_storage_qty")
      .order("name").limit(2000) as PromiseLike<Result<StorageProduct>>,
    db.from("storage_locations").select("id,name,active").limit(250) as PromiseLike<Result<StorageLocation>>,
    db.from("current_inventory_by_location").select("product_id,location_id,quantity_on_hand")
      .eq("location_type", "storage").limit(5000) as PromiseLike<Result<StorageBalance>>,
    db.from("route_stock_lines").select("route_id,product_id,planned_qty,picked_qty,routes!inner(id,route_date,status)")
      .in("routes.status", routeStatuses).limit(1000) as PromiseLike<Result<StorageReservationLine>>,
    db.from("route_stop_items").select("route_id,product_id,planned_quantity,routes!inner(id,route_date,status)")
      .in("routes.status", routeStatuses).limit(2000) as PromiseLike<Result<StorageStopNeed>>,
  ]);
  if (products.error || !products.data || products.data.length >= 2000) throw Error("Product catalog could not be completely verified.");
  if (locations.error || !locations.data || locations.data.length >= 250) throw Error("Active storage locations could not be verified.");
  if (balances.error || !balances.data || balances.data.length >= 5000) throw Error("Physical storage ledger is unavailable or incomplete.");
  const reservationsVerified = !routes.error && !stops.error
    && Array.isArray(routes.data) && Array.isArray(stops.data)
    && routes.data.length < 1000 && stops.data.length < 2000;
  const overview = computeStorageOverview({
    products: products.data,
    locations: locations.data,
    balances: balances.data,
    routeLines: reservationsVerified ? routes.data ?? [] : [],
    stopNeeds: reservationsVerified ? stops.data ?? [] : [],
    reservationsVerified,
  });
  return {
    overview,
    reservationWarning: reservationsVerified ? null
      : "Active route reservations could not be completely verified; available-to-pick quantities are hidden.",
  };
}
