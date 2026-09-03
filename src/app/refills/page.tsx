import { PaginationControls } from "@/components/PaginationControls";
import { RefillForecastDashboard } from "@/components/RefillForecastDashboard";
import { VmsDataSourceCard } from "@/components/VmsDataSourceCard";
import { DataTable, EmptyState, MobileCardList, MobileField, MobileRecordCard, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { buildMachineRefillForecasts, type RefillFillLine, type RefillMachine, type RefillStockHistory } from "@/lib/refill-forecast";
import { getServerI18n } from "@/lib/i18n/server";
import { queryVmsDashboardBatches, type VmsDashboardBatch } from "@/lib/vms-dashboard-source";

export const dynamic = "force-dynamic";

const RECOMMENDATION_BASE_SELECT = "machine_id, machine_name, slot_code, product_id, product_name, current_qty, capacity, par_qty, suggested_qty, final_qty_to_take, available_storage_qty, priority";
const RECOMMENDATION_ENRICHED_SELECT = `${RECOMMENDATION_BASE_SELECT}, min_qty, latest_vms_at, imported_at, import_batch_id, recommendation_source, tray_status`;
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

function unitQuantity(value: number | null | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function priorityRank(priority: string | null | undefined) {
  return PRIORITY_RANK[String(priority ?? "none").toLowerCase()] ?? 5;
}

function formatSource(row: Pick<RefillRecommendationRow, "source_file_name" | "recommendation_source">) {
  if (row.source_file_name) return row.source_file_name;
  const source = String(row.recommendation_source ?? "").toLowerCase();
  if (source.includes("sales") || source.includes("transaction") || source.includes("velocity")) return "Order Details";
  if (source.includes("threshold") || source.includes("manual")) return "Storage threshold";
  return "Unknown";
}

function recommendationReason(row: RefillRecommendationRow) {
  const source = String(row.recommendation_source ?? "").toLowerCase();
  const trayStatus = String(row.tray_status ?? "").toLowerCase();
  if (source.includes("sales") || source.includes("transaction") || source.includes("velocity")) return "High sales velocity";
  if (source.includes("threshold") || source.includes("manual")) return "Storage threshold";
  if (unitQuantity(row.available_storage_qty) <= 0) return "Low storage quantity";
  if (unitQuantity(row.current_qty) <= 0 || trayStatus.includes("out") || trayStatus.includes("empty")) return "Out of stock machine";
  return "Low machine stock";
}

type RefillRecommendationRow = {
  machine_id?: string | null;
  machine_name: string | null;
  slot_code: string | null;
  product_id?: string | null;
  product_name: string | null;
  current_qty: number | null;
  capacity: number | null;
  min_qty?: number | null;
  par_qty: number | null;
  suggested_qty: number | null;
  final_qty_to_take: number | null;
  available_storage_qty: number | null;
  priority: string | null;
  imported_at?: string | null;
  latest_vms_at?: string | null;
  import_batch_id?: string | null;
  recommendation_source?: string | null;
  tray_status?: string | null;
  source_file_name?: string | null;
  source_uploaded_at?: string | null;
};

type MachineRefillHistoryRow = {
  id: string;
  legacy_refill_id: string | null;
  refill_at: string | null;
  machine_name: string | null;
  operator_email: string | null;
  fill_status: string | null;
  issues_found: boolean | null;
  issue_notes: string | null;
  machine_photo_url: string | null;
  machine_photo_path: string | null;
  machine?: { name?: string | null; machine_code?: string | null; location?: { id?: string | null; name?: string | null } | { id?: string | null; name?: string | null }[] | null } | null;
  operator?: { full_name?: string | null; email?: string | null } | null;
};

function refillHistoryMachineName(row: MachineRefillHistoryRow) {
  const formatted = formatMachineDisplayName(row.machine, { includeArea: true });
  return formatted === "Unknown machine" ? row.machine_name ?? "Unknown machine" : formatted;
}

type ProductRecommendationRow = {
  productKey: string;
  productName: string;
  storageQty: number;
  recommendedQty: number;
  machineCount: number;
  machines: string[];
  priority: string | null;
  reason: string;
  source: string;
  latestImport: string | null;
};

function groupRecommendationsByProduct(rows: RefillRecommendationRow[]) {
  const grouped = new Map<string, ProductRecommendationRow>();
  rows.forEach((row, index) => {
    const productKey = row.product_id ?? row.product_name ?? `unknown-${index}`;
    const current = grouped.get(productKey);
    const takeQty = unitQuantity(row.suggested_qty);
    const machineName = row.machine_name ?? "Unknown machine";
    const source = formatSource(row);
    const reason = recommendationReason(row);
    if (!current) {
      grouped.set(productKey, {
        productKey,
        productName: row.product_name ?? "Unknown product",
        storageQty: unitQuantity(row.available_storage_qty),
        recommendedQty: takeQty,
        machineCount: 1,
        machines: [machineName],
        priority: row.priority,
        reason,
        source,
        latestImport: row.imported_at ?? row.source_uploaded_at ?? row.latest_vms_at ?? null,
      });
      return;
    }
    current.storageQty = Math.max(current.storageQty, unitQuantity(row.available_storage_qty));
    current.recommendedQty += takeQty;
    if (!current.machines.includes(machineName)) current.machines.push(machineName);
    current.machineCount = current.machines.length;
    const rowPriorityRank = priorityRank(row.priority);
    const currentPriorityRank = priorityRank(current.priority);
    if (rowPriorityRank < currentPriorityRank) current.priority = row.priority;
    if (current.source === "Unknown" && source !== "Unknown") current.source = source;
    if (rowPriorityRank < currentPriorityRank || current.reason === "Low machine stock") current.reason = reason;
    const rowLatest = row.imported_at ?? row.source_uploaded_at ?? row.latest_vms_at ?? null;
    if (rowLatest && (!current.latestImport || rowLatest > current.latestImport)) current.latestImport = rowLatest;
  });
  return Array.from(grouped.values()).sort((a, b) => {
    const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return b.recommendedQty - a.recommendedQty || a.productName.localeCompare(b.productName);
  });
}

type SupabaseLikeError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };

function isMissingRecommendationMetadataError(error: SupabaseLikeError | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

async function loadRefillRecommendations(supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>) {
  const enrichedResult = await supabase
    .from("refill_recommendations")
    .select(RECOMMENDATION_ENRICHED_SELECT, { count: "exact" })
    .limit(1000);

  if (!enrichedResult.error || !isMissingRecommendationMetadataError(enrichedResult.error)) return enrichedResult;

  console.warn("[refills] Refill recommendation metadata columns are missing; retrying with the stable recommendation contract.", enrichedResult.error);
  return supabase
    .from("refill_recommendations")
    .select(RECOMMENDATION_BASE_SELECT, { count: "exact" })
    .limit(1000);
}

async function loadForecastMachines(supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>) {
  const enriched = await supabase
    .from("machines")
    .select("id, name, machine_code, status, refill_open_days, refill_critical_percent, refill_today_percent, refill_target_percent, refill_minimum_units, refill_manual_daily_units")
    .eq("status", "active")
    .order("name");
  if (!enriched.error || !isMissingRecommendationMetadataError(enriched.error)) return enriched;
  return supabase.from("machines").select("id, name, machine_code, status").eq("status", "active").order("name");
}

function refillForecastClock() {
  const now = new Date();
  return { now, since: new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString() };
}

async function attachRecommendationSources(supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>, rows: RefillRecommendationRow[]) {
  const batchIds = Array.from(new Set(rows.map((row) => row.import_batch_id).filter((id): id is string => Boolean(id))));
  if (!batchIds.length) return rows;

  const { data, error } = await supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, uploaded_at")
    .in("id", batchIds);

  if (error) {
    console.warn("[refills] Could not load VMS import source metadata; using Unknown source fallback.", error);
    return rows;
  }

  const batchById = new Map((data ?? []).map((batch) => [String(batch.id), batch]));
  return rows.map((row) => {
    const batch = row.import_batch_id ? batchById.get(row.import_batch_id) : null;
    return {
      ...row,
      source_file_name: row.source_file_name ?? batch?.original_file_name ?? batch?.file_name ?? null,
      source_uploaded_at: row.source_uploaded_at ?? batch?.uploaded_at ?? null,
    };
  });
}

async function RefillsPageContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const { locale } = await getServerI18n();
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const forecastClock = refillForecastClock();
  await requireCurrentProfileForPath("/refills");
  const supabase = getSupabaseAdminClient() ?? await getAuthenticatedSupabaseServerClient();
  const [recommendationsResult, stockCountResult, historyResult, historyCountResult, historyIssueCountResult, batchResult, forecastMachinesResult, forecastLatestStockResult, forecastHistoryResult, forecastFillResult] = supabase
    ? await Promise.all([
        loadRefillRecommendations(supabase),
        supabase
          .from("latest_vms_stock_by_slot")
          .select("id", { count: "exact", head: true })
          .eq("source_provider", "xy"),
        supabase
          .from("machine_refill_history")
          .select("id, legacy_refill_id, refill_at, machine_name, operator_email, fill_status, issues_found, issue_notes, machine_photo_url, machine_photo_path, linked_issue_id, machine:machines(name, machine_code, location:locations(id, name)), operator:team_members(full_name, email)")
          .order("refill_at", { ascending: false })
          .range(from, to),
        supabase
          .from("machine_refill_history")
          .select("id", { count: "exact", head: true }),
        supabase
          .from("machine_refill_history")
          .select("id", { count: "exact", head: true })
          .eq("issues_found", true),
        safeSupabaseQuery<VmsDashboardBatch>({
          label: "refills.vms_import_batches",
          promise: queryVmsDashboardBatches(supabase, {
            reportTypes: ["stock", "machine_stock_snapshot", "planogram"],
            orderBy: "uploaded_at",
            ascending: false,
          }),
        }),
        loadForecastMachines(supabase),
        safeSupabaseQuery<RefillStockHistory>({
          label: "refills.forecast.latest_vms_stock_by_slot",
          promise: supabase.from("latest_vms_stock_by_slot").select("machine_id, product_id, slot_code, current_qty, capacity, captured_at, import_batch_id").eq("source_provider", "xy"),
        }),
        safeSupabaseQuery<RefillStockHistory>({
          label: "refills.forecast.vms_stock_snapshots",
          promise: supabase
            .from("vms_stock_snapshots")
            .select("machine_id, product_id, slot_code, current_qty, capacity, captured_at, import_batch_id, sync_run_id, batch:vms_import_batches!inner(status, deleted_at)")
            .eq("source_provider", "xy")
            .eq("import_row_status", "imported")
            .in("batch.status", ["imported", "imported_with_warnings"])
            .is("batch.deleted_at", null)
            .gte("captured_at", forecastClock.since)
            .order("captured_at", { ascending: true })
            .limit(10000),
        }),
        safeSupabaseQuery<RefillFillLine>({
          label: "refills.forecast.route_stop_fill_lines",
          promise: supabase
            .from("route_stop_fill_lines")
            .select("machine_id, product_id, actual_qty, created_at")
            .gte("created_at", forecastClock.since)
            .order("created_at", { ascending: true })
            .limit(5000),
        }),
      ])
    : [{ data: null, error: null, count: 0 }, { count: 0, error: null }, { data: null, error: null }, { count: 0, error: null }, { count: 0, error: null }, { data: [], error: null, count: 0 }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  const { data: recommendations, error } = recommendationsResult;
  const latestXyBatchIds = new Set(
    (forecastLatestStockResult.data ?? [])
      .map((row) => String((row as RefillStockHistory).import_batch_id ?? ""))
      .filter(Boolean),
  );
  const loadedRecommendationRows = (recommendations ?? []) as RefillRecommendationRow[];
  const canIdentifyRecommendationBatch = loadedRecommendationRows.some((row) => Boolean(row.import_batch_id));
  const rawRecommendationRows = latestXyBatchIds.size > 0 && canIdentifyRecommendationBatch
    ? loadedRecommendationRows.filter((row) => Boolean(row.import_batch_id && latestXyBatchIds.has(row.import_batch_id)))
    : latestXyBatchIds.size > 0
      ? loadedRecommendationRows
      : [];
  const recommendationRows = supabase ? await attachRecommendationSources(supabase, rawRecommendationRows) : rawRecommendationRows;
  const productRecommendationRows = groupRecommendationsByProduct(recommendationRows);
  const hasVmsStock = Boolean((stockCountResult.count ?? 0) > 0);
  const latestRecommendationSource = recommendationRows.find((row) => formatSource(row) !== "Unknown" || row.source_uploaded_at);
  const historyUnavailable = historyResult.error?.code === "PGRST205";
  const historyRows = historyUnavailable ? [] : ((historyResult.data ?? []) as MachineRefillHistoryRow[]);
  const coverageByMachine = new Map<string, { machineId: string; requestedUnits: number; fillableUnits: number }>();
  recommendationRows.forEach((row) => {
    if (!row.machine_id) return;
    const current = coverageByMachine.get(row.machine_id) ?? { machineId: row.machine_id, requestedUnits: 0, fillableUnits: 0 };
    current.requestedUnits += unitQuantity(row.suggested_qty);
    current.fillableUnits += unitQuantity(row.final_qty_to_take);
    coverageByMachine.set(row.machine_id, current);
  });
  const forecasts = buildMachineRefillForecasts({
    machines: (forecastMachinesResult.data ?? []) as RefillMachine[],
    latestStock: (forecastLatestStockResult.data ?? []) as RefillStockHistory[],
    stockHistory: (forecastHistoryResult.data ?? []) as RefillStockHistory[],
    fills: (forecastFillResult.data ?? []) as RefillFillLine[],
    storageCoverage: Array.from(coverageByMachine.values()),
    now: forecastClock.now,
  });
  const forecastError = forecastMachinesResult.error ?? forecastLatestStockResult.error ?? forecastHistoryResult.error ?? forecastFillResult.error;

  if (error ?? stockCountResult.error) console.error("[refills] Failed to load refill recommendations", error ?? stockCountResult.error);
  if (historyResult.error && !historyUnavailable) console.error("[refills] Failed to load machine refill history", historyResult.error);

  return (
    <>
      <PageHeader title="Refills" subtitle="System recommendations plus machine refill completion proofs from imported history and live operator work." />
      {!supabase ? (
        <EmptyState title="Connect Supabase to activate refills" body="Add environment variables and restart the app." />
      ) : (
        <div className="space-y-6">
          {forecastError ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">The refill forecast could not load every trend source. Existing product recommendations remain available below.</div>
          ) : (
            <RefillForecastDashboard forecasts={forecasts} locale={locale} />
          )}
          <VmsDataSourceCard
            batches={(batchResult.data ?? []) as VmsDashboardBatch[]}
            error={batchResult.error}
            title="Data Source"
            subtitle="Refill recommendations read the latest active machine stock snapshot and planogram-style stock files. Imported rows stay visible even when storage is low."
            showSales={false}
            showStock
          />
          <section>
            <div className="mb-3 flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">Recommended products</h2>
              <p className="text-sm text-slate-500">Generated from imported VMS machine goods stock, par levels, and current storage availability.</p>
              <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
                Source: {latestRecommendationSource ? formatSource(latestRecommendationSource) : "Unknown"}
                {latestRecommendationSource?.source_uploaded_at ? ` uploaded ${new Date(latestRecommendationSource.source_uploaded_at).toLocaleString("en-US")}` : ""}.
              </div>
            </div>
            {!hasVmsStock ? (
              <EmptyState title="No VMS stock synced yet" body="Sync XY VMS Machine Goods to generate refill recommendations." />
            ) : error && !productRecommendationRows.length ? (
              <EmptyState title="Could not load refill recommendations" body="The recommendation engine is unavailable. Snacky OS hid the database error from the page; check server logs for details." />
            ) : !productRecommendationRows.length ? (
              <EmptyState title="No refill recommendations yet" body="All synced VMS stock is either full, inactive, or waiting on product mapping review." />
            ) : (
              <>
                <MobileCardList>
                  {productRecommendationRows.map((row) => (
                    <MobileRecordCard key={row.productKey}>
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words font-semibold text-slate-900">{row.productName}</h3>
                          <p className="mt-1 text-sm text-slate-500">{row.machineCount} machine{row.machineCount === 1 ? "" : "s"}: {row.machines.slice(0, 3).join(", ")}{row.machines.length > 3 ? ` +${row.machines.length - 3} more` : ""}</p>
                        </div>
                        <StatusBadge status={row.priority} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <MobileField label="Storage qty">{row.storageQty}</MobileField>
                        <MobileField label="Recommended qty">{row.recommendedQty}</MobileField>
                        <MobileField label="Reason">{row.reason}</MobileField>
                        <MobileField label="Source">{row.source}</MobileField>
                      </div>
                    </MobileRecordCard>
                  ))}
                </MobileCardList>
                <DataTable className="hidden md:block" headers={["Product", "Storage qty", "Recommended qty", "Machines needing it", "Reason", "Priority", "Source", "Latest import"]}>
                  {productRecommendationRows.map((row) => (
                    <tr key={row.productKey}>
                      <td className="font-medium">{row.productName}</td>
                      <td>{row.storageQty}</td>
                      <td className="font-semibold text-slate-900">{row.recommendedQty}</td>
                      <td>{row.machineCount} — {row.machines.slice(0, 4).join(", ")}{row.machines.length > 4 ? ` +${row.machines.length - 4} more` : ""}</td>
                      <td>{row.reason}</td>
                      <td><StatusBadge status={row.priority} /></td>
                      <td>{row.source}</td>
                      <td>{row.latestImport ? new Date(row.latestImport).toLocaleString("en-US") : "-"}</td>
                    </tr>
                  ))}
                </DataTable>
              </>
            )}
          </section>

          <section>
            <div className="mb-3 flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">Machine refill history</h2>
              <p className="text-sm text-slate-500">Imported old operator forms and live completion proofs. Imported CSV rows stay as history only; live operator stops also create inventory movements.</p>
            </div>
            {historyUnavailable ? (
              <EmptyState title="Refill history not installed" body="Run the machine_refill_history migration to save refill completion proofs." />
            ) : !historyRows.length ? (
              <EmptyState title="No refill history yet" body="Complete an operator machine stop or import old machine refill forms." />
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="surface-card"><div className="text-sm text-slate-500">Total refill proofs</div><div className="mt-1 text-3xl font-semibold text-slate-900">{historyCountResult.count ?? historyRows.length}</div></div>
                  <div className="surface-card"><div className="text-sm text-slate-500">Issue flags</div><div className="mt-1 text-3xl font-semibold text-slate-900">{historyIssueCountResult.count ?? 0}</div></div>
                  <div className="surface-card"><div className="text-sm text-slate-500">Latest refill</div><div className="mt-1 text-lg font-semibold text-slate-900">{historyRows[0]?.refill_at ? new Date(historyRows[0].refill_at).toLocaleDateString("en-US") : "-"}</div></div>
                </div>
                <MobileCardList>
                  {historyRows.map((row) => (
                    <MobileRecordCard key={row.id}>
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words font-semibold text-slate-900">{refillHistoryMachineName(row)}</h3>
                          <p className="mt-1 text-sm text-slate-500">{row.refill_at ? new Date(row.refill_at).toLocaleString("en-US") : "-"}</p>
                        </div>
                        <StatusBadge status={row.fill_status || "unknown"} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <MobileField label="Operator">{row.operator?.full_name ?? row.operator_email ?? "-"}</MobileField>
                        <MobileField label="Issue">{row.issues_found ? "Yes" : "No"}</MobileField>
                      </div>
                      {row.issue_notes ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{row.issue_notes}</p> : null}
                      {row.machine_photo_url ? (
                        <a className="mt-3 inline-flex text-sm font-semibold text-amber-700" href={row.machine_photo_url} target="_blank" rel="noreferrer">Open photo</a>
                      ) : row.machine_photo_path ? (
                        <p className="mt-3 break-all text-xs text-slate-500">{row.machine_photo_path}</p>
                      ) : null}
                    </MobileRecordCard>
                  ))}
                </MobileCardList>
                <DataTable className="hidden md:block" headers={["Date", "Machine", "Operator", "Status", "Issue", "Photo", "Source ID"]}>
                  {historyRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.refill_at ? new Date(row.refill_at).toLocaleString("en-US") : "-"}</td>
                      <td className="font-medium">{refillHistoryMachineName(row)}</td>
                      <td>{row.operator?.full_name ?? row.operator_email ?? "-"}</td>
                      <td><StatusBadge status={row.fill_status || "unknown"} /></td>
                      <td>{row.issues_found ? <StatusBadge status="review" /> : <StatusBadge status="ok" />}{row.issue_notes ? <div className="mt-1 max-w-xs text-xs text-slate-500">{row.issue_notes}</div> : null}</td>
                      <td>{row.machine_photo_url ? <a className="link-secondary" href={row.machine_photo_url} target="_blank" rel="noreferrer">Open</a> : row.machine_photo_path ? <span className="text-xs text-slate-500">{row.machine_photo_path}</span> : "-"}</td>
                      <td>{row.legacy_refill_id}</td>
                    </tr>
                  ))}
                </DataTable>
                <PaginationControls basePath="/refills" searchParams={params} page={page} pageSize={pageSize} totalCount={historyCountResult.count ?? 0} itemLabel="refill proofs" />
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function isNextNavigationSignal(error: unknown) {
  const digest = error && typeof error === "object" ? String((error as { digest?: unknown }).digest ?? "") : "";
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest === "DYNAMIC_SERVER_USAGE";
}

export default async function RefillsPage(props: Parameters<typeof RefillsPageContent>[0]) {
  try {
    return await RefillsPageContent(props);
  } catch (error) {
    if (isNextNavigationSignal(error)) throw error;
    console.error("[refills] Page-level render guard caught an unexpected error", error);
    return (
      <>
        <PageHeader title="Refills" subtitle="System recommendations plus machine refill completion proofs from imported history and live operator work." />
        <EmptyState title="Something did not load" body="Snacky OS recovered from a VMS data load error. Please retry after the latest import finishes or contact admin." />
      </>
    );
  }
}
