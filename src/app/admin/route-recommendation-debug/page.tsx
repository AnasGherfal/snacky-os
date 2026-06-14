import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { StatCard } from "@/components/StatCard";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";

export const dynamic = "force-dynamic";

const ROUTE_RECOMMENDATION_BASE_SELECT = "recommendation_key, machine_slot_id, machine_id, machine_name, machine_code, slot_code, product_id, product_name, current_qty, capacity, par_qty, suggested_qty, available_storage_qty, final_qty_to_take, priority";
const ROUTE_RECOMMENDATION_SELECT = `${ROUTE_RECOMMENDATION_BASE_SELECT}, import_batch_id, source_file_name, source_uploaded_at`;

type SupabaseLikeError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };

type StockBatchRow = {
  id: string;
  file_name: string | null;
  original_file_name: string | null;
  report_type: string | null;
  status: string | null;
  is_active: boolean | null;
  rows_found: number | null;
  rows_imported: number | null;
  uploaded_at: string | null;
  imported_at: string | null;
  created_at: string | null;
};

type MachineStockAuditRow = {
  id: string;
  import_batch_id: string | null;
  row_number: number | null;
  machine_name: string | null;
  machine_code: string | null;
  vms_product_name: string | null;
  vms_product_code: string | null;
  machine_id: string | null;
  product_id: string | null;
  inventory_quantity: number | null;
  inventory_capacity: number | null;
  created_at: string | null;
};

type RouteSourceRow = {
  id: string;
  import_batch_id: string | null;
  machine_id: string | null;
  slot_code: string | null;
  product_id: string | null;
  vms_product_id: string | null;
  vms_product_name: string | null;
  current_qty: number | null;
  capacity: number | null;
  source_file_name: string | null;
  imported_at: string | null;
};

type RecommendationRow = {
  recommendation_key: string;
  machine_slot_id: string | null;
  machine_id: string;
  machine_name: string;
  machine_code: string;
  slot_code: string | null;
  product_id: string;
  product_name: string;
  current_qty: number;
  capacity: number | null;
  par_qty: number | null;
  suggested_qty: number | null;
  available_storage_qty: number;
  final_qty_to_take: number | null;
  priority?: string | null;
  import_batch_id?: string | null;
  source_file_name?: string | null;
  source_uploaded_at?: string | null;
};

type AuthenticatedSupabase = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US");
}

function batchLabel(batch: StockBatchRow) {
  return batch.original_file_name ?? batch.file_name ?? batch.id;
}

function isActiveImportedStockBatch(batch: StockBatchRow) {
  return ["imported", "imported_with_warnings", "partially_imported"].includes(String(batch.status ?? ""))
    && batch.is_active !== false;
}

function isMissingRecommendationMetadataError(error: SupabaseLikeError | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

async function loadRecommendationRows(supabase: AuthenticatedSupabase) {
  const enrichedResult = await supabase
    .from("refill_recommendations")
    .select(ROUTE_RECOMMENDATION_SELECT)
    .order("machine_name");

  if (enrichedResult.error && isMissingRecommendationMetadataError(enrichedResult.error)) {
    return supabase
      .from("refill_recommendations")
      .select(ROUTE_RECOMMENDATION_BASE_SELECT)
      .order("machine_name");
  }

  return enrichedResult;
}

async function countBatchRows(
  supabase: AuthenticatedSupabase,
  table: "vms_stock_snapshots" | "vms_machine_stock_snapshots",
  batchIds: string[],
) {
  const pairs = await Promise.all(batchIds.map(async (batchId) => {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId);
    return [batchId, Number(count ?? 0)] as const;
  }));

  return new Map(pairs);
}

export default async function RouteRecommendationDebugPage() {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <EmptyState
        title="Route recommendation debug unavailable"
        body="Supabase is not configured, so Snacky OS cannot inspect the recommendation pipeline."
      />
    );
  }

  const [
    recentBatchesResult,
    machineAuditTotalResult,
    machineAuditMappedMachineResult,
    machineAuditMappedProductResult,
    machineAuditSampleResult,
    routeSourceTotalResult,
    routeSourceSampleResult,
    recommendationTotalResult,
    recommendationRowsResult,
    activeProductsResult,
  ] = await Promise.all([
    supabase
      .from("vms_import_batches")
      .select("id, file_name, original_file_name, report_type, status, is_active, rows_found, rows_imported, uploaded_at, imported_at, created_at")
      .in("report_type", ["stock", "machine_stock_snapshot", "planogram"])
      .order("created_at", { ascending: false })
      .limit(12),
    supabase.from("vms_machine_stock_snapshots").select("id", { count: "exact", head: true }),
    supabase.from("vms_machine_stock_snapshots").select("id", { count: "exact", head: true }).not("machine_id", "is", null),
    supabase.from("vms_machine_stock_snapshots").select("id", { count: "exact", head: true }).not("product_id", "is", null),
    supabase
      .from("vms_machine_stock_snapshots")
      .select("id, import_batch_id, row_number, machine_name, machine_code, vms_product_name, vms_product_code, machine_id, product_id, inventory_quantity, inventory_capacity, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("latest_vms_stock_by_slot").select("id", { count: "exact", head: true }),
    supabase
      .from("latest_vms_stock_by_slot")
      .select("id, import_batch_id, machine_id, slot_code, product_id, vms_product_id, vms_product_name, current_qty, capacity, source_file_name, imported_at")
      .order("imported_at", { ascending: false })
      .limit(20),
    supabase.from("refill_recommendations").select("recommendation_key", { count: "exact", head: true }),
    loadRecommendationRows(supabase),
    supabase.from("products").select("id").eq("active", true).limit(5000),
  ]);

  const recentBatches = (recentBatchesResult.data ?? []) as StockBatchRow[];
  const batchIds = recentBatches.map((batch) => batch.id);
  const [stockRowsByBatchId, machineAuditRowsByBatchId] = await Promise.all([
    countBatchRows(supabase, "vms_stock_snapshots", batchIds),
    countBatchRows(supabase, "vms_machine_stock_snapshots", batchIds),
  ]);

  const machineAuditSample = (machineAuditSampleResult.data ?? []) as MachineStockAuditRow[];
  const routeSourceSample = (routeSourceSampleResult.data ?? []) as RouteSourceRow[];
  const allRecommendationRows = ((recommendationRowsResult.data ?? []) as RecommendationRow[]);
  const activeProductIds = new Set(((activeProductsResult.data ?? []) as Array<{ id: string }>).map((row) => row.id));
  const routeVisibleRows = allRecommendationRows.filter((row) => activeProductIds.has(row.product_id));
  const routeVisibleSample = routeVisibleRows.slice(0, 20);

  const previewOnlyBatchesWithStockRows = recentBatches.filter((batch) => !isActiveImportedStockBatch(batch) && numberValue(stockRowsByBatchId.get(batch.id)) > 0);
  const previewOnlyStockRowCount = previewOnlyBatchesWithStockRows.reduce((sum, batch) => sum + numberValue(stockRowsByBatchId.get(batch.id)), 0);
  const latestActiveImportedBatch = recentBatches.find(isActiveImportedStockBatch) ?? null;

  const machineAuditTotal = numberValue(machineAuditTotalResult.count);
  const machineAuditMappedMachine = numberValue(machineAuditMappedMachineResult.count);
  const machineAuditMappedProduct = numberValue(machineAuditMappedProductResult.count);
  const routeSourceTotal = numberValue(routeSourceTotalResult.count);
  const recommendationTotal = numberValue(recommendationTotalResult.count);
  const routeVisibleTotal = routeVisibleRows.length;
  const inactiveProductFilteredOut = Math.max(0, allRecommendationRows.length - routeVisibleTotal);

  let diagnosisTone = "border-emerald-200 bg-emerald-50 text-emerald-900";
  let diagnosisTitle = "Pipeline healthy";
  let diagnosisBody = "Confirmed stock import rows are flowing through latest stock rows, refill recommendations, and the route builder filter.";

  if (!routeVisibleTotal && previewOnlyStockRowCount > 0) {
    diagnosisTone = "border-amber-200 bg-amber-50 text-amber-900";
    diagnosisTitle = "Preview-only stock rows are blocking route recommendations";
    diagnosisBody = "Stock snapshot rows exist, but they belong to previewed or inactive batches. The route pipeline ignores those rows until the batch status is imported and is_active is true.";
  } else if (!routeSourceTotal && machineAuditTotal > 0) {
    diagnosisTone = "border-rose-200 bg-rose-50 text-rose-900";
    diagnosisTitle = "Audit rows exist, but the route source view is empty";
    diagnosisBody = "vms_machine_stock_snapshots is only the audit table. Routes depend on latest_vms_stock_by_slot, which is built from vms_stock_snapshots tied to active imported batches.";
  } else if (routeSourceTotal > 0 && !recommendationTotal) {
    diagnosisTone = "border-rose-200 bg-rose-50 text-rose-900";
    diagnosisTitle = "Route source rows exist, but recommendation generation returns zero rows";
    diagnosisBody = "The refill_recommendations view is filtering out every latest stock row. Check capacity, par values, and positive suggested quantity logic.";
  } else if (recommendationTotal > 0 && !routeVisibleTotal) {
    diagnosisTone = "border-amber-200 bg-amber-50 text-amber-900";
    diagnosisTitle = "Recommendations exist, but the route page filters them out";
    diagnosisBody = "The route builder currently keeps only recommendations whose product is active. Review product active flags and route filter assumptions.";
  }

  const queryDetails = JSON.stringify({
    source_view: "refill_recommendations",
    select: ROUTE_RECOMMENDATION_SELECT,
    order_by: "machine_name asc",
    filters: {
      active_products_only: true,
      machine_filter: null,
      location_filter: null,
      storage_filter: false,
      recommendation_status_filter: false,
      route_date_filter: false,
    },
  }, null, 2);

  return (
    <>
      <PageHeader
        title="Route Recommendation Debug"
        subtitle="Trace the pipeline from stock import rows to latest route-source rows to refill_recommendations to the exact rows visible on /routes/new."
        breadcrumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Route Recommendation Debug" },
        ]}
        action={(
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/routes/new">Open route builder</SecondaryButton>
            <SecondaryButton href="/vms-import/sources">Open VMS data sources</SecondaryButton>
          </div>
        )}
      />

      <div className={`mb-6 rounded-lg border p-4 ${diagnosisTone}`}>
        <div className="font-semibold">{diagnosisTitle}</div>
        <p className="mt-1 text-sm">
          {diagnosisBody}
        </p>
        <p className="mt-2 text-xs">
          Important: <code>vms_machine_stock_snapshots</code> is the audit table. Route recommendations come from <code>vms_stock_snapshots</code> through <code>latest_vms_stock_by_slot</code> and then <code>refill_recommendations</code>.
        </p>
      </div>

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <StatCard label="Audit rows" value={machineAuditTotal} note={`Mapped machines ${machineAuditMappedMachine} / mapped products ${machineAuditMappedProduct}`} />
        <StatCard label="Latest stock rows" value={routeSourceTotal} note={latestActiveImportedBatch ? `Latest active batch: ${batchLabel(latestActiveImportedBatch)}` : "No active imported stock batch"} />
        <StatCard label="Recommendation rows" value={recommendationTotal} note="Rows returned by refill_recommendations" />
        <StatCard label="Route-visible rows" value={routeVisibleTotal} note={`Inactive product rows filtered out: ${inactiveProductFilteredOut}`} />
        <StatCard label="Previewed stock rows" value={previewOnlyStockRowCount} note={`${previewOnlyBatchesWithStockRows.length} recent preview/inactive batch(es) still hold stock rows`} />
        <StatCard label="Zero-storage recs" value={routeVisibleRows.filter((row) => numberValue(row.available_storage_qty) <= 0).length} note="Still visible on the route page with warning" />
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-base font-semibold text-slate-900">Exact route page query</h2>
        <p className="mt-1 text-sm text-slate-500">
          This is the same route recommendation source and filter shape used by <code>/routes/new</code>.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{queryDetails}</pre>
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-base font-semibold text-slate-900">Recent stock-related batches</h2>
        <p className="mt-1 text-sm text-slate-500">
          Previewed or inactive batches can still have saved stock rows, but they will not feed route recommendations.
        </p>
        {!recentBatches.length ? (
          <div className="mt-4">
            <EmptyState title="No stock batches found" body="Upload and confirm a stock snapshot to populate the recommendation pipeline." />
          </div>
        ) : (
          <DataTable className="mt-4" headers={["File", "Status", "Rows imported", "Stock rows", "Audit rows", "Imported at"]}>
            {recentBatches.map((batch) => (
              <tr key={batch.id}>
                <td>
                  <div className="font-medium text-slate-900">{batchLabel(batch)}</div>
                  <div className="text-xs text-slate-500">{batch.report_type ?? "-"}</div>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={batch.status} />
                    <span className="text-xs text-slate-500">{batch.is_active ? "Active" : "Inactive"}</span>
                  </div>
                </td>
                <td>{numberValue(batch.rows_imported)}</td>
                <td>{numberValue(stockRowsByBatchId.get(batch.id))}</td>
                <td>{numberValue(machineAuditRowsByBatchId.get(batch.id))}</td>
                <td>{formatDateTime(batch.imported_at ?? batch.created_at)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-base font-semibold text-slate-900">Stock audit rows</h2>
        <p className="mt-1 text-sm text-slate-500">
          These rows prove what the import parser saved into <code>vms_machine_stock_snapshots</code>. This table is useful for diagnostics, but it is not the direct route recommendation source.
        </p>
        {!machineAuditSample.length ? (
          <div className="mt-4">
            <EmptyState title="No audit rows found" body="Confirm a stock import to populate vms_machine_stock_snapshots." />
          </div>
        ) : (
          <DataTable className="mt-4" headers={["Batch", "Machine", "Product", "Qty / capacity", "Mapped", "Saved at"]}>
            {machineAuditSample.map((row) => (
              <tr key={row.id}>
                <td className="font-mono text-xs text-slate-600">{row.import_batch_id ?? "-"}</td>
                <td>
                  <div className="font-medium text-slate-900">{row.machine_name ?? row.machine_code ?? "-"}</div>
                  <div className="text-xs text-slate-500">{row.machine_code ?? "-"}</div>
                </td>
                <td>
                  <div className="font-medium text-slate-900">{row.vms_product_name ?? "-"}</div>
                  <div className="text-xs text-slate-500">{row.vms_product_code ?? "-"}</div>
                </td>
                <td>{numberValue(row.inventory_quantity)} / {numberValue(row.inventory_capacity)}</td>
                <td className="text-xs text-slate-600">Machine {row.machine_id ? "yes" : "no"} / Product {row.product_id ? "yes" : "no"}</td>
                <td>{formatDateTime(row.created_at)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-base font-semibold text-slate-900">Route source rows</h2>
        <p className="mt-1 text-sm text-slate-500">
          <code>latest_vms_stock_by_slot</code> is the first view that must have rows before any refill recommendation can exist.
        </p>
        {!routeSourceSample.length ? (
          <div className="mt-4">
            <EmptyState title="No latest stock rows found" body="Check batch status, active flag, and whether vms_stock_snapshots was populated on confirm." />
          </div>
        ) : (
          <DataTable className="mt-4" headers={["Batch", "Source file", "Machine / slot", "Product", "Current / capacity", "Imported at"]}>
            {routeSourceSample.map((row) => (
              <tr key={row.id}>
                <td className="font-mono text-xs text-slate-600">{row.import_batch_id ?? "-"}</td>
                <td>{row.source_file_name ?? "-"}</td>
                <td>
                  <div className="font-mono text-xs text-slate-600">{row.machine_id ?? "-"}</div>
                  <div className="text-xs text-slate-500">Slot {row.slot_code ?? "-"}</div>
                </td>
                <td>
                  <div className="font-medium text-slate-900">{row.vms_product_name ?? "-"}</div>
                  <div className="text-xs text-slate-500">{row.vms_product_id ?? "-"}</div>
                </td>
                <td>{numberValue(row.current_qty)} / {numberValue(row.capacity)}</td>
                <td>{formatDateTime(row.imported_at)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-base font-semibold text-slate-900">Generated refill recommendations</h2>
        <p className="mt-1 text-sm text-slate-500">
          These rows are returned by <code>refill_recommendations</code> before the route page applies its active-product filter.
        </p>
        {!allRecommendationRows.length ? (
          <div className="mt-4">
            <EmptyState title="No recommendation rows found" body="If latest stock rows exist but this section is empty, the recommendation view logic is filtering everything out." />
          </div>
        ) : (
          <DataTable className="mt-4" headers={["Machine", "Product", "Current / capacity", "Suggested", "Storage", "Final take", "Priority"]}>
            {allRecommendationRows.slice(0, 20).map((row) => (
              <tr key={row.recommendation_key}>
                <td>
                  <div className="font-medium text-slate-900">{row.machine_name}</div>
                  <div className="text-xs text-slate-500">{row.machine_code} - Slot {row.slot_code ?? "-"}</div>
                </td>
                <td>{row.product_name}</td>
                <td>{numberValue(row.current_qty)} / {numberValue(row.capacity ?? row.par_qty)}</td>
                <td>{numberValue(row.suggested_qty)}</td>
                <td>{numberValue(row.available_storage_qty)}</td>
                <td>{numberValue(row.final_qty_to_take)}</td>
                <td><StatusBadge status={row.priority} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card">
        <h2 className="text-base font-semibold text-slate-900">Rows visible to the route page</h2>
        <p className="mt-1 text-sm text-slate-500">
          This matches the current route builder behavior: load <code>refill_recommendations</code>, then keep only rows whose product is active.
        </p>
        {!routeVisibleSample.length ? (
          <div className="mt-4">
            <EmptyState title="No route-visible recommendation rows" body="Routes will show an empty recommendation state until this section has rows." />
          </div>
        ) : (
          <DataTable className="mt-4" headers={["Machine", "Product", "Current / capacity", "Suggested", "Storage", "Final take", "Priority"]}>
            {routeVisibleSample.map((row) => (
              <tr key={row.recommendation_key}>
                <td>
                  <div className="font-medium text-slate-900">{row.machine_name}</div>
                  <div className="text-xs text-slate-500">{row.machine_code} - Slot {row.slot_code ?? "-"}</div>
                </td>
                <td>{row.product_name}</td>
                <td>{numberValue(row.current_qty)} / {numberValue(row.capacity ?? row.par_qty)}</td>
                <td>{numberValue(row.suggested_qty)}</td>
                <td>{numberValue(row.available_storage_qty)}</td>
                <td>{numberValue(row.final_qty_to_take)}</td>
                <td><StatusBadge status={row.priority} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
