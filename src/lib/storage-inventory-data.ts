import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readCompleteList } from "@/lib/complete-list-read";
import { buildPhysicalStorageBalances, type StorageBalance, type StorageProduct, type StorageProductBalance } from "@/lib/storage-inventory-model";
const ROW_LIMIT = 20000;
export type PhysicalStorageLoadResult =
  | { ok: true; items: StorageProductBalance[]; minimumThresholdsVerified: boolean }
  | { ok: false; items: []; error: string };
/** Read-only balances, not a certificate of a physical count. Catalog and ledger
 * read in parallel. Paginate beyond the API row cap; fail closed on partial data.
 * No global cache, ledger repair, stock mutation, sales or XY dependency. */
export async function loadPhysicalStorageData(client: SupabaseClient): Promise<PhysicalStorageLoadResult> {
  const signal = AbortSignal.timeout(10000);
  const catalog = (legacy = false) => readCompleteList<StorageProduct>(
    ({ from, to, signal }) => {
      // Keep each select literal separate so PostgREST's type parser can infer
      // both shapes. The legacy shape intentionally omits the optional minimum.
      const query = legacy
        ? client.from("products").select("id,name,sku,category,brand,case_quantity,active", { count: "exact" })
        : client.from("products").select("id,name,sku,category,brand,case_quantity,min_storage_qty,active", { count: "exact" });
      return query.order("id").range(from, to).abortSignal(signal);
    },
    { key: row => row.id, maxRows: ROW_LIMIT, signal },
  );
  const stockRead = readCompleteList<StorageBalance>(
    ({ from, to, signal }) => client.from("route_storage_stock_by_product")
      .select("product_id,quantity_on_hand", { count: "exact" })
      .order("product_id").range(from, to).abortSignal(signal),
    { key: row => String(row.product_id ?? ''), maxRows: ROW_LIMIT, signal },
  );
  const [initialProducts, stock] = await Promise.all([catalog(), stockRead]);
  let products = initialProducts;
  let minimumThresholdsVerified = true;
  if (products.error && /min_storage_qty/i.test(products.error.message)
      && ["42703", "PGRST204"].includes(products.error.code ?? '')) {
    minimumThresholdsVerified = false;
    products = await catalog(true);
  }
  if (products.error) return { ok: false, items: [], error: `Product catalog unavailable: ${products.error.message}` };
  if (stock.error) return { ok: false, items: [], error: `Storage movement ledger unavailable: ${stock.error.message}` };
  if (products.count !== products.data.length || stock.count !== stock.data.length) {
    return { ok: false, items: [], error: 'Complete ledger balances could not be verified.' };
  }
  try {
    return { ok: true, items: buildPhysicalStorageBalances(products.data, stock.data), minimumThresholdsVerified };
  } catch (error) {
    return { ok: false, items: [], error: error instanceof Error ? error.message : 'Invalid physical ledger balance' };
  }
}
