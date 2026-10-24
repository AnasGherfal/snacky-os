import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import {
  buildPhysicalStorageBalances,
  type StorageBalance,
  type StorageProduct,
  type StorageProductBalance,
} from "@/lib/storage-inventory-model";

const ROW_LIMIT = 5001;

export type PhysicalStorageLoadResult =
  | { ok: true; items: StorageProductBalance[]; minimumThresholdsVerified: boolean }
  | { ok: false; items: []; error: string };

/**
 * Read-only physical Storage loader. No sales data, no XY snapshot, no route
 * stock repair and no inventory write. A failed or truncated ledger query is
 * surfaced as unavailable, never a fake empty/zero balance.
 */
export async function loadPhysicalStorageData(client: SupabaseClient): Promise<PhysicalStorageLoadResult> {
  let products = await safeSupabaseQuery<StorageProduct>({
    label: "storage.catalog",
    promise: client.from("products")
      .select("id,name,sku,category,brand,case_quantity,min_storage_qty,active", { count: "exact" })
      .order("name")
      .limit(ROW_LIMIT),
  });
  let minimumThresholdsVerified = true;
  if (products.error && /min_storage_qty/i.test(products.error)) {
    // Older environments can still expose physical quantities safely without
    // incorrectly labeling a product low against an unknown minimum.
    minimumThresholdsVerified = false;
    products = await safeSupabaseQuery<StorageProduct>({
      label: "storage.catalog.legacy-minimum-fallback",
      promise: client.from("products")
        .select("id,name,sku,category,brand,case_quantity,active", { count: "exact" })
        .order("name")
        .limit(ROW_LIMIT),
    });
  }
  if (products.error) return { ok: false, items: [], error: `Product catalog unavailable: ${products.error}` };
  if (products.data.length >= ROW_LIMIT || products.count > products.data.length) return { ok: false, items: [], error: "Product catalog read is incomplete" };

  const stock = await safeSupabaseQuery<StorageBalance>({
    label: "storage.physical-ledger",
    promise: client.from("route_storage_stock_by_product")
      .select("product_id,quantity_on_hand", { count: "exact" })
      .limit(ROW_LIMIT),
  });
  if (stock.error) return { ok: false, items: [], error: `Physical ledger unavailable: ${stock.error}` };
  if (stock.data.length >= ROW_LIMIT || stock.count > stock.data.length) return { ok: false, items: [], error: "Physical ledger read is incomplete" };

  try {
    return {
      ok: true,
      items: buildPhysicalStorageBalances(products.data, stock.data),
      minimumThresholdsVerified,
    };
  } catch (error) {
    return { ok: false, items: [], error: error instanceof Error ? error.message : "Invalid physical ledger balance" };
  }
}
