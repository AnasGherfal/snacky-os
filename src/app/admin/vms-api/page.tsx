import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import { Activity, AlertTriangle, Boxes, CheckCircle2, DatabaseZap, PackageSearch, RadioTower, RefreshCw, TestTube2 } from "lucide-react";
import { DataTable, EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getXyVmsConfig } from "@/lib/xy-vms-api";
import {
  syncXyAllAction,
  syncXyMachineGoodsAction,
  syncXyMachinesAction,
  syncXyMachineStatusAction,
  syncXyProductsAction,
  testXyUnsignedMerchantAction,
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
  httpStatus?: number | null;
  xyCode?: string | number | null;
  message?: string | null;
  dataRowCount?: number | null;
  sampleRows?: unknown;
};

function connectionStatus(config: ReturnType<typeof getXyVmsConfig>) {
  if (!config.enabled) return { status: "disabled", label: "Disabled" };
  if (!config.ready) return { status: "needs_configuration", label: "Needs configuration" };
  return { status: "ready", label: "Ready" };
}

function SyncForm({
  action,
  label,
  icon: Icon,
  primary = false,
}: {
  action: (formData?: FormData) => Promise<void>;
  label: string;
  icon: ComponentType<{ className?: string }>;
  primary?: boolean;
}) {
  return (
    <form action={action}>
      <button type="submit" className={`${primary ? "btn-primary" : "btn-secondary"} inline-flex w-full items-center justify-center gap-2`}>
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </button>
    </form>
  );
}

function endpointSummaries(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter((item): item is XyEndpointSummary => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function sampleRowsText(value: unknown) {
  if (!Array.isArray(value) || !value.length) return "-";
  return JSON.stringify(value, null, 2);
}

export default async function AdminVmsApiPage() {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile.role)) redirect("/unauthorized");

  const config = getXyVmsConfig();
  const status = connectionStatus(config);
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="XY VMS API unavailable" body="Supabase is not configured, so Snacky OS cannot save sync logs or snapshots." />
      </>
    );
  }

  const [
    runsResult,
    productCatalogCount,
    stockSnapshotCount,
    statusSnapshotCount,
    needsReviewCount,
  ] = await Promise.all([
    supabase
      .from("vms_sync_runs")
      .select("id, sync_type, status, row_count, rows_imported, rows_updated, rows_skipped, error_count, message, errors, response_summary, started_at, completed_at, created_at")
      .eq("provider", "xy")
      .order("created_at", { ascending: false })
      .limit(25),
    supabase.from("vms_product_catalog_snapshots").select("id", { count: "exact", head: true }),
    supabase.from("vms_stock_snapshots").select("id", { count: "exact", head: true }).eq("source_provider", "xy"),
    supabase.from("vms_machine_status_snapshots").select("id", { count: "exact", head: true }),
    supabase.from("vms_product_mappings").select("id", { count: "exact", head: true }).eq("match_status", "needs_review"),
  ]);

  const loadError =
    runsResult.error ??
    productCatalogCount.error ??
    stockSnapshotCount.error ??
    statusSnapshotCount.error ??
    needsReviewCount.error;

  if (loadError) {
    console.error("[xy-vms-admin] Failed to load XY sync dashboard", loadError);
    return (
      <>
        <ErrorState title="Could not load XY VMS API dashboard" body="Run the latest Supabase migrations, then refresh this page." />
      </>
    );
  }

  const runs = (runsResult.data ?? []) as XySyncRunRow[];
  const lastCompleted = runs.find((run) => run.completed_at);
  const latestUnsignedTest = runs.find((run) => run.sync_type === "test_unsigned");
  const latestUnsignedEndpointSummaries = endpointSummaries(latestUnsignedTest?.response_summary);

  return (
    <>
      <PageHeader
        title="XY VMS API"
        subtitle="Server-side Xingyuan sync for machines, VMS products, aisle goods stock, and machine status."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <section className="surface-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-slate-500">Connection</div>
            <StatusBadge status={status.status} />
          </div>
          <div className="text-2xl font-semibold text-slate-900">{status.label}</div>
          <div className="mt-3 space-y-1 text-sm text-slate-600">
            <div>Merchant: {config.maskedMerchantId}</div>
            <div>Key: {config.maskedKey}</div>
            <div>Signing: {config.signingMode}</div>
          </div>
        </section>

        <section className="surface-card">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-500">
            <Activity className="h-4 w-4" />
            Last Sync
          </div>
          <div className="text-lg font-semibold text-slate-900">{formatDate(lastCompleted?.completed_at)}</div>
          <p className="mt-3 text-sm leading-6 text-slate-500">Latest completed XY sync run saved in `vms_sync_runs`.</p>
        </section>

        <section className="surface-card">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-500">
            <DatabaseZap className="h-4 w-4" />
            Imported Data
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-xl font-semibold text-slate-900">{productCatalogCount.count ?? 0}</div><div className="text-xs text-slate-500">Products</div></div>
            <div><div className="text-xl font-semibold text-slate-900">{stockSnapshotCount.count ?? 0}</div><div className="text-xs text-slate-500">Stock</div></div>
            <div><div className="text-xl font-semibold text-slate-900">{statusSnapshotCount.count ?? 0}</div><div className="text-xs text-slate-500">Status</div></div>
          </div>
        </section>

        <section className="surface-card">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-500">
            <AlertTriangle className="h-4 w-4" />
            Needs Review
          </div>
          <div className="text-2xl font-semibold text-slate-900">{needsReviewCount.count ?? 0}</div>
          <p className="mt-3 text-sm leading-6 text-slate-500">Unmatched VMS products are kept for mapping instead of being dropped.</p>
        </section>
      </div>

      {!config.ready ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          Missing server-side XY configuration: {config.missing.join(", ")}. Keep XY secrets server-only and do not use `NEXT_PUBLIC_` for them.
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Manual Sync</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">Buttons run on the Next.js server. Machine status is manual only for now, not polled.</p>
          </div>
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <SyncForm action={testXyUnsignedMerchantAction} label={`Test Unsigned Merchant ${config.merchantId || "Not set"}`} icon={TestTube2} />
          <SyncForm action={syncXyMachinesAction} label="Sync Machines" icon={Boxes} />
          <SyncForm action={syncXyProductsAction} label="Sync Products" icon={PackageSearch} />
          <SyncForm action={syncXyMachineGoodsAction} label="Sync Machine Goods / Stock" icon={DatabaseZap} />
          <SyncForm action={syncXyMachineStatusAction} label="Sync Machine Status" icon={RadioTower} />
          <SyncForm action={syncXyAllAction} label="Sync All" icon={RefreshCw} primary />
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Confirm with XY whether `key`, `secret`, `sign`, and `timestamp` must be included in the request body. The signing helper is active unless `XY_VMS_SIGNING_MODE=unsigned`.
        </p>
      </section>

      {latestUnsignedTest ? (
        <section className="surface-card mb-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Latest Unsigned Test</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">Raw response summary from unsigned XY calls. This test does not import data.</p>
            </div>
            <StatusBadge status={latestUnsignedTest.status} />
          </div>
          {latestUnsignedTest.error_count ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              {compactErrors(latestUnsignedTest.errors)}
            </div>
          ) : null}
          {!latestUnsignedEndpointSummaries.length ? (
            <EmptyState title="No endpoint summaries saved" body="Run the unsigned merchant test again after applying the latest migration." />
          ) : (
            <DataTable headers={["Endpoint", "HTTP", "XY code", "Message", "Rows", "Sample first 3 rows"]}>
              {latestUnsignedEndpointSummaries.map((summary) => (
                <tr key={String(summary.endpoint ?? summary.message ?? "endpoint")}>
                  <td className="font-medium">{summary.endpoint ?? "-"}</td>
                  <td>{summary.httpStatus ?? "-"}</td>
                  <td>{summary.xyCode ?? "-"}</td>
                  <td>{summary.message ?? "-"}</td>
                  <td>{summary.dataRowCount ?? 0}</td>
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

      {!runs.length ? (
        <EmptyState title="No XY sync runs yet" body="Run a manual sync to create the first server-side log." />
      ) : (
        <DataTable headers={["Started", "Type", "Status", "Rows", "Imported", "Updated", "Skipped", "Errors", "Message"]}>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{formatDate(run.started_at ?? run.created_at)}</td>
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
      )}
    </>
  );
}
