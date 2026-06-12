import Link from "next/link";
import type { ReactNode } from "react";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";
import {
  backfillMissingFinanceTransactions,
  forceCompleteRouteWithAudit,
  recalculateDashboards,
  recalculateRouteInventoryLedger,
  recalculateStorageBalances,
  rebuildRefillRecommendations,
  repairStuckRoute,
} from "@/lib/admin-tools-actions";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type RouteOption = {
  id: string;
  route_date: string | null;
  status: string | null;
  operator?: { full_name?: string | null } | null;
  completed_at?: string | null;
  last_completion_error?: string | null;
};

type BatchOption = {
  id: string;
  file_name: string | null;
  report_type: string | null;
  status: string | null;
  is_active?: boolean | null;
  deleted_at?: string | null;
  uploaded_at?: string | null;
  imported_at?: string | null;
};

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("en-US") : "-";
}

function targetLabel(route: RouteOption) {
  const operator = route.operator?.full_name ? ` - ${route.operator.full_name}` : "";
  return `${route.route_date ?? "No date"} - ${route.status ?? "unknown"} - ${route.id.slice(0, 8)}${operator}`;
}

function batchLabel(batch: BatchOption) {
  return `${batch.file_name ?? "VMS import"} - ${batch.report_type ?? "unknown"} - ${batch.status ?? "unknown"} - ${batch.id.slice(0, 8)}`;
}

function ToolCard({
  title,
  description,
  children,
  danger = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section className={`surface-card space-y-4 ${danger ? "border-rose-200" : ""}`}>
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {children}
    </section>
  );
}

function RouteSelect({ routes }: { routes: RouteOption[] }) {
  return (
    <select name="route_id" required className="field-input">
      <option value="">Select route</option>
      {routes.map((route) => (
        <option key={route.id} value={route.id}>{targetLabel(route)}</option>
      ))}
    </select>
  );
}

function BatchSelect({ batches }: { batches: BatchOption[] }) {
  return (
    <select name="batch_id" required className="field-input">
      <option value="">Select import</option>
      {batches.map((batch) => (
        <option key={batch.id} value={batch.id}>{batchLabel(batch)}</option>
      ))}
    </select>
  );
}

function ReasonInput({ placeholder = "Reason" }: { placeholder?: string }) {
  return <input name="reason" required className="field-input" placeholder={placeholder} />;
}

export default async function AdminToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");

  const { success = "", error = "" } = await searchParams;
  const supabase = getSupabaseServerClient();

  const [routesResult, batchesResult, storageResult] = supabase
    ? await Promise.all([
        supabase
          .from("routes")
          .select("id, route_date, status, completed_at, last_completion_error, operator:team_members(full_name)")
          .order("created_at", { ascending: false })
          .limit(30),
        supabase
          .from("vms_import_batches")
          .select("id, file_name, report_type, status, is_active, deleted_at, uploaded_at, imported_at")
          .order("uploaded_at", { ascending: false })
          .limit(30),
        supabase.from("current_inventory_by_location").select("product_id", { count: "exact", head: true }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { count: null, error: null }];

  const routes = (routesResult.data ?? []) as unknown as RouteOption[];
  const batches = (batchesResult.data ?? []) as unknown as BatchOption[];
  const routeLoadError = routesResult.error?.message ?? "";
  const batchLoadError = batchesResult.error?.message ?? "";

  return (
    <>
      <PageHeader
        title="Admin Tools"
        subtitle="Recovery controls for route workflow, inventory ledger checks, VMS import state, and dashboard refreshes."
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Tools" }]}
        action={<SecondaryButton href="/admin">Back to admin</SecondaryButton>}
      />

      {success ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}
      {error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}
      {routeLoadError || batchLoadError ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {routeLoadError ? `Routes: ${routeLoadError}` : null}
          {routeLoadError && batchLoadError ? " | " : null}
          {batchLoadError ? `VMS imports: ${batchLoadError}` : null}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Recent route targets</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{routes.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Routes with completion errors</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{routes.filter((route) => route.last_completion_error).length}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Recent VMS imports</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{batches.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Ledger balance rows</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{storageResult.count ?? "-"}</div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <ToolCard title="Backfill Missing Finance Transactions" description="Creates missing source-generated ledger rows for paid purchases and counted cash collections without duplicating existing linked transactions.">
          <form action={backfillMissingFinanceTransactions} className="space-y-3">
            <ReasonInput placeholder="Why are you repairing source-generated finance transactions?" />
            <FormSubmitButton pendingLabel="Backfilling finance transactions...">Backfill Missing Finance Transactions</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Repair Stuck Route" description="Clears route completion error metadata and rebuilds route stock lines from inventory movements.">
          <form action={repairStuckRoute} className="space-y-3">
            <RouteSelect routes={routes} />
            <ReasonInput placeholder="Why is this route stuck?" />
            <FormSubmitButton pendingLabel="Repairing route...">Repair route</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Recalculate Route Inventory Ledger" description="Rebuilds picked and returned route stock totals from inventory_movements without changing inventory.">
          <form action={recalculateRouteInventoryLedger} className="space-y-3">
            <RouteSelect routes={routes} />
            <ReasonInput placeholder="Why are route stock lines being recalculated?" />
            <FormSubmitButton pendingLabel="Recalculating route ledger...">Recalculate route ledger</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Force Complete Route With Audit" description="Returns outstanding operator bag stock to storage, skips unfinished stops, reconciles stock lines, and completes the route." danger>
          <form action={forceCompleteRouteWithAudit} className="space-y-3">
            <RouteSelect routes={routes} />
            <ReasonInput placeholder="Reason for force completion" />
            <input name="confirmation" required className="field-input" placeholder="Type FORCE COMPLETE" />
            <FormSubmitButton className="btn-primary" pendingLabel="Force completing route...">Force complete route</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Recalculate Storage Balances" description="Checks ledger-derived storage balances and refreshes inventory dashboard paths.">
          <form action={recalculateStorageBalances} className="space-y-3">
            <ReasonInput placeholder="Reason for balance refresh" />
            <FormSubmitButton pendingLabel="Refreshing balances...">Recalculate storage balances</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Disable VMS Import" description="Removes an imported file from dashboard calculations without deleting its audit history.">
          <form action={updateVmsImportBatchState} className="space-y-3">
            <input type="hidden" name="action" value="disable" />
            <BatchSelect batches={batches} />
            <ReasonInput placeholder="Reason for disabling file" />
            <FormSubmitButton pendingLabel="Disabling import...">Disable import</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Soft Delete VMS Import" description="Marks an import deleted so dashboards ignore it while retaining recoverable file history.">
          <form action={updateVmsImportBatchState} className="space-y-3">
            <input type="hidden" name="action" value="soft_delete" />
            <BatchSelect batches={batches} />
            <ReasonInput placeholder="Reason for soft delete" />
            <FormSubmitButton pendingLabel="Deleting import...">Soft delete import</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Restore VMS Import" description="Restores an imported file to active dashboard use after review.">
          <form action={updateVmsImportBatchState} className="space-y-3">
            <input type="hidden" name="action" value="restore" />
            <BatchSelect batches={batches} />
            <FormSubmitButton pendingLabel="Restoring import...">Restore import</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Reprocess VMS Mapping" description="Re-runs import processing against saved raw rows after product or machine mapping fixes.">
          <form action={reprocessVmsImportBatch} className="space-y-3">
            <BatchSelect batches={batches} />
            <FormSubmitButton pendingLabel="Reprocessing import...">Reprocess import</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Rebuild Refill Recommendations" description="Runs the latest stock snapshot recommendation diagnostics, then refreshes the route builder and refill pages without changing historical VMS rows.">
          <form action={rebuildRefillRecommendations} className="space-y-3">
            <ReasonInput placeholder="Why are refill recommendations being rebuilt?" />
            <FormSubmitButton pendingLabel="Rebuilding refill recommendations...">Rebuild refill recommendations</FormSubmitButton>
          </form>
        </ToolCard>

        <ToolCard title="Recalculate Dashboards" description="Refreshes dashboard routes and KPI source pages after recovery actions.">
          <form action={recalculateDashboards} className="space-y-3">
            <ReasonInput placeholder="Reason for dashboard refresh" />
            <FormSubmitButton pendingLabel="Refreshing dashboards...">Recalculate dashboards</FormSubmitButton>
          </form>
        </ToolCard>
      </div>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Recent Route Targets</h2>
        {!routes.length ? (
          <EmptyState title="No routes found" body="Create a route before using route recovery tools." />
        ) : (
          <DataTable headers={["Date", "Status", "Operator", "Completed", "Last completion error", "Route"]}>
            {routes.slice(0, 12).map((route) => (
              <tr key={route.id}>
                <td>{route.route_date ?? "-"}</td>
                <td><StatusBadge status={route.status} /></td>
                <td>{route.operator?.full_name ?? "-"}</td>
                <td>{formatDate(route.completed_at)}</td>
                <td className="max-w-xs text-xs text-slate-600">{route.last_completion_error ?? "-"}</td>
                <td><Link href={`/routes/${route.id}`} className="link-secondary">Open</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Recent VMS Imports</h2>
        {!batches.length ? (
          <EmptyState title="No VMS imports found" body="Upload VMS files before using import recovery tools." />
        ) : (
          <DataTable headers={["Status", "Active", "File", "Report type", "Uploaded", "Import"]}>
            {batches.slice(0, 12).map((batch) => (
              <tr key={batch.id}>
                <td><StatusBadge status={batch.status} /></td>
                <td><StatusBadge status={batch.status === "imported" && batch.is_active !== false && !batch.deleted_at ? "active" : "inactive"} /></td>
                <td>{batch.file_name ?? "-"}</td>
                <td>{String(batch.report_type ?? "-").replaceAll("_", " ")}</td>
                <td>{formatDate(batch.uploaded_at ?? batch.imported_at)}</td>
                <td><Link href={`/vms-import/${batch.id}`} className="link-secondary">Open</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
