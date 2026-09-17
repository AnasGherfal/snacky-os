import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import {
  computePurchaseList,
  type PurchaseListItem,
  type PurchaseListPeriod,
  type PurchaseListProduct,
  type PurchaseListSalesRow,
  type PurchaseListStorageRow,
} from "@/lib/purchase-list";

type SupabaseLike = { from: (table: string) => any };

type BatchRow = {
  id: string;
  report_start_date: string | null;
  report_end_date: string | null;
  uploaded_at: string | null;
  is_active?: boolean | null;
  status?: string | null;
};

type ProfitRow = {
  import_batch_id?: string | null;
  internal_product_id?: string | null;
  business_month?: string | null;
  transaction_count?: number | string | null;
};

export type PurchaseListLoadResult = {
  items: PurchaseListItem[];
  previousPeriod: PurchaseListPeriod | null;
  currentPeriod: PurchaseListPeriod | null;
  previousBatch: BatchRow | null;
  currentBatch: BatchRow | null;
  errors: Record<string, string>;
  unmappedSalesRows: number;
  unmappedSalesUnits: number;
  productCount: number;
  storageLoaded: boolean;
};

function tripoliDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function isoDate(year: number, month: number, day: number) {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function monthBounds(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: isoDate(year, month, 1), end: isoDate(year, month, lastDay), days: lastDay };
}

function previousMonth(year: number, month: number) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function daysInclusive(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return 0;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

function chooseBatch(rows: BatchRow[], monthStart: string) {
  return rows
    .filter((row) => String(row.report_start_date ?? "").slice(0, 7) === monthStart.slice(0, 7))
    .sort((a, b) => String(b.uploaded_at ?? "").localeCompare(String(a.uploaded_at ?? "")))[0] ?? null;
}

function periodFromBatch(batch: BatchRow | null, fallback: { start: string; end: string; days: number }): PurchaseListPeriod | null {
  if (!batch) return null;
  const start = batch.report_start_date || fallback.start;
  const end = batch.report_end_date || fallback.end;
  const coveredDays = daysInclusive(start, end);
  if (coveredDays <= 0) return null;
  return { start, end, coveredDays, daysInMonth: fallback.days };
}

export async function loadPurchaseListData(supabase: SupabaseLike, coverageTargetDays: number): Promise<PurchaseListLoadResult> {
  const errors: Record<string, string> = {};
  const readClient = getSupabaseAdminClient() ?? supabase;
  const now = tripoliDateParts();
  const currentBounds = monthBounds(now.year, now.month);
  const previous = previousMonth(now.year, now.month);
  const previousBounds = monthBounds(previous.year, previous.month);

  const batchesResult = await safeSupabaseQuery<BatchRow>({
    label: "purchase-list.active-monthly-product-profit-batches",
    promise: readClient
      .from("vms_import_batches")
      .select("id, report_start_date, report_end_date, uploaded_at, is_active, status")
      .eq("report_type", "monthly_product_profit")
      .eq("is_active", true)
      .eq("status", "imported")
      .gte("report_start_date", previousBounds.start)
      .lte("report_start_date", currentBounds.end)
      .order("uploaded_at", { ascending: false })
      .limit(20),
  });
  if (batchesResult.error) errors.salesBatches = batchesResult.error;

  const previousBatch = chooseBatch(batchesResult.data ?? [], previousBounds.start);
  const currentBatch = chooseBatch(batchesResult.data ?? [], currentBounds.start);
  const previousPeriod = periodFromBatch(previousBatch, previousBounds);
  const currentPeriod = periodFromBatch(currentBatch, currentBounds);
  const batchIds = [previousBatch?.id, currentBatch?.id].filter((id): id is string => Boolean(id));

  const [productsResult, storageResult, salesResult] = await Promise.all([
    safeSupabaseQuery<PurchaseListProduct>({
      label: "purchase-list.products",
      promise: readClient
        .from("products")
        .select("id, sku, name, active, last_purchase_cost_lyd, current_cost_price_lyd")
        .eq("active", true)
        .order("name")
        .limit(5000),
    }),
    safeSupabaseQuery<PurchaseListStorageRow>({
      label: "purchase-list.current-storage",
      promise: readClient
        .from("current_inventory_by_location")
        .select("product_id, quantity_on_hand")
        .eq("location_type", "storage")
        .limit(10000),
    }),
    batchIds.length
      ? safeSupabaseQuery<ProfitRow>({
          label: "purchase-list.monthly-product-profit",
          promise: readClient
            .from("vms_monthly_product_profit")
            .select("import_batch_id, internal_product_id, business_month, transaction_count")
            .in("import_batch_id", batchIds)
            .limit(10000),
        })
      : Promise.resolve({ data: [] as ProfitRow[], error: null }),
  ]);

  if (productsResult.error) errors.products = productsResult.error;
  if (storageResult.error) errors.storage = storageResult.error;
  if (salesResult.error) errors.sales = salesResult.error;
  if (!previousBatch && !currentBatch && !batchesResult.error) {
    errors.sales = "No active monthly product sales report is available for the previous or current month.";
  }

  const salesRows: PurchaseListSalesRow[] = [];
  let unmappedSalesRows = 0;
  let unmappedSalesUnits = 0;
  (salesResult.data ?? []).forEach((row) => {
    const productId = String(row.internal_product_id ?? "").trim();
    const units = Math.max(0, Math.floor(Number(row.transaction_count ?? 0)));
    if (!productId) {
      if (units > 0) {
        unmappedSalesRows += 1;
        unmappedSalesUnits += units;
      }
      return;
    }
    const batchId = String(row.import_batch_id ?? "");
    const month = batchId === currentBatch?.id ? "current" : batchId === previousBatch?.id ? "previous" : null;
    if (!month) return;
    salesRows.push({ product_id: productId, month, units_sold: units });
  });

  return {
    items: computePurchaseList({
      products: productsResult.data ?? [],
      storageRows: storageResult.data ?? [],
      salesRows,
      previousPeriod,
      currentPeriod,
      coverageTargetDays,
    }),
    previousPeriod,
    currentPeriod,
    previousBatch,
    currentBatch,
    errors,
    unmappedSalesRows,
    unmappedSalesUnits,
    productCount: productsResult.data?.length ?? 0,
    storageLoaded: !storageResult.error,
  };
}

export function purchaseListLoadErrorMessage(result: PurchaseListLoadResult) {
  const messages = Object.values(result.errors).filter(Boolean);
  return messages.length ? messages.join(" ") : null;
}
