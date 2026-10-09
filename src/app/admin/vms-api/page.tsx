import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getXyVmsConfig } from "@/lib/xy-vms-api";
import { getXyWebApiConfig } from "@/lib/xy-web-api";
import { getXyLiveSalesConfig, latestXyLiveSalesHealth } from "@/lib/xy-live-sales-sync";
import {
  syncXyAllAction,
  syncXyMachineGoodsAction,
  syncXyMachinesAction,
  syncXyMachineStatusAction,
  syncXyProductsAction,
  syncXyLiveSalesAction,
  testXyOfficialApiAction,
  testXyWebDashboardAction,
} from "@/lib/xy-vms-actions";

export const dynamic = "force-dynamic";

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function compactErrors(value: unknown) {
  const errors = Array.isArray(value) ? value : [];
  if (!errors.length) return "-";
  return errors.slice(0, 3).map(String).join(" | ");
}

type XySyncRunRow = {
  id: string;
  provider: string | null;
  sync_type: string | null;
  status: string | null;
  row_count: number | null;
  rows_imported: number | null;
  rows_updated: number | null;
  rows_skipped: number | null;
  error_count: number | null;
  message: string | null;
  errors: unknown;
  response_summary?: unknown;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
};

type XyEndpointSummary = {
  endpoint?: string | null;
  requestDebug?: {
    endpoint?: string | null;
    businessParams?: Record<string, unknown> | null;
    reqData?: string | null;
    timestamp?: string | null;
    maskedKey?: string | null;
    maskedSign?: string | null;
  } | null;
  httpStatus?: number | null;
  xyCode?: string | number | null;
  message?: string | null;
  dataRowCount?: number | null;
  sampleRows?: unknown;
  requestSigned?: boolean | null;
};

type XyWebDashboardSummary = {
  endpoint?: string | null;
  httpStatus?: number | null;
  success?: boolean | null;
  rowCount?: number | null;
  sampleRows?: unknown;
  message?: string | null;
  error?: string | null;
};

function connectionStatus(config: ReturnType<typeof getXyVmsConfig>) {
  if (!config.enabled) return { status: "disabled", label: "Disabled" };
  if (!config.ready) return { status: "needs_configuration", label: "Needs configuration" };
  return { status: "ready", label: "Ready" };
}

function webConnectionStatus(config: ReturnType<typeof getXyWebApiConfig>) {
  if (!config.enabled) return { status: "disabled", label: "Disabled" };
  if (!config.ready) return { status: "needs_configuration", label: "Needs configuration" };
  return { status: "ready", label: "Ready" };
}

function liveSalesConnectionStatus(
  config: ReturnType<typeof getXyLiveSalesConfig>,
  latestSaleAt: string | null,
) {
  if (!config.enabled) return { status: "disabled", label: "Disabled" };
  if (!config.ready) return { status: "needs_configuration", label: "Needs configuration" };
  const timestamp = Date.parse(String(latestSaleAt ?? ""));
  if (!Number.isFinite(timestamp)) return { status: "needs_review", label: "No live sales yet" };
  const ageMs = Date.now() - timestamp;
  if (ageMs <= 48 * 60 * 60 * 1000) return { status: "completed", label: "Fresh" };
  return { status: "needs_review", label: "Stale" };
}

function SyncForm({
  action,
  label,
  primary = false,
  disabled = false,
  title,
}: {
  action: (formData?: FormData) => Promise<void>;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <form action={action}>
      <button type="submit" disabled={disabled} title={title} className={`${primary ? "btn-primary" : "btn-secondary"} inline-flex w-full items-center justify-center`}>
        <span>{label}</span>
      </button>
    </form>
  );
}

function endpointSummaries(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter((item): item is XyEndpointSummary => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function webDashboardSummary(value: unknown): XyWebDashboardSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as XyWebDashboardSummary;
}

function officialQueryMachineSucceeded(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = (value as Record<string, unknown>).queryMachine as XyEndpointSummary | undefined;
  const httpStatus = Number(summary?.httpStatus ?? 0);
  return httpStatus >= 200 && httpStatus < 300 && String(summary?.xyCode ?? "") === "1" && Number(summary?.dataRowCount ?? 0) > 0;
}

function sampleRowsText(value: unknown) {
  if (!Array.isArray(value) || !value.length) return "-";
  return JSON.stringify(value, null, 2);
}

function debugText(summary: XyEndpointSummary) {
  const debug = summary.requestDebug;
  if (!debug) return "-";
  return JSON.stringify(
    {
      endpoint: debug.endpoint ?? summary.endpoint ?? "-",
      businessParams: debug.businessParams ?? {},
      reqData: debug.reqData ?? "",
      timestamp: debug.timestamp ?? "",
      maskedKey: debug.maskedKey ?? "Not set",
      maskedSign: debug.maskedSign ?? "Not set",
    },
    null,
    2,
  );
}

export default async function AdminVmsApiPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);

  const config = getXyVmsConfig();
  const webConfig = getXyWebApiConfig();
  const liveSalesConfig = getXyLiveSalesConfig();
  const status = connectionStatus(config);
  const webStatus = webConnectionStatus(webConfig);
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="XY VMS API unavailable" body="Supabase is not configured, so Snacky OS cannot save sync logs or snapshots." />
      </>
    );
  }

  const [
    runsResult,
    pagedRunsResult,
    productCatalogCount,
    stockSnapshotCount,
    statusSnapshotCount,
    needsReviewCount,
    mappedMachinesResult,
    liveStockMachinesResult,
    currentUnmappedRowsResult,
  ] = await Promise.all([
    supabase
      .from("vms_sync_runs")
      .select("id, provider, sync_type, status, row_count, rows_imported, rows_updated, rows_skipped, error_count, message, errors, response_summary, started_at, completed_at, created_at")
      .in("provider", ["xy", "xy_web"])
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("vms_sync_runs")
      .select("id, provider, sync_type, status, row_count, rows_imported, rows_updated, rows_skipped, error_count, message, errors, response_summary, started_at, completed_at, created_at", { count: "exact" })
      .in("provider", ["xy", "xy_web"])
      .order("created_at", { ascending: false })
      .range(from, to),
    supabase.from("vms_product_catalog_snapshots").select("id", { count: "exact", head: true }),
    supabase.from("vms_stock_snapshots").select("id", { count: "exact", head: true }).eq("source_provider", "xy"),
    supabase.from("vms_machine_status_snapshots").select("id", { count: "exact", head: true }),
    supabase.from("vms_product_mappings").select("id", { count: "exact", head: true }).eq("match_status", "needs_review"),
    supabase.from("machines").select("id,name,machine_code,vms_machine_id,status,vms_last_synced_at,vms_online_status").not("vms_machine_id","is",null).order("name"),
    supabase.from("latest_vms_stock_by_slot").select("machine_id,slot_code,captured_at").eq("source_provider","xy").order("captured_at",{ascending:false}).limit(5000),
    supabase.from("latest_vms_stock_by_slot").select("vms_product_id").eq("source_provider","xy").not("vms_product_id","is",null).limit(5000),
  ]);

  const loadError =
    runsResult.error ??
    pagedRunsResult.error ??
    productCatalogCount.error ??
    stockSnapshotCount.error ??
    statusSnapshotCount.error ??
    needsReviewCount.error ??
    mappedMachinesResult.error ??
    liveStockMachinesResult.error ??
    currentUnmappedRowsResult.error;

  if (loadError) {
    console.error("[xy-vms-admin] Failed to load XY sync dashboard", loadError);
    return (
      <>
        <ErrorState title="Could not load XY VMS API dashboard" body="Run the latest Supabase migrations, then refresh this page." />
      </>
    );
  }

  const liveSalesHealth = await latestXyLiveSalesHealth();
  const liveSalesStatus = liveSalesConnectionStatus(liveSalesConfig, liveSalesHealth.latestSaleAt);
  const runs = (runsResult.data ?? []) as XySyncRunRow[];
  const pagedRuns = (pagedRunsResult.data ?? []) as XySyncRunRow[];
  const lastCompleted = runs.find((run) => run.provider === "xy" && !String(run.sync_type ?? "").startsWith("test_") && run.completed_at);
  const latestOfficialTest = runs.find((run) => run.provider === "xy" && run.sync_type === "test_official");
  const latestOfficialEndpointSummaries = endpointSummaries(latestOfficialTest?.response_summary);
  const officialTestPassed = officialQueryMachineSucceeded(latestOfficialTest?.response_summary);
  const syncDisabled = !config.ready || !officialTestPassed;
  const syncDisabledTitle = !config.ready ? "Complete the server-side official XY configuration first." : "Run a successful official queryMachine test first.";
  const mappedMachines=(mappedMachinesResult.data??[]) as Array<{id:string;name:string;machine_code:string;vms_machine_id:string|null;status:string|null;vms_last_synced_at:string|null;vms_online_status:string|null}>;
  const liveStockRows=(liveStockMachinesResult.data??[]) as Array<{machine_id:string|null;slot_code:string|null;captured_at:string|null}>;
  const liveStockMachineIds=new Set(liveStockRows.map(row=>String(row.machine_id??"")).filter(Boolean));
  const machinesMissingLiveStock=mappedMachines.filter(machine=>!liveStockMachineIds.has(machine.id));
  const diagnoseMissingStock=(machine:(typeof mappedMachines)[number])=>{
    if(!machine.vms_last_synced_at)return "Not returned by current official XY machine sync — verify or remove stale local XY link.";
    if(String(machine.vms_online_status??"")==="0")return "Returned by XY but currently offline and has no configured stock lanes in the active snapshot.";
    return "Returned by XY but no usable configured stock lanes were present in the active snapshot.";
  };
  const latestXyStockAt=liveStockRows[0]?.captured_at??null;
  // A current active batch can safely preserve a previously verified selection
  // when XY reports impossible values. It MUST remain visibly stale.
  const stockFreshnessCutoff=Date.now()-60*60*1000;
  const staleStockRows=liveStockRows.filter(row=>{
    const timestamp=Date.parse(String(row.captured_at??""));
    return !Number.isFinite(timestamp)||timestamp<stockFreshnessCutoff;
  });
  const staleStockMachines=new Set(staleStockRows.map(row=>String(row.machine_id??"")).filter(Boolean));
  const staleStockNames=mappedMachines.filter(machine=>staleStockMachines.has(machine.id)).map(machine=>machine.name);
  const currentXyProductIds=Array.from(new Set((currentUnmappedRowsResult.data??[]).map((row:any)=>String(row.vms_product_id??"").trim()).filter(Boolean)));
  const {count:currentUnmappedCount}=currentXyProductIds.length?await supabase.from("vms_product_mappings").select("id",{count:"exact",head:true}).eq("match_status","needs_review").in("vms_product_id",currentXyProductIds):{count:0};
  const machineCoverageLabel=`${liveStockMachineIds.size}/${mappedMachines.length}`;
  const latestWebTest = runs.find((run) => run.sync_type === "web_dashboard_test");
  const latestWebDashboardSummary = webDashboardSummary(latestWebTest?.response_summary);

  return (
    <>
      <PageHeader
        title="XY VMS API"
        subtitle="Server-side Xingyuan sync for machines, VMS products, aisle goods stock, and machine status."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <section className="surface-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-slate-500">Official API</div>
            <StatusBadge status={status.status} />
          </div>
          <div className="text-2xl font-semibold text-slate-900">{status.label}</div>
          <div className="mt-3 space-y-1 text-sm text-slate-600">
            <div className="break-all">Base URL: {config.baseUrl}</div>
            <div>Merchant: {config.maskedMerchantId}</div>
            <div>Key: {config.maskedKey}</div>
            <div>Secret: {config.secret ? "Configured" : "Not set"}</div>
            <div>Signing: {config.signingMode}</div>
          </div>
        </section>

        <section className="surface-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-slate-500">Web Fallback</div>
            <StatusBadge status={webStatus.status} />
          </div>
          <div className="text-2xl font-semibold text-slate-900">{webStatus.label}</div>
          <div className="mt-3 space-y-1 text-sm text-slate-600">
            <div>Merchant: {webConfig.maskedMerchantId}</div>
            <div>Authorization: {webConfig.maskedAuthorization}</div>
            <div>Language/channel: {webConfig.language || "-"} / {webConfig.channel || "-"}</div>
          </div>
        </section>

        <section className="surface-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-slate-500">Live Sales</div>
            <StatusBadge status={liveSalesStatus.status} label={liveSalesStatus.label} />
          </div>
          <div className="text-sm font-semibold text-slate-900">{formatDate(liveSalesHealth.latestSaleAt)}</div>
          <div className="mt-3 space-y-1 text-xs text-slate-600">
            <div>Latest sale received</div>
            <div>Last sync: {formatDate(liveSalesHealth.latestRunAt)}</div>
            <div>Last inserted: {liveSalesHealth.latestInsertedRows}</div>
          </div>
        </section>

        <section className="surface-card">
          <div className="mb-3 text-sm font-medium text-slate-500">Last Sync</div>
          <div className="text-lg font-semibold text-slate-900">{formatDate(lastCompleted?.completed_at)}</div>
          <p className="mt-3 text-sm leading-6 text-slate-500">Latest completed XY sync run saved in `vms_sync_runs`.</p>
        </section>

        <section className="surface-card">
          <div className="mb-3 text-sm font-medium text-slate-500">Imported Data</div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-xl font-semibold text-slate-900">{productCatalogCount.count ?? 0}</div><div className="text-xs text-slate-500">Products</div></div>
            <div><div className="text-xl font-semibold text-slate-900">{stockSnapshotCount.count ?? 0}</div><div className="text-xs text-slate-500">Stock</div></div>
            <div><div className="text-xl font-semibold text-slate-900">{statusSnapshotCount.count ?? 0}</div><div className="text-xs text-slate-500">Status</div></div>
          </div>
        </section>

        <section className="surface-card">
          <div className="mb-3 text-sm font-medium text-slate-500">Needs Review</div>
          <div className="text-2xl font-semibold text-slate-900">{needsReviewCount.count ?? 0}</div>
          <p className="mt-3 text-sm leading-6 text-slate-500">Unmatched VMS products are kept for mapping instead of being dropped.</p>
        </section>
      </div>

      <section className="surface-card mb-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Live XY Connection Health</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">Operational coverage from the active verified XY stock snapshot. This does not trigger a sync.</p>
          </div>
          <StatusBadge status={machinesMissingLiveStock.length || staleStockRows.length ? "needs_review" : "completed"} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">XY-linked machines</div><strong className="mt-1 block text-2xl">{mappedMachines.length}</strong></div>
          <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Live stock coverage</div><strong className="mt-1 block text-2xl">{machineCoverageLabel}</strong></div>
          <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Latest verified stock</div><strong className="mt-1 block text-sm">{formatDate(latestXyStockAt)}</strong></div>
        </div>
        {staleStockRows.length ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <strong className="text-amber-950">Stale XY selections: {staleStockRows.length}</strong>
          <p className="mt-1 text-sm text-amber-900">The following machines include values older than one hour. These are last-verified readings, NOT current XY inventory. Inspect the actual XY lane quantities and capacities before using them for refill decisions: {staleStockNames.join(", ") || "Unknown machine"}.</p>
        </div> : null}
        {machinesMissingLiveStock.length ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="font-semibold text-amber-950">Machines without usable stock in the active XY snapshot</div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">{machinesMissingLiveStock.map(machine=><div key={machine.id} className="rounded-lg border border-amber-200 bg-white p-3"><div className="font-medium">{machine.name}</div><div className="text-xs text-slate-500">{machine.machine_code} · XY {machine.vms_machine_id??"-"} · {machine.status??"-"}</div><div className="mt-2 text-xs font-medium text-amber-800">{diagnoseMissingStock(machine)}</div></div>)}</div>
          <p className="mt-3 text-xs text-amber-800">Check whether these machines are newly added/empty, no longer present in XY, or returning only unconfigured lanes before changing their Snacky status.</p>
        </div>:null}
        {(currentUnmappedCount??0)>0?<div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><div><strong>XY products need mapping: {currentUnmappedCount} current XY lane product{currentUnmappedCount===1?"":"s"}</strong><p className="mt-1 text-xs text-amber-800">{Math.max(0,(needsReviewCount.count??0)-(currentUnmappedCount??0))} catalog-only/unused mapping entries are not blocking current operations.</p></div><a className="btn-secondary" href="/vms-mappings?status=needs_review">Review current mappings</a></div>:null}
      </section>

      {!config.ready ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          Missing server-side XY configuration: {config.missing.join(", ")}. Keep XY secrets server-only and do not use `NEXT_PUBLIC_` for them.
        </div>
      ) : null}

      {webConfig.enabled && !webConfig.ready ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          Missing server-side XY web dashboard fallback configuration: {webConfig.missing.join(", ")}. Keep the Authorization token server-only and do not use `NEXT_PUBLIC_`.
        </div>
      ) : null}

      {liveSalesConfig.enabled && !liveSalesConfig.ready ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          Live sales sync is enabled but not ready: {liveSalesConfig.missing.join(", ")}.
          The XY Trade details endpoint/request is already built in. Add a current server-only XY dashboard Authorization token, then enable live sales.
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Automatic XY Sync</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">Machine lanes refresh automatically for authorized planners with a shared 20-minute browser cooldown across tabs, plus the protected server scheduler. Route creation still performs its own freshness check before planning. The buttons below are emergency/manual tools only.</p>
          </div>
          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Automatic</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SyncForm action={testXyOfficialApiAction} label="Test Official Signed API" primary />
          <SyncForm action={syncXyMachinesAction} label="Sync Machines" disabled={syncDisabled} title={syncDisabled ? syncDisabledTitle : undefined} />
          <SyncForm action={syncXyProductsAction} label="Sync Products" disabled={syncDisabled} title={syncDisabled ? syncDisabledTitle : undefined} />
          <SyncForm action={syncXyMachineGoodsAction} label="Sync Machine Goods / Stock" disabled={syncDisabled} title={syncDisabled ? syncDisabledTitle : undefined} />
          <SyncForm action={syncXyMachineStatusAction} label="Sync Machine Status" disabled={syncDisabled} title={syncDisabled ? syncDisabledTitle : undefined} />
          <SyncForm action={syncXyAllAction} label="Sync All" disabled={syncDisabled} title={syncDisabled ? syncDisabledTitle : undefined} />
          <SyncForm
            action={syncXyLiveSalesAction}
            label="Sync Live Sales"
            disabled={!liveSalesConfig.ready}
            title={!liveSalesConfig.ready ? `Live sales needs: ${liveSalesConfig.missing.join(", ")}` : undefined}
          />
          <SyncForm action={testXyWebDashboardAction} label="Test Web Dashboard Fallback" />
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Official stock calls use the signed XY API. Live sales uses XY's verified Trade details endpoint (queryJqjymx) with a server-only dashboard session token and deduplicates into the same canonical VMS transaction table used by imported files.
        </p>
      </section>

      {latestWebTest ? (
        <section className="surface-card mb-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Latest Web Dashboard Test</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">Fallback web-dashboard API check only. It logs diagnostics and does not import data.</p>
            </div>
            <StatusBadge status={latestWebTest.status} />
          </div>
          {!latestWebDashboardSummary ? (
            <EmptyState title="No web dashboard summary saved" body="Run the web dashboard test again after applying the latest code." />
          ) : (
            <DataTable headers={["Endpoint", "HTTP", "Result", "Rows", "Raw message/error", "Sample first 3 rows"]}>
              <tr>
                <td className="font-medium">{latestWebDashboardSummary.endpoint ?? "/archives/queryMerchant"}</td>
                <td>{latestWebDashboardSummary.httpStatus ?? "-"}</td>
                <td>
                  <StatusBadge status={latestWebDashboardSummary.success ? "completed" : "failed"} />
                </td>
                <td>{latestWebDashboardSummary.rowCount ?? 0}</td>
                <td>{latestWebDashboardSummary.message || latestWebDashboardSummary.error || "-"}</td>
                <td>
                  {Array.isArray(latestWebDashboardSummary.sampleRows) && latestWebDashboardSummary.sampleRows.length ? (
                    <pre className="max-h-44 max-w-xl overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
                      {sampleRowsText(latestWebDashboardSummary.sampleRows)}
                    </pre>
                  ) : "-"}
                </td>
              </tr>
            </DataTable>
          )}
        </section>
      ) : null}

      {latestOfficialTest ? (
        <section className="surface-card mb-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Latest Official XY API Test</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">queryMachine diagnostics from the official API path. This test does not import data.</p>
            </div>
            <StatusBadge status={latestOfficialTest.status} />
          </div>
          {latestOfficialTest.error_count ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              {compactErrors(latestOfficialTest.errors)}
            </div>
          ) : null}
          {!latestOfficialEndpointSummaries.length ? (
            <EmptyState title="No endpoint summaries saved" body="Run the official XY API test again." />
          ) : (
            <DataTable headers={["Endpoint", "HTTP", "XY code", "Message", "Rows", "Signing details", "Sample first 3 machines"]}>
              {latestOfficialEndpointSummaries.map((summary) => (
                <tr key={String(summary.endpoint ?? summary.message ?? "endpoint")}>
                  <td className="font-medium">{summary.endpoint ?? "-"}</td>
                  <td>{summary.httpStatus ?? "-"}</td>
                  <td>{summary.xyCode ?? "-"}</td>
                  <td>{summary.message ?? "-"}</td>
                  <td>{summary.dataRowCount ?? 0}</td>
                  <td>
                    <pre className="max-h-44 max-w-md overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
                      {debugText(summary)}
                    </pre>
                  </td>
                  <td>
                    {Array.isArray(summary.sampleRows) && summary.sampleRows.length ? (
                      <pre className="max-h-44 max-w-xl overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
                        {sampleRowsText(summary.sampleRows)}
                      </pre>
                    ) : "-"}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
      ) : null}

      {!pagedRuns.length ? (
        <EmptyState title="No XY sync runs yet" body="Run a manual sync to create the first server-side log." />
      ) : (
        <>
          <DataTable headers={["Started", "Provider", "Type", "Status", "Rows", "Imported", "Updated", "Skipped", "Errors", "Message"]}>
            {pagedRuns.map((run) => (
              <tr key={run.id}>
                <td>{formatDate(run.started_at ?? run.created_at)}</td>
                <td className="font-medium">{run.provider === "xy_web" ? "XY Web" : "XY API"}</td>
                <td className="font-medium">{String(run.sync_type ?? "").replaceAll("_", " ")}</td>
                <td><StatusBadge status={run.status} /></td>
                <td>{run.row_count ?? 0}</td>
                <td>{run.rows_imported ?? 0}</td>
                <td>{run.rows_updated ?? 0}</td>
                <td>{run.rows_skipped ?? 0}</td>
                <td>{run.error_count ? compactErrors(run.errors) : "-"}</td>
                <td>{run.message ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/admin/vms-api" searchParams={params} page={page} pageSize={pageSize} totalCount={pagedRunsResult.count ?? 0} itemLabel="sync runs" />
        </>
      )}
    </>
  );
}
