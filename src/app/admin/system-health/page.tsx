import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type ImportBatchRow = {
  id: string;
  file_name: string | null;
  original_file_name: string | null;
  report_type: string | null;
  status: string | null;
  is_active: boolean | null;
  rows_found: number | null;
  rows_imported: number | null;
  error_count: number | null;
  uploaded_at: string | null;
  imported_at: string | null;
};

type RouteRow = {
  id: string;
  route_date: string | null;
  status: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  last_completion_error?: string | null;
  operator_id?: string | null;
};

type ProductCostRow = {
  id: string;
  name: string | null;
  sku: string | null;
  current_cost_price_lyd: number | null;
  cost_price: number | null;
  last_purchase_date?: string | null;
};

type ProductMappingRow = {
  id: string;
  vms_product_name: string | null;
  match_status: string | null;
  updated_at: string | null;
};

type MachineMappingRow = {
  id: string;
  vms_machine_key: string | null;
  vms_machine_name: string | null;
  status: string | null;
  updated_at: string | null;
};

type FinanceHealthSnapshot = {
  schemaStatus: string;
  purchasesMissing: number;
  cashMissing: number;
  failedSyncCount: number;
  error: string | null;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US");
}

function fileLabel(batch: ImportBatchRow) {
  return batch.original_file_name ?? batch.file_name ?? batch.id;
}

function isMissingColumn(error: unknown, column: string) {
  const row = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  const text = [row?.code, row?.message, row?.details, row?.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return ["42703", "PGRST204"].includes(String(row?.code ?? "")) || (text.includes("column") && text.includes(column.toLowerCase())) || text.includes("schema cache");
}

async function loadRouteRows(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const withError = await supabase
    .from("routes")
    .select("id, route_date, status, started_at, updated_at, last_completion_error, operator_id")
    .order("route_date", { ascending: false })
    .limit(60);

  if (!withError.error || !isMissingColumn(withError.error, "last_completion_error")) return withError;

  return supabase
    .from("routes")
    .select("id, route_date, status, started_at, updated_at, operator_id")
    .order("route_date", { ascending: false })
    .limit(60);
}

async function loadFinanceHealthSnapshot(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>): Promise<FinanceHealthSnapshot> {
  const healthResult = await supabase.rpc("finance_health_report");
  if (!healthResult.error && healthResult.data) {
    return {
      schemaStatus: String(healthResult.data.schema_status ?? "ok"),
      purchasesMissing: Number(healthResult.data.purchases_missing_finance_transaction ?? 0),
      cashMissing: Number(healthResult.data.cash_collections_missing_finance_transaction ?? 0),
      failedSyncCount: Number(healthResult.data.failed_sync_count ?? 0),
      error: null,
    };
  }

  const [{ data: purchases }, { data: cashCollections }, { data: transactions }] = await Promise.all([
    supabase.from("purchase_orders").select("id").limit(5000),
    supabase.from("cash_collections").select("id, actual_cash_collected, counted_amount_lyd").limit(5000),
    supabase
      .from("financial_transactions")
      .select("source_type, source_id, linked_purchase_id, related_purchase_id, linked_cash_collection_id, related_cash_collection_id, transaction_status")
      .limit(5000),
  ]);

  const purchaseIds = new Set(((purchases ?? []) as Array<{ id: string }>).map((row) => row.id));
  const eligibleCashIds = new Set(
    ((cashCollections ?? []) as Array<{ id: string; actual_cash_collected?: number | null; counted_amount_lyd?: number | null }>)
      .filter((row) => row.actual_cash_collected !== null || row.counted_amount_lyd !== null)
      .map((row) => row.id),
  );

  const activePurchaseLinks = new Set<string>();
  const activeCashLinks = new Set<string>();

  ((transactions ?? []) as Array<{
    source_type?: string | null;
    source_id?: string | null;
    linked_purchase_id?: string | null;
    related_purchase_id?: string | null;
    linked_cash_collection_id?: string | null;
    related_cash_collection_id?: string | null;
    transaction_status?: string | null;
  }>).forEach((row) => {
    if ((row.transaction_status ?? "active") !== "active") return;
    if (row.linked_purchase_id) activePurchaseLinks.add(row.linked_purchase_id);
    if (row.related_purchase_id) activePurchaseLinks.add(row.related_purchase_id);
    if (row.source_type === "purchase" && row.source_id) activePurchaseLinks.add(row.source_id);
    if (row.linked_cash_collection_id) activeCashLinks.add(row.linked_cash_collection_id);
    if (row.related_cash_collection_id) activeCashLinks.add(row.related_cash_collection_id);
    if (row.source_type === "cash_collection" && row.source_id) activeCashLinks.add(row.source_id);
  });

  const purchasesMissing = Array.from(purchaseIds).filter((id) => !activePurchaseLinks.has(id)).length;
  const cashMissing = Array.from(eligibleCashIds).filter((id) => !activeCashLinks.has(id)).length;

  return {
    schemaStatus: "rpc_unavailable",
    purchasesMissing,
    cashMissing,
    failedSyncCount: purchasesMissing + cashMissing,
    error: healthResult.error?.message ?? "Finance health RPC is unavailable.",
  };
}

export default async function SystemHealthPage() {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <EmptyState
        title="System health unavailable"
        body="Supabase is not configured, so Snacky OS cannot run health checks."
      />
    );
  }

  const [
    importResult,
    routesResult,
    productsResult,
    productMappingsResult,
    machineMappingsResult,
    financeHealth,
  ] = await Promise.all([
    supabase
      .from("vms_import_batches")
      .select("id, file_name, original_file_name, report_type, status, is_active, rows_found, rows_imported, error_count, uploaded_at, imported_at")
      .order("uploaded_at", { ascending: false })
      .limit(30),
    loadRouteRows(supabase),
    supabase
      .from("products")
      .select("id, name, sku, current_cost_price_lyd, cost_price, last_purchase_date")
      .eq("active", true)
      .order("name")
      .limit(500),
    supabase
      .from("vms_product_mappings")
      .select("id, vms_product_name, match_status, updated_at", { count: "exact" })
      .or("product_id.is.null,match_status.eq.needs_review")
      .order("updated_at", { ascending: false })
      .limit(12),
    supabase
      .from("vms_machine_mappings")
      .select("id, vms_machine_key, vms_machine_name, status, updated_at", { count: "exact" })
      .or("machine_id.is.null,status.eq.needs_review")
      .order("updated_at", { ascending: false })
      .limit(12),
    loadFinanceHealthSnapshot(supabase),
  ]);

  const importIssues = ((importResult.data ?? []) as ImportBatchRow[]).filter((batch) => !["imported", "imported_with_warnings"].includes(String(batch.status ?? "")) || Number(batch.error_count ?? 0) > 0);
  const routeIssues = ((routesResult.data ?? []) as RouteRow[]).filter((route) => {
    const status = String(route.status ?? "");
    const overdue = Boolean(route.route_date && route.route_date < new Date().toISOString().slice(0, 10) && !["completed", "cancelled", "canceled"].includes(status));
    return overdue || Boolean(route.last_completion_error);
  });
  const costGaps = ((productsResult.data ?? []) as ProductCostRow[]).filter((product) => {
    const currentCost = Number(product.current_cost_price_lyd ?? product.cost_price ?? 0);
    return !Number.isFinite(currentCost) || currentCost <= 0;
  });
  const productMappingGaps = (productMappingsResult.data ?? []) as ProductMappingRow[];
  const machineMappingGaps = (machineMappingsResult.data ?? []) as MachineMappingRow[];
  const mappingGapCount = Number(productMappingsResult.count ?? 0) + Number(machineMappingsResult.count ?? 0);

  return (
    <>
      <PageHeader
        title="System Health"
        subtitle="Admin-only operational checks for imports, finance sync, route completion, costs, and VMS mapping readiness."
        breadcrumbs={[
          { label: "Admin", href: "/admin" },
          { label: "System Health" },
        ]}
        action={<SecondaryButton href="/admin">Back to admin</SecondaryButton>}
      />

      {financeHealth.error ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Finance sync is using the fallback health check because the database RPC is unavailable. {financeHealth.error}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Import issues</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{importIssues.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Finance gaps</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{financeHealth.failedSyncCount}</div>
          <div className="mt-2 text-sm text-slate-500">Schema <StatusBadge status={financeHealth.schemaStatus} /></div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Routes needing attention</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{routeIssues.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Products without cost</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{costGaps.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mapping gaps</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{mappingGapCount}</div>
        </div>
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">Finance sync</h2>
          <p className="mt-1 text-sm text-slate-500">Purchases and counted cash collections should create finance rows immediately.</p>
          <dl className="mt-4 grid gap-3 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-rose-900">
              <dt>Purchases missing finance</dt>
              <dd className="font-semibold">{financeHealth.purchasesMissing}</dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-rose-900">
              <dt>Cash collections missing finance</dt>
              <dd className="font-semibold">{financeHealth.cashMissing}</dd>
            </div>
          </dl>
        </div>

        <div className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">Recent import issues</h2>
          <p className="mt-1 text-sm text-slate-500">Imports should finish as imported or imported_with_warnings and stay active when they are the source of record.</p>
          {!importIssues.length ? (
            <p className="mt-4 text-sm text-slate-500">No recent import issues.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {importIssues.slice(0, 5).map((batch) => (
                <div key={batch.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="font-semibold text-slate-900">{fileLabel(batch)}</div>
                  <div className="mt-1 text-slate-500">{String(batch.report_type ?? "-").replaceAll("_", " ")}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusBadge status={batch.status} />
                    <span className="text-slate-500">Found {batch.rows_found ?? 0}</span>
                    <span className="text-slate-500">Imported {batch.rows_imported ?? 0}</span>
                    <span className="text-slate-500">Errors {batch.error_count ?? 0}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Routes needing attention</h2>
        {!routeIssues.length ? (
          <EmptyState title="No stuck routes" body="Routes are either completed, current, or have no recorded completion errors." />
        ) : (
          <DataTable headers={["Route date", "Status", "Started", "Last updated", "Issue"]}>
            {routeIssues.map((route) => (
              <tr key={route.id}>
                <td className="font-medium text-slate-900">{route.route_date ?? "-"}</td>
                <td><StatusBadge status={route.status} /></td>
                <td>{formatDateTime(route.started_at)}</td>
                <td>{formatDateTime(route.updated_at)}</td>
                <td className="max-w-xl break-words text-xs">{route.last_completion_error ?? "Route date passed without completion."}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Products without cost</h2>
        {!costGaps.length ? (
          <EmptyState title="All active products have cost" body="Current cost values are present for the active product catalog." />
        ) : (
          <DataTable headers={["Product", "SKU", "Current cost", "Fallback cost", "Last purchase"]}>
            {costGaps.slice(0, 25).map((product) => (
              <tr key={product.id}>
                <td className="font-medium text-slate-900">{product.name ?? "-"}</td>
                <td>{product.sku ?? "-"}</td>
                <td>{product.current_cost_price_lyd ?? "-"}</td>
                <td>{product.cost_price ?? "-"}</td>
                <td>{product.last_purchase_date ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Unmapped VMS products</h2>
          {!productMappingGaps.length ? (
            <EmptyState title="No VMS product mapping gaps" body="Recent VMS products are already mapped or intentionally ignored." />
          ) : (
            <DataTable headers={["VMS product", "Status", "Updated"]}>
              {productMappingGaps.map((row) => (
                <tr key={row.id}>
                  <td className="font-medium text-slate-900">{row.vms_product_name ?? row.id}</td>
                  <td><StatusBadge status={row.match_status} /></td>
                  <td>{formatDateTime(row.updated_at)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Unmapped VMS machines</h2>
          {!machineMappingGaps.length ? (
            <EmptyState title="No VMS machine mapping gaps" body="Recent VMS machines are already mapped or intentionally ignored." />
          ) : (
            <DataTable headers={["VMS machine", "Status", "Updated"]}>
              {machineMappingGaps.map((row) => (
                <tr key={row.id}>
                  <td className="font-medium text-slate-900">{row.vms_machine_name ?? row.vms_machine_key ?? row.id}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>{formatDateTime(row.updated_at)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      </section>
    </>
  );
}
