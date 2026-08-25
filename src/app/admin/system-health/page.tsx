import Link from "next/link";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import {
  backfillMissingFinanceTransactions,
  rebuildRefillRecommendations,
  recalculateStorageBalances,
  repairStuckRoute,
} from "@/lib/admin-tools-actions";
import {
  loadFinanceHealthDiagnostics,
  type FinanceHealthDiagnostics,
} from "@/lib/finance-health";
import { ROUTE_RESERVATION_STATUSES } from "@/lib/route-workflow";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { reprocessVmsImportBatch } from "@/lib/vms-import-actions";

export const dynamic = "force-dynamic";

const SYSTEM_HEALTH_PATH = "/admin/system-health";
const SUCCESS_IMPORT_STATUSES = ["imported", "imported_with_warnings"];
const ERROR_KEYWORDS = ["failed", "error", "exception", "timeout", "denied", "rls", "unavailable", "stuck"];

type ImportBatchRow = {
  id: string;
  file_name: string | null;
  original_file_name: string | null;
  report_type: string | null;
  status: string | null;
  is_active: boolean | null;
  rows_found: number | null;
  rows_imported: number | null;
  rows_skipped_duplicate?: number | null;
  rows_needing_review?: number | null;
  error_count: number | null;
  latest_error?: string | null;
  last_error?: string | null;
  uploaded_at: string | null;
  imported_at: string | null;
};

type RouteRow = {
  id: string;
  route_date: string | null;
  status: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  last_completion_error?: string | null;
  operator_id?: string | null;
  operator?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
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

type StorageInventoryRow = {
  product_id: string | null;
  product_name: string | null;
  location_type: string | null;
  location_name: string | null;
  quantity_on_hand: number | string | null;
};

type RouteReservationRow = {
  product_id: string | null;
  planned_qty: number | string | null;
  picked_qty: number | string | null;
  routes?: { status?: string | null; route_date?: string | null } | Array<{ status?: string | null; route_date?: string | null }> | null;
  product?: { name?: string | null; sku?: string | null } | Array<{ name?: string | null; sku?: string | null }> | null;
};

type ActivityLogRow = {
  id: string;
  actor_name: string | null;
  action: string | null;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  summary: string | null;
  metadata: unknown;
  created_at: string | null;
};

type QuickRouteOption = Pick<RouteRow, "id" | "route_date" | "status" | "operator">;
type QuickBatchOption = Pick<ImportBatchRow, "id" | "file_name" | "original_file_name" | "report_type" | "status" | "uploaded_at" | "imported_at">;

type StorageIssueRow = {
  key: string;
  kind: "negative_balance" | "over_reserved";
  productId: string | null;
  productName: string;
  locationLabel: string;
  quantity: number;
  storageQty: number;
  reservedQty: number;
  issue: string;
};

type RecentSystemErrorRow = {
  key: string;
  source: string;
  title: string;
  message: string;
  createdAt: string | null;
  href?: string | null;
};

type FinanceLinkIssueRow = {
  key: string;
  kind: string;
  label: string;
  issue: string;
  when: string | null;
  amountNote: string;
};

function relationRecord<T extends Record<string, unknown>>(value: T | T[] | null | undefined) {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US");
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function fileLabel(batch: Pick<ImportBatchRow, "id" | "file_name" | "original_file_name">) {
  return batch.original_file_name ?? batch.file_name ?? batch.id;
}

function routeOperatorName(route: Pick<RouteRow, "operator">) {
  return textValue(relationRecord<{ full_name?: string | null }>(route.operator)?.full_name) ?? "-";
}

function routeLabel(route: QuickRouteOption) {
  return `${route.route_date ?? "No date"} - ${route.status ?? "unknown"} - ${route.id.slice(0, 8)}${routeOperatorName(route) !== "-" ? ` - ${routeOperatorName(route)}` : ""}`;
}

function batchLabel(batch: QuickBatchOption) {
  return `${fileLabel(batch)} - ${batch.report_type ?? "unknown"} - ${batch.status ?? "unknown"} - ${batch.id.slice(0, 8)}`;
}

function routeIssueMessage(route: RouteRow) {
  if (textValue(route.last_completion_error)) return String(route.last_completion_error);
  return "Route date passed without completion.";
}

function importIssueMessage(batch: ImportBatchRow) {
  return textValue(batch.latest_error)
    ?? textValue(batch.last_error)
    ?? (Number(batch.error_count ?? 0) > 0 ? `${batch.error_count} import error(s) recorded.` : null)
    ?? `Status ${batch.status ?? "unknown"} requires review.`;
}

function isMissingColumn(error: unknown, columns: string[]) {
  const row = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  const text = [row?.code, row?.message, row?.details, row?.hint].map((value) => String(value ?? "")).join(" ").toLowerCase();
  return ["42703", "PGRST204"].includes(String(row?.code ?? "")) || text.includes("schema cache") || columns.some((column) => text.includes(column.toLowerCase()));
}

function isImportFailure(batch: ImportBatchRow) {
  const status = String(batch.status ?? "");
  return !SUCCESS_IMPORT_STATUSES.includes(status);
}

function statusText(value: string | null | undefined) {
  return String(value ?? "unknown").replaceAll("_", " ");
}

function timestampValue(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeJsonText(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

function looksLikeSystemError(row: ActivityLogRow) {
  const haystack = [
    row.action,
    row.entity_type,
    row.entity_label,
    row.summary,
    safeJsonText(row.metadata),
  ].join(" ").toLowerCase();
  return ERROR_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function entityHref(row: Pick<ActivityLogRow, "entity_type" | "entity_id">) {
  if (!row.entity_id) return null;
  if (row.entity_type === "route") return `/routes/${row.entity_id}`;
  if (row.entity_type === "vms_import") return `/vms-import/${row.entity_id}`;
  if (row.entity_type === "product") return `/products/${row.entity_id}`;
  if (row.entity_type === "financial_transaction") return `/finance/transactions/${row.entity_id}`;
  return null;
}

async function loadRouteRows(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const withError = await supabase
    .from("routes")
    .select("id, route_date, status, started_at, updated_at, completed_at, last_completion_error, operator_id, operator:team_members(full_name)")
    .order("route_date", { ascending: false })
    .limit(80);

  if (!withError.error || !isMissingColumn(withError.error, ["last_completion_error"])) return withError;

  return supabase
    .from("routes")
    .select("id, route_date, status, started_at, updated_at, completed_at, operator_id, operator:team_members(full_name)")
    .order("route_date", { ascending: false })
    .limit(80);
}

async function loadImportRows(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const preferred = await supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, report_type, status, is_active, rows_found, rows_imported, rows_skipped_duplicate, rows_needing_review, error_count, latest_error, last_error, uploaded_at, imported_at")
    .order("uploaded_at", { ascending: false })
    .limit(50);

  if (!preferred.error || !isMissingColumn(preferred.error, ["latest_error", "last_error", "rows_skipped_duplicate", "rows_needing_review"])) return preferred;

  return supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, report_type, status, is_active, rows_found, rows_imported, error_count, uploaded_at, imported_at")
    .order("uploaded_at", { ascending: false })
    .limit(50);
}

function buildStorageIssues(storageRows: StorageInventoryRow[], reservationRows: RouteReservationRow[]) {
  const storageByProduct = new Map<string, { productName: string; storageQty: number }>();
  storageRows
    .filter((row) => row.location_type === "storage")
    .forEach((row) => {
      const productId = String(row.product_id ?? "");
      if (!productId) return;
      const current = storageByProduct.get(productId) ?? {
        productName: row.product_name ?? productId,
        storageQty: 0,
      };
      current.storageQty += numberValue(row.quantity_on_hand);
      storageByProduct.set(productId, current);
    });

  const negativeIssues: StorageIssueRow[] = storageRows
    .filter((row) => numberValue(row.quantity_on_hand) < 0)
    .slice(0, 25)
    .map((row, index) => ({
      key: `negative-${row.location_type ?? "unknown"}-${row.location_name ?? "unknown"}-${row.product_id ?? row.product_name ?? index}`,
      kind: "negative_balance",
      productId: textValue(row.product_id),
      productName: row.product_name ?? "Unknown product",
      locationLabel: `${row.location_type ?? "unknown"}${row.location_name ? ` - ${row.location_name}` : ""}`,
      quantity: numberValue(row.quantity_on_hand),
      storageQty: row.location_type === "storage" ? numberValue(row.quantity_on_hand) : numberValue(storageByProduct.get(String(row.product_id ?? ""))?.storageQty),
      reservedQty: 0,
      issue: row.location_type === "operator_bag"
        ? "Operator bag is negative. Review route pickup, refill, return, and correction movements for this operator."
        : "Ledger balance is negative and needs investigation.",
    }));

  const reservedByProduct = new Map<string, { productName: string; reservedQty: number }>();
  reservationRows.forEach((row) => {
    const route = relationRecord<{ status?: string | null }>(row.routes);
    if (!(ROUTE_RESERVATION_STATUSES as readonly string[]).includes(String(route?.status ?? ""))) return;
    const outstanding = Math.max(0, numberValue(row.planned_qty) - numberValue(row.picked_qty));
    if (!outstanding) return;
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    const current = reservedByProduct.get(productId) ?? {
      productName: relationRecord<{ name?: string | null }>(row.product)?.name ?? productId,
      reservedQty: 0,
    };
    current.reservedQty += outstanding;
    reservedByProduct.set(productId, current);
  });

  const overReservedIssues: StorageIssueRow[] = Array.from(reservedByProduct.entries())
    .filter(([productId, row]) => row.reservedQty > Math.max(0, numberValue(storageByProduct.get(productId)?.storageQty)))
    .slice(0, 25)
    .map(([productId, row]) => ({
      key: `reserved-${productId}`,
      kind: "over_reserved",
      productId,
      productName: row.productName,
      locationLabel: "Active route reservations",
      quantity: numberValue(storageByProduct.get(productId)?.storageQty),
      storageQty: numberValue(storageByProduct.get(productId)?.storageQty),
      reservedQty: row.reservedQty,
      issue: "Reserved route stock is higher than current storage quantity.",
    }));

  return [...negativeIssues, ...overReservedIssues].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.productName.localeCompare(right.productName);
  });
}

function buildRecentSystemErrors({
  importIssues,
  routeIssues,
  activityRows,
}: {
  importIssues: ImportBatchRow[];
  routeIssues: RouteRow[];
  activityRows: ActivityLogRow[];
}) {
  const rows: RecentSystemErrorRow[] = [
    ...importIssues.map((batch) => ({
      key: `import-${batch.id}`,
      source: "VMS import",
      title: fileLabel(batch),
      message: importIssueMessage(batch),
      createdAt: batch.imported_at ?? batch.uploaded_at,
      href: `/vms-import/${batch.id}`,
    })),
    ...routeIssues.map((route) => ({
      key: `route-${route.id}`,
      source: "Route",
      title: `${route.route_date ?? "No date"} - ${route.id.slice(0, 8)}`,
      message: routeIssueMessage(route),
      createdAt: route.updated_at ?? route.started_at ?? route.completed_at ?? (route.route_date ? `${route.route_date}T00:00:00` : null),
      href: `/routes/${route.id}`,
    })),
    ...activityRows
      .filter(looksLikeSystemError)
      .map((row) => ({
        key: `activity-${row.id}`,
        source: "System activity",
        title: row.entity_label ?? row.action ?? row.entity_type ?? row.id,
        message: row.summary ?? safeJsonText(row.metadata),
        createdAt: row.created_at,
        href: entityHref(row),
      })),
  ];

  return rows
    .sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt))
    .slice(0, 25);
}

function buildFinanceLinkIssues(diagnostics: FinanceHealthDiagnostics): FinanceLinkIssueRow[] {
  return [
    ...diagnostics.purchasesMissingFinance.map((row) => ({
      key: `purchase-${row.id}`,
      kind: "Purchase missing finance",
      label: row.receiptNumber ?? row.supplierName ?? row.id,
      issue: "Purchase saved without a linked finance transaction.",
      when: row.orderDate,
      amountNote: `${row.amount.toFixed(2)} LYD`,
    })),
    ...diagnostics.cashCollectionsMissingFinance.map((row) => ({
      key: `cash-${row.id}`,
      kind: "Cash collection missing finance",
      label: row.machineName ?? row.cashBagId ?? row.id,
      issue: "Cash collection saved without a linked finance transaction.",
      when: row.collectedAt,
      amountNote: `${row.actualCashCollected.toFixed(2)} LYD`,
    })),
    ...diagnostics.brokenLinks.map((row) => ({
      key: `broken-${row.financeTransactionId}-${row.reason}`,
      kind: "Broken finance link",
      label: row.description ?? row.linkedId ?? row.financeTransactionId,
      issue: row.reason,
      when: row.transactionDate,
      amountNote: row.sourceType === "purchase" ? "Money Out" : "Money In",
    })),
  ].slice(0, 60);
}

function QuickActionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface-card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {children}
    </section>
  );
}

function RouteSelect({ routes }: { routes: QuickRouteOption[] }) {
  return (
    <select name="route_id" required className="field-input">
      <option value="">Select route</option>
      {routes.map((route) => (
        <option key={route.id} value={route.id}>{routeLabel(route)}</option>
      ))}
    </select>
  );
}

function BatchSelect({ batches }: { batches: QuickBatchOption[] }) {
  return (
    <select name="batch_id" required className="field-input">
      <option value="">Select import</option>
      {batches.map((batch) => (
        <option key={batch.id} value={batch.id}>{batchLabel(batch)}</option>
      ))}
    </select>
  );
}

function HiddenReturnTo() {
  return <input type="hidden" name="return_to" value={SYSTEM_HEALTH_PATH} />;
}

export default async function SystemHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const { success = "", error = "" } = await searchParams;
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
    financeDiagnostics,
    storageInventoryResult,
    reservationResult,
    activityResult,
  ] = await Promise.all([
    loadImportRows(supabase),
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
      .limit(20),
    supabase
      .from("vms_machine_mappings")
      .select("id, vms_machine_key, vms_machine_name, status, updated_at", { count: "exact" })
      .or("machine_id.is.null,status.eq.needs_review")
      .order("updated_at", { ascending: false })
      .limit(20),
    loadFinanceHealthDiagnostics(supabase),
    supabase
      .from("current_inventory_by_location")
      .select("product_id, product_name, location_type, location_name, quantity_on_hand")
      .limit(10000),
    supabase
      .from("route_stock_lines")
      .select("product_id, planned_qty, picked_qty, routes!inner(status, route_date), product:products(name, sku)")
      .limit(10000),
    supabase
      .from("system_activity_logs")
      .select("id, actor_name, action, entity_type, entity_id, entity_label, summary, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(120),
  ]);

  const importRows = (importResult.data ?? []) as ImportBatchRow[];
  const routeRows = (routesResult.data ?? []) as RouteRow[];
  const costRows = (productsResult.data ?? []) as ProductCostRow[];
  const productMappingGaps = (productMappingsResult.data ?? []) as ProductMappingRow[];
  const machineMappingGaps = (machineMappingsResult.data ?? []) as MachineMappingRow[];
  const storageRows = (storageInventoryResult.data ?? []) as StorageInventoryRow[];
  const reservationRows = (reservationResult.data ?? []) as RouteReservationRow[];
  const activityRows = (activityResult.data ?? []) as ActivityLogRow[];

  const importIssues = importRows.filter(isImportFailure);
  const today = new Date().toISOString().slice(0, 10);
  const routeIssues = routeRows.filter((route) => {
    const status = String(route.status ?? "");
    const overdue = Boolean(route.route_date && route.route_date < today && !["completed", "cancelled", "canceled"].includes(status));
    return overdue || Boolean(textValue(route.last_completion_error));
  });
  const costGaps = costRows.filter((product) => {
    const currentCost = numberValue(product.current_cost_price_lyd ?? product.cost_price);
    return currentCost <= 0;
  });
  const financeLinkIssues = buildFinanceLinkIssues(financeDiagnostics);
  const storageIssues = buildStorageIssues(storageRows, reservationRows);
  const recentSystemErrors = buildRecentSystemErrors({
    importIssues,
    routeIssues,
    activityRows,
  });

  const mappingGapCount = Number(productMappingsResult.count ?? 0) + Number(machineMappingsResult.count ?? 0);
  const financeLinkGapCount =
    financeDiagnostics.purchasesMissingFinance.length
    + financeDiagnostics.cashCollectionsMissingFinance.length
    + financeDiagnostics.brokenLinks.length;
  const financeWarningCount =
    financeDiagnostics.balanceInconsistencies.length
    + financeDiagnostics.missingCategories.length
    + financeDiagnostics.ignoredSourceRows.length;

  const loadWarnings = [
    importResult.error ? `VMS imports: ${String((importResult.error as { message?: string } | null)?.message ?? importResult.error)}` : "",
    routesResult.error ? `Routes: ${String((routesResult.error as { message?: string } | null)?.message ?? routesResult.error)}` : "",
    productsResult.error ? `Products: ${String(productsResult.error.message ?? productsResult.error)}` : "",
    productMappingsResult.error ? `VMS products: ${String(productMappingsResult.error.message ?? productMappingsResult.error)}` : "",
    machineMappingsResult.error ? `VMS machines: ${String(machineMappingsResult.error.message ?? machineMappingsResult.error)}` : "",
    storageInventoryResult.error ? `Inventory: ${String(storageInventoryResult.error.message ?? storageInventoryResult.error)}` : "",
    reservationResult.error ? `Route reservations: ${String(reservationResult.error.message ?? reservationResult.error)}` : "",
    activityResult.error ? `Activity log: ${String(activityResult.error.message ?? activityResult.error)}` : "",
    ...financeDiagnostics.errors.map((message) => `Finance: ${message}`),
  ].filter(Boolean);

  const batchRepairOptions: QuickBatchOption[] = (importIssues.length ? importIssues : importRows).slice(0, 20);
  const routeRepairOptions: QuickRouteOption[] = (routeIssues.length ? routeIssues : routeRows).slice(0, 20);

  return (
    <>
      <PageHeader
        title="System Health"
        subtitle="Admin repair console for failed imports, finance source links, broken routes, mapping gaps, storage issues, and recent system errors."
        breadcrumbs={[
          { label: "Admin", href: "/admin" },
          { label: "System Health" },
        ]}
        action={(
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/activity">Activity log</SecondaryButton>
            <SecondaryButton href="/admin/tools">Advanced tools</SecondaryButton>
            <SecondaryButton href="/admin">Back to admin</SecondaryButton>
          </div>
        )}
      />

      {success ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}
      {error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}
      {loadWarnings.length ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Some health checks only partially loaded: {loadWarnings.slice(0, 6).join(" | ")}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Failed imports</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{importIssues.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Missing finance links</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{financeLinkGapCount}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Broken routes</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{routeIssues.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Missing VMS mappings</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{mappingGapCount}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Products without cost</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{costGaps.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Inventory inconsistencies</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{storageIssues.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recent system errors</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{recentSystemErrors.length}</div>
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Routine Repair Actions</h2>
          <p className="mt-1 text-sm text-slate-500">Use these recovery buttons before opening SQL Editor. They run the same admin-safe repair actions already used elsewhere in Snacky OS.</p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <QuickActionCard title="Rebuild refill recommendations" description="Refresh route and refill recommendation rows from the latest active stock snapshot.">
            <form action={rebuildRefillRecommendations} className="space-y-3">
              <HiddenReturnTo />
              <input type="hidden" name="reason" value="System Health quick repair: rebuild refill recommendations." />
              <FormSubmitButton pendingLabel="Rebuilding refill recommendations...">Rebuild refill recommendations</FormSubmitButton>
            </form>
          </QuickActionCard>

          <QuickActionCard title="Backfill finance transactions" description="Create missing finance rows for purchases and counted cash collections without duplicating existing links.">
            <form action={backfillMissingFinanceTransactions} className="space-y-3">
              <HiddenReturnTo />
              <input type="hidden" name="reason" value="System Health quick repair: backfill missing finance transactions." />
              <FormSubmitButton pendingLabel="Backfilling finance transactions...">Backfill finance transactions</FormSubmitButton>
            </form>
          </QuickActionCard>

          <QuickActionCard title="Recalculate inventory" description="Refresh ledger-derived storage balances and highlight negative or over-reserved stock problems.">
            <form action={recalculateStorageBalances} className="space-y-3">
              <HiddenReturnTo />
              <input type="hidden" name="reason" value="System Health quick repair: recalculate inventory balances." />
              <FormSubmitButton pendingLabel="Recalculating inventory...">Recalculate inventory</FormSubmitButton>
            </form>
          </QuickActionCard>

          <QuickActionCard title="Reprocess file" description="Replay a saved VMS batch after mapping fixes or import warnings without using SQL.">
            {!batchRepairOptions.length ? (
              <p className="text-sm text-slate-500">No recent VMS import batches are available.</p>
            ) : (
              <form action={reprocessVmsImportBatch} className="space-y-3">
                <HiddenReturnTo />
                <BatchSelect batches={batchRepairOptions} />
                <FormSubmitButton pendingLabel="Reprocessing file...">Reprocess file</FormSubmitButton>
              </form>
            )}
          </QuickActionCard>

          <QuickActionCard title="Repair route inventory" description="Rebuild route stock lines from inventory movements and clear stuck completion error metadata.">
            {!routeRepairOptions.length ? (
              <p className="text-sm text-slate-500">No recent routes are available for repair.</p>
            ) : (
              <form action={repairStuckRoute} className="space-y-3">
                <HiddenReturnTo />
                <RouteSelect routes={routeRepairOptions} />
                <input type="hidden" name="reason" value="System Health quick repair: repair route inventory and completion metadata." />
                <FormSubmitButton pendingLabel="Repairing route inventory...">Repair route inventory</FormSubmitButton>
              </form>
            )}
          </QuickActionCard>
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Failed imports</h2>
            <p className="mt-1 text-sm text-slate-500">Imports should land as imported. Review warning metadata on any batch that imported successfully but still needs attention.</p>
          </div>
          <SecondaryButton href="/vms-import/sources">Open VMS Data Sources</SecondaryButton>
        </div>
        {!importIssues.length ? (
          <EmptyState title="No failed imports" body="Recent VMS files finished successfully or only have accepted warnings." />
        ) : (
          <DataTable headers={["File", "Report type", "Status", "Imported rows", "Problem", "Actions"]}>
            {importIssues.map((batch) => (
              <tr key={batch.id}>
                <td>
                  <div className="font-medium text-slate-900">{fileLabel(batch)}</div>
                  <div className="text-xs text-slate-500">{formatDateTime(batch.uploaded_at ?? batch.imported_at)}</div>
                </td>
                <td>{statusText(batch.report_type)}</td>
                <td><StatusBadge status={batch.status ?? "unknown"} /></td>
                <td>
                  <div>Found {batch.rows_found ?? 0}</div>
                  <div>Imported {batch.rows_imported ?? 0}</div>
                </td>
                <td className="max-w-xl text-xs text-slate-700">{importIssueMessage(batch)}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton href={`/vms-import/${batch.id}`}>Open</SecondaryButton>
                    <form action={reprocessVmsImportBatch}>
                      <HiddenReturnTo />
                      <input type="hidden" name="batch_id" value={batch.id} />
                      <FormSubmitButton className="btn-secondary" pendingLabel="Reprocessing...">Reprocess</FormSubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Missing finance links</h2>
              <p className="mt-1 text-sm text-slate-500">Every purchase and cash collection should land in <code>financial_transactions</code> immediately.</p>
            </div>
            <form action={backfillMissingFinanceTransactions}>
              <HiddenReturnTo />
              <input type="hidden" name="reason" value="System Health quick repair: backfill missing finance links." />
              <FormSubmitButton className="btn-secondary" pendingLabel="Backfilling finance...">Backfill finance transactions</FormSubmitButton>
            </form>
          </div>
          {!financeLinkIssues.length ? (
            <EmptyState title="No missing finance links" body="Purchases and cash collections currently have active finance rows." />
          ) : (
            <DataTable headers={["Type", "Reference", "Date", "Issue", "Amount / signal"]}>
              {financeLinkIssues.map((row) => (
                <tr key={row.key}>
                  <td><StatusBadge status={row.kind.toLowerCase()} /></td>
                  <td className="font-medium text-slate-900">{row.label}</td>
                  <td>{row.when ?? "-"}</td>
                  <td className="max-w-xl text-xs text-slate-700">{row.issue}</td>
                  <td>{row.amountNote}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        <div className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">Finance quality warnings</h2>
          <p className="mt-1 text-sm text-slate-500">Additional issues that do not always mean a missing link, but still deserve repair.</p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
              <dt>Balance inconsistencies</dt>
              <dd className="font-semibold">{financeDiagnostics.balanceInconsistencies.length}</dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
              <dt>Missing / fallback categories</dt>
              <dd className="font-semibold">{financeDiagnostics.missingCategories.length}</dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
              <dt>Ignored source-generated rows</dt>
              <dd className="font-semibold">{financeDiagnostics.ignoredSourceRows.length}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <SecondaryButton href="/admin/finance-health">Open Finance Health</SecondaryButton>
            <SecondaryButton href="/finance/transactions">Open Finance Transactions</SecondaryButton>
          </div>
          {financeWarningCount ? (
            <p className="mt-4 text-sm text-slate-500">
              Finance still has {financeWarningCount} warning row(s) beyond the missing-link list above.
            </p>
          ) : null}
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Broken routes</h2>
            <p className="mt-1 text-sm text-slate-500">Routes are broken when they are overdue, stuck, or carrying a completion error that operators cannot clear themselves.</p>
          </div>
          <SecondaryButton href="/routes">Open routes</SecondaryButton>
        </div>
        {!routeIssues.length ? (
          <EmptyState title="No broken routes" body="Recent routes are either completed, current, or have no recorded completion error." />
        ) : (
          <DataTable headers={["Route", "Status", "Operator", "Last updated", "Issue", "Actions"]}>
            {routeIssues.map((route) => (
              <tr key={route.id}>
                <td>
                  <div className="font-medium text-slate-900">{route.route_date ?? "-"}</div>
                  <div className="text-xs text-slate-500">{route.id.slice(0, 8)}</div>
                </td>
                <td><StatusBadge status={route.status ?? "unknown"} /></td>
                <td>{routeOperatorName(route)}</td>
                <td>{formatDateTime(route.updated_at ?? route.started_at ?? route.completed_at)}</td>
                <td className="max-w-xl text-xs text-slate-700">{routeIssueMessage(route)}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton href={`/routes/${route.id}`}>Open</SecondaryButton>
                    <form action={repairStuckRoute}>
                      <HiddenReturnTo />
                      <input type="hidden" name="route_id" value={route.id} />
                      <input type="hidden" name="reason" value={`System Health quick repair for route ${route.id}.`} />
                      <FormSubmitButton className="btn-secondary" pendingLabel="Repairing...">Repair route inventory</FormSubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mb-6 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Missing VMS product mappings</h2>
              <p className="mt-1 text-sm text-slate-500">Unmapped VMS products break sales, refill, and route signals.</p>
            </div>
            <SecondaryButton href="/vms-mappings">Open mappings</SecondaryButton>
          </div>
          {!productMappingGaps.length ? (
            <EmptyState title="No VMS product mapping gaps" body="Recent VMS product names are already mapped or intentionally ignored." />
          ) : (
            <DataTable headers={["VMS product", "Status", "Updated"]}>
              {productMappingGaps.map((row) => (
                <tr key={row.id}>
                  <td className="font-medium text-slate-900">{row.vms_product_name ?? row.id}</td>
                  <td><StatusBadge status={row.match_status ?? "unknown"} /></td>
                  <td>{formatDateTime(row.updated_at)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        <div>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Missing VMS machine mappings</h2>
              <p className="mt-1 text-sm text-slate-500">Unmapped VMS machines block route grouping and location-level diagnostics.</p>
            </div>
            <SecondaryButton href="/vms-mappings">Open mappings</SecondaryButton>
          </div>
          {!machineMappingGaps.length ? (
            <EmptyState title="No VMS machine mapping gaps" body="Recent VMS machines are already mapped or intentionally ignored." />
          ) : (
            <DataTable headers={["VMS machine", "Status", "Updated"]}>
              {machineMappingGaps.map((row) => (
                <tr key={row.id}>
                  <td className="font-medium text-slate-900">{row.vms_machine_name ?? row.vms_machine_key ?? row.id}</td>
                  <td><StatusBadge status={row.status ?? "unknown"} /></td>
                  <td>{formatDateTime(row.updated_at)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Products without cost</h2>
            <p className="mt-1 text-sm text-slate-500">Active products need a positive cost so purchases, profit, and restock math stay trustworthy.</p>
          </div>
          <SecondaryButton href="/products">Open products</SecondaryButton>
        </div>
        {!costGaps.length ? (
          <EmptyState title="All active products have cost" body="Current cost values are present for the active product catalog." />
        ) : (
          <DataTable headers={["Product", "SKU", "Current cost", "Fallback cost", "Last purchase"]}>
            {costGaps.slice(0, 30).map((product) => (
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

      <section className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Inventory inconsistencies</h2>
            <p className="mt-1 text-sm text-slate-500">Negative storage or operator-bag balances and route reservations larger than storage are the fastest signals that inventory needs repair.</p>
          </div>
          <form action={recalculateStorageBalances}>
            <HiddenReturnTo />
            <input type="hidden" name="reason" value="System Health quick repair: recalculate inventory balances from storage inconsistencies." />
            <FormSubmitButton className="btn-secondary" pendingLabel="Recalculating...">Recalculate inventory</FormSubmitButton>
          </form>
        </div>
        {!storageIssues.length ? (
          <EmptyState title="No inventory inconsistencies" body="Storage and operator-bag balances are non-negative, and current route reservations fit within visible storage quantities." />
        ) : (
          <DataTable headers={["Type", "Product", "Location / signal", "Location qty", "Storage qty", "Reserved qty", "Issue"]}>
            {storageIssues.map((row) => (
              <tr key={row.key}>
                <td><StatusBadge status={row.kind === "negative_balance" ? "negative balance" : "over reserved"} /></td>
                <td className="font-medium text-slate-900">{row.productName}</td>
                <td>{row.locationLabel}</td>
                <td>{row.quantity}</td>
                <td>{row.storageQty}</td>
                <td>{row.reservedQty || "-"}</td>
                <td className="max-w-xl text-xs text-slate-700">{row.issue}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Recent system errors</h2>
            <p className="mt-1 text-sm text-slate-500">Combined view of import failures, route errors, and recent activity log rows that look like system failures.</p>
          </div>
          <SecondaryButton href="/activity">Open full activity log</SecondaryButton>
        </div>
        {!recentSystemErrors.length ? (
          <EmptyState title="No recent system errors" body="Recent import, route, and activity rows do not currently show obvious error signals." />
        ) : (
          <DataTable headers={["When", "Source", "Title", "Message", "Open"]}>
            {recentSystemErrors.map((row) => (
              <tr key={row.key}>
                <td>{formatDateTime(row.createdAt)}</td>
                <td><StatusBadge status={row.source.toLowerCase()} /></td>
                <td className="font-medium text-slate-900">{row.title}</td>
                <td className="max-w-xl text-xs text-slate-700">{row.message}</td>
                <td>{row.href ? <Link href={row.href} className="link-secondary">Open</Link> : "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
