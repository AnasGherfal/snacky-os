import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel } from "@/lib/payroll";
import { markPayrollRunPaid, savePayrollRun } from "@/lib/payroll-v2-actions";
import { buildPayrollRunPreview, getPayrollV2ServerClient, type PayrollRunRow } from "@/lib/payroll-v2";

export const dynamic = "force-dynamic";

export default async function PayrollRunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; paid?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const { id } = await params;
  const query = await searchParams;
  const supabase = await getPayrollV2ServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll run unavailable" body="Supabase is not configured, so Snacky OS cannot load this payroll run." />
      </>
    );
  }

  const { data: run } = await supabase.from("payroll_runs").select("*").eq("id", id).maybeSingle();
  if (!run) redirect("/payroll/periods?error=Payroll%20run%20not%20found.");
  const runRow = run as PayrollRunRow;

  const [{ data: operator }, preview] = await Promise.all([
    supabase.from("team_members").select("id, full_name").eq("id", runRow.operator_id).maybeSingle(),
    buildPayrollRunPreview({
      supabase,
      operatorId: runRow.operator_id,
      periodStart: runRow.period_start,
      periodEnd: runRow.period_end,
      existingRunId: id,
    }),
  ]);

  return (
    <>
      <PageHeader
        title={`${operator?.full_name ?? "Operator"} payroll`}
        subtitle={`Payroll run ${runRow.period_start} to ${runRow.period_end}.`}
        breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Payroll runs", href: "/payroll/periods" }, { label: operator?.full_name ?? "Operator" }]}
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href={`/payroll/periods?operator_id=${runRow.operator_id}&period_start=${runRow.period_start}&period_end=${runRow.period_end}`}>Back to preview</SecondaryButton>
            {runRow.status !== "paid" ? (
              <form action={savePayrollRun}>
                <input type="hidden" name="operator_id" value={runRow.operator_id} />
                <input type="hidden" name="period_start" value={runRow.period_start} />
                <input type="hidden" name="period_end" value={runRow.period_end} />
                <input type="hidden" name="return_path" value={`/payroll/periods/${id}`} />
                <button className="btn-secondary">Refresh payroll run</button>
              </form>
            ) : null}
            {runRow.status !== "paid" ? (
              <form action={markPayrollRunPaid}>
                <input type="hidden" name="payroll_run_id" value={id} />
                <PrimaryButton>Mark paid</PrimaryButton>
              </form>
            ) : null}
          </div>
        }
      />

      {query.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{query.error}</div> : null}
      {query.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll run updated.</div> : null}
      {query.paid ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll run marked paid and finance transaction created.</div> : null}

      <div className="mb-6 grid gap-4 md:grid-cols-5">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Status</div>
          <div className="mt-2"><StatusBadge status={runRow.status} /></div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Completed routes</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{runRow.completed_routes_count ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Completed stops</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{runRow.completed_stops_count ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Payroll km</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{Number(runRow.total_payroll_distance_km ?? 0).toFixed(2)}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Net pay</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{moneyLabel(runRow.net_pay_lyd ?? 0)}</div>
        </div>
      </div>

      <section className="surface-card mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Payroll totals</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div><div className="text-sm text-slate-500">Base salary</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.base_salary_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Route pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.route_pay_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Stop pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.stop_pay_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Distance pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.distance_pay_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Fuel allowance</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.fuel_allowance_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Bonuses</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.bonus_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Deductions</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.deduction_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Gross pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(runRow.gross_pay_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Paid at</div><div className="mt-1 font-semibold text-slate-900">{runRow.paid_at ? new Date(runRow.paid_at).toLocaleString("en-US") : "-"}</div></div>
        </div>
        {runRow.finance_transaction_id ? (
          <div className="mt-4">
            <Link href={`/finance/transactions/${runRow.finance_transaction_id}`} className="link-secondary">Open linked finance transaction</Link>
          </div>
        ) : null}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Incident deductions applied</h2>
            <p className="mt-1 text-sm text-slate-500">Approved incidents become locked to this run when the run is created or refreshed.</p>
          </div>
          <SecondaryButton href="/payroll/incidents">Open incidents</SecondaryButton>
        </div>
        {!preview?.includedIncidents.length ? (
          <EmptyState title="No incident deductions applied" body="This run was created without any approved deductions in the selected period." />
        ) : (
          <DataTable headers={["Date", "Issue", "Severity", "Machine / Location", "Deduction", "Route"]}>
            {preview.includedIncidents.map((incident) => (
              <tr key={incident.incidentId}>
                <td>{incident.incidentDate ?? "-"}</td>
                <td>
                  <div className="font-medium text-slate-900">{incident.description}</div>
                  <div className="text-xs text-slate-500">{incident.mistakeType.replaceAll("_", " ")}</div>
                </td>
                <td><StatusBadge status={incident.severity} /></td>
                <td>{incident.machineName}{incident.locationName ? ` - ${incident.locationName}` : ""}</td>
                <td>{moneyLabel(incident.deductionAmountLyd)}</td>
                <td>{incident.routeId ? <Link href={`/routes/${incident.routeId}`} className="link-secondary">Open route</Link> : "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Included routes</h2>
          <p className="mt-1 text-sm text-slate-500">Completed routes count for route pay. Completed stops under them count for stop pay and distance.</p>
        </div>
        {!preview?.includedRoutes.length ? (
          <EmptyState title="No routes included in this payroll run" body="Refresh the run if completed work should be included." />
        ) : (
          <DataTable headers={["Route date", "Status", "Completed stops", "Payroll km", "Missing distance", "Action"]}>
            {preview.includedRoutes.map((route) => (
              <tr key={route.routeId}>
                <td>{route.routeDate ?? "-"}</td>
                <td><StatusBadge status={route.routeStatus ?? "unknown"} /></td>
                <td>{route.completedStopsCount}</td>
                <td>{route.totalPayrollDistanceKm.toFixed(2)} km</td>
                <td>{route.missingDistanceStopCount}</td>
                <td><Link href={`/routes/${route.routeId}`} className="link-secondary">Open route</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Included completed stops</h2>
          <p className="mt-1 text-sm text-slate-500">Stops with missing distance stay in the run with 0 km until their location payroll distance is configured.</p>
        </div>
        {!preview?.includedStops.length ? (
          <EmptyState title="No completed stops in this payroll run" body="Refresh the run if completed stop work should be included." />
        ) : (
          <DataTable headers={["Machine", "Route date", "Stop", "Location", "Payroll km", "Action"]}>
            {preview.includedStops.map((stop) => (
              <tr key={stop.stopId}>
                <td className="font-medium text-slate-900">{stop.machineName}</td>
                <td>{stop.routeDate ?? "-"}</td>
                <td>{stop.stopOrder}</td>
                <td>{stop.locationName ?? "Unknown location"}</td>
                <td>{stop.distanceMissing ? "Missing" : `${stop.payrollDistanceKm.toFixed(2)} km`}</td>
                <td><Link href={`/routes/${stop.routeId}`} className="link-secondary">Open route</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Missing distance warnings</h2>
            <p className="mt-1 text-sm text-slate-500">These stops stayed in the run with 0 km until their location payroll distance is configured.</p>
          </div>
          <SecondaryButton href="/payroll/distances">Open distance setup</SecondaryButton>
        </div>
        {!preview?.missingDistanceWarnings.length ? (
          <EmptyState title="No missing distance warnings" body="All included stops have payroll distance configured." />
        ) : (
          <DataTable headers={["Machine", "Location", "Reason", "Action"]}>
            {preview.missingDistanceWarnings.map((warning) => (
              <tr key={warning.stopId}>
                <td className="font-medium text-slate-900">{warning.machineName}</td>
                <td>{warning.locationName ?? "Unknown location"}</td>
                <td>{warning.reason}</td>
                <td><Link href={`/routes/${warning.routeId}`} className="link-secondary">Open route</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
