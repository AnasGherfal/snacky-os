import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import { computePurchaseList, type PurchaseListPeriod, type PurchaseListSalesRow, type PurchaseListStorageRow } from "@/lib/purchase-list";
import { boxPurchaseRecommendations, type BoxProduct, type BoxPurchaseListItem } from "@/lib/purchase-boxes";
import {
  computeScheduledSiteDemand,
  type ScheduledSiteFillRow,
  type ScheduledSiteStockRow,
} from "@/lib/purchase-scheduled-site-demand";

type SupabaseLike = { from: (table: string) => any };
type BatchRow = { id: string; report_start_date: string | null; report_end_date: string | null; uploaded_at: string | null; is_active?: boolean | null; status?: string | null };
type ProfitRow = { id: string; import_batch_id?: string | null; internal_product_id?: string | null; business_month?: string | null; transaction_count?: number | string | null };
type PurchaseSiteMachineRow = { id: string; name?: string | null; machine_code?: string | null; vms_machine_id?: string | null; refill_open_days?: number[] | null; status?: string | null };
export type PurchaseListLoadResult = {
  items: BoxPurchaseListItem[]; previousPeriod: PurchaseListPeriod | null; currentPeriod: PurchaseListPeriod | null;
  previousBatch: BatchRow | null; currentBatch: BatchRow | null; errors: Record<string,string>;
  unmappedSalesRows: number; unmappedSalesUnits: number; productCount: number; storageLoaded: boolean;
  scheduledSiteDemand: {
    siteName: string;
    observedOperatingDays: number;
    coverageOperatingDays: number;
    projectedUnits: number;
  } | null;
};

/** Page every read rather than trusting a large limit that PostgREST may cap. */
async function readAll<T>(label: string, query: (from: number, to: number) => any) {
  const rows: T[] = [];
  for (let offset = 0; offset < 50000; offset += 500) {
    const result = await safeSupabaseQuery<T>({ label, promise: query(offset, offset + 499) });
    if (result.error) return { data: [] as T[], error: result.error };
    rows.push(...result.data);
    if (result.data.length < 500) return { data: rows, error: null };
  }
  return { data: [] as T[], error: "Too many records to verify the complete purchase list." };
}

function bounds(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0,10);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0,10);
  return { start, end, days: Number(end.slice(-2)) };
}
function chooseBatch(rows: BatchRow[], month: string) {
  return rows.filter(row => row.report_start_date === month)
    .sort((a,b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)) || a.id.localeCompare(b.id))[0] ?? null;
}
function period(batch: BatchRow | null, month: ReturnType<typeof bounds>): PurchaseListPeriod | null {
  if (!batch?.report_start_date || !batch.report_end_date) return null;
  if (batch.report_start_date !== month.start || batch.report_end_date < month.start || batch.report_end_date > month.end) return null;
  const days = (Date.parse(batch.report_end_date) - Date.parse(batch.report_start_date)) / 86400000 + 1;
  if (!Number.isInteger(days) || days < 1) return null;
  return { start: batch.report_start_date, end: batch.report_end_date, coveredDays: days, daysInMonth: month.days };
}

export async function loadPurchaseListData(supabase: SupabaseLike, coverageTargetDays: number): Promise<PurchaseListLoadResult> {
  // Caller must authorize the purchasing page before invoking this server-only read.
  const readClient = getSupabaseAdminClient() ?? supabase;
  const parts = new Intl.DateTimeFormat("en-US", {timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit"}).formatToParts(new Date());
  const year = Number(parts.find(part => part.type === "year")?.value);
  const month = Number(parts.find(part => part.type === "month")?.value);
  const current = bounds(year,month), previous = bounds(year,month-1);
  const errors: Record<string,string> = {};
  const now = new Date();
  const eliteMachines = await readAll<PurchaseSiteMachineRow>("purchase-list.elite-machine", (from,to) => readClient.from("machines")
    .select("id, name, machine_code, vms_machine_id, refill_open_days, status")
    .eq("vms_machine_id","2511001702").eq("status","active").order("id").range(from,to));
  if (eliteMachines.error) errors.scheduledSiteDemand = eliteMachines.error;
  const eliteMachine = eliteMachines.data[0] ?? null;
  if (!eliteMachine && !eliteMachines.error) errors.scheduledSiteDemand = "Elite Future School is active but its purchase-demand machine could not be found.";

  const batches = await readAll<BatchRow>("purchase-list.batches", (from,to) => readClient.from("vms_import_batches")
    .select("id, report_start_date, report_end_date, uploaded_at, is_active, status")
    .eq("report_type", "monthly_product_profit").eq("is_active", true).eq("status", "imported").is("deleted_at",null)
    .gte("report_start_date",previous.start).lte("report_start_date",current.end).order("id").range(from,to));
  if (batches.error) errors.salesBatches = batches.error;
  const previousBatch = chooseBatch(batches.data,previous.start), currentBatch = chooseBatch(batches.data,current.start);
  const previousPeriod = period(previousBatch,previous), currentPeriod = period(currentBatch,current);
  if ((previousBatch && !previousPeriod) || (currentBatch && !currentPeriod)) errors.salesBatches = "Sales report dates could not be verified.";
  const ids = [previousBatch?.id,currentBatch?.id].filter((id): id is string => Boolean(id));
  const eliteLookbackStart = new Date(now.getTime() - 21 * 86400000).toISOString();
  const [products,storage,sales,eliteStock,eliteFills] = await Promise.all([
    readAll<BoxProduct>("purchase-list.products", (from,to) => readClient.from("products")
      .select("id, sku, name, active, case_quantity, last_purchase_cost_lyd, current_cost_price_lyd").eq("active",true).order("id").range(from,to)),
    readAll<PurchaseListStorageRow>("purchase-list.storage", (from,to) => readClient.from("current_inventory_by_location")
      .select("product_id, quantity_on_hand").eq("location_type", "storage").order("product_id").order("location_id").range(from,to)),
    ids.length ? readAll<ProfitRow>("purchase-list.sales", (from,to) => readClient.from("vms_monthly_product_profit")
      .select("id, import_batch_id, internal_product_id, business_month, transaction_count").in("import_batch_id",ids).order("id").range(from,to))
      : Promise.resolve({data:[] as ProfitRow[],error:null}),
    eliteMachine ? readAll<ScheduledSiteStockRow>("purchase-list.elite-stock", (from,to) => readClient.from("vms_stock_snapshots")
      .select("product_id, current_qty, captured_at, sync_run_id, import_batch_id")
      .eq("machine_id",eliteMachine.id).eq("import_row_status","imported").not("product_id","is",null)
      .gte("captured_at",eliteLookbackStart).order("captured_at").range(from,to))
      : Promise.resolve({data:[] as ScheduledSiteStockRow[],error:null}),
    eliteMachine ? readAll<ScheduledSiteFillRow>("purchase-list.elite-fills", (from,to) => readClient.from("route_stop_fill_lines")
      .select("product_id, actual_qty, created_at").eq("machine_id",eliteMachine.id).not("product_id","is",null)
      .gte("created_at",eliteLookbackStart).order("created_at").range(from,to))
      : Promise.resolve({data:[] as ScheduledSiteFillRow[],error:null}),
  ]);
  if (products.error) errors.products = products.error;
  if (storage.error) errors.storage = storage.error;
  if (sales.error) errors.sales = sales.error;
  if (eliteStock.error) errors.scheduledSiteDemand = eliteStock.error;
  if (eliteFills.error) errors.scheduledSiteDemand = eliteFills.error;
  if (!ids.length && !batches.error) errors.sales = "No active sales report is available for the previous or current month.";
  const salesRows: PurchaseListSalesRow[] = [];
  let unmappedSalesRows = 0, unmappedSalesUnits = 0;
  for (const row of sales.data) {
    const units = Number(row.transaction_count);
    if (!Number.isSafeInteger(units) || units < 0) { errors.sales = "A sales quantity is invalid; review the source report."; continue; }
    if (!row.internal_product_id) { if (units > 0) { unmappedSalesRows++; unmappedSalesUnits += units; } continue; }
    const which = row.import_batch_id === currentBatch?.id ? "current" : "previous";
    const expectedMonth = which === "current" ? current.start : previous.start;
    if (row.business_month !== expectedMonth) { errors.sales = "A sales row does not match its report month."; continue; }
    salesRows.push({product_id:row.internal_product_id,month:which,units_sold:units});
  }
  const scheduledDemandRows = eliteMachine && !eliteStock.error && !eliteFills.error
    ? computeScheduledSiteDemand({
        siteName: String(eliteMachine.name ?? "Elite Future School"),
        openDays: eliteMachine.refill_open_days ?? [1,2,3,4,5],
        coverageDays: coverageTargetDays,
        stockRows: eliteStock.data,
        fillRows: eliteFills.data,
        previousPeriod,
        currentPeriod,
        now,
        minimumCompletedOperatingDays: 2,
        maxCompletedOperatingDays: 10,
      })
    : [];
  if (eliteMachine && !errors.scheduledSiteDemand && scheduledDemandRows.length === 0) {
    errors.scheduledSiteDemand = "Elite Future School does not yet have enough complete operating-day stock history for a safe automated purchase forecast.";
  }
  const scheduledSiteDemand = scheduledDemandRows.length
    ? {
        siteName: scheduledDemandRows[0].site_name,
        observedOperatingDays: scheduledDemandRows[0].observed_operating_days,
        coverageOperatingDays: scheduledDemandRows[0].coverage_operating_days,
        projectedUnits: scheduledDemandRows.reduce((sum,row) => sum + row.projected_units,0),
      }
    : null;
  const items = computePurchaseList({
    products:products.data,
    storageRows:storage.data,
    salesRows,
    scheduledDemandRows,
    previousPeriod,
    currentPeriod,
    coverageTargetDays,
  });
  return {items:boxPurchaseRecommendations(items,products.data),previousPeriod,currentPeriod,previousBatch,currentBatch,errors,
    unmappedSalesRows,unmappedSalesUnits,productCount:products.data.length,storageLoaded:!storage.error,scheduledSiteDemand};
}
export function purchaseListLoadErrorMessage(result: PurchaseListLoadResult) {
  return Object.values(result.errors).filter(Boolean).join(" ") || null;
}
