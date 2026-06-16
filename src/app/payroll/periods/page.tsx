import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel, operatorPayProfileIsActive, type OperatorPayProfileRow } from "@/lib/payroll";
import { refreshPayrollPeriod } from "@/lib/payroll-actions";
import { buildPayrollPeriodSummary, getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

type PayrollTeamMemberRow = {
  id: string;
  full_name?: string | null;
  role?: string | null;
  roles?: string[] | null;
};

type PayrollPeriodSummaryRow = {
  id: string;
  operator_id: string;
  period_start: string;
  period_end: string;
  status?: string | null;
  net_total_lyd?: number | string | null;
  completed_routes_count?: number | null;
  completed_stops_count?: number | null;
  paid_at?: string | null;
};

function defaultRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

function validDate(value: string | undefined) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : "";
}

export default async function PayrollPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ operator_id?: string; period_start?: string; period_end?: string; error?: string; saved?: string; paid?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll run unavailable" body="Supabase is not configured, so Snacky OS cannot load payroll runs." />
      </>
    );
  }

  const defaults = defaultRange();
  const [{ data: periods, error: periodsError }, { data: payProfiles, error: payProfilesError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from("payroll_periods").select("*").order("period_start", { ascending: false }).limit(20),
    supabase.from("operator_pay_profiles").select("*").order("updated_at", { ascending: false }),
    supabase
      .from("team_members")
      .select("id, full_name, role, roles")
      .or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}")
      .order("full_name"),
  ]);

  if (periodsError || payProfilesError || membersError) {
    console.error("[payroll:periods] Failed to load payroll run page", { periodsError, payProfilesError, membersError });
    return (
      <>
        <ErrorState
          title="Could not load payroll run"
          body="Snacky OS could not load payroll run data. Apply the latest payroll repair migration if this is a new environment."
          action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
        />
      </>
    );
  }

  const payProfileByOperatorId = new Map(
    ((payProfiles ?? []) as OperatorPayProfileRow[])
      .filter((payProfile) => operatorPayProfileIsActive(payProfile))
      .map((payProfile) => [payProfile.team_member_id, payProfile]),
  );
  const operators = ((members ?? []) as PayrollTeamMemberRow[])
    .filter((member) => payProfileByOperatorId.has(member.id));
  const selectedOperatorId = operators.some((member) => member.id === params.operator_id)
    ? String(params.operator_id)
    : operators[0]?.id ?? "";
  const periodStart = validDate(params.period_start) || defaults.periodStart;
  const periodEnd = validDate(params.period_end) || defaults.periodEnd;
  const existingPeriod = selectedOperatorId
    ? await supabase.from("payroll_periods").select("*").eq("operator_id", selectedOperatorId).eq("period_start", periodStart).maybeSingle()
    : { data: null };
  const preview = selectedOperatorId && periodStart && periodEnd && periodEnd >= periodStart
    ? await buildPayrollPeriodSummary({
        supabase,
        operatorId: selectedOperatorId,
        periodStart,
        periodEnd,
        existingPeriodId: existingPeriod.data?.id ?? null,
      })
    : null;

  const recentPeriods = (periods ?? []) as PayrollPeriodSummaryRow[];
  const memberNameById = new Map(operators.map((member) => [member.id, member.full_name ?? "Operator"]));

  return (
    <>
      <PageHeader
        title="Payroll Run"
        subtitle="Preview completed routes, completed stops, payroll distance, and totals before creating or refreshing the payroll record."
        breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Payroll run" }]}
        action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll run refreshed.</div> : null}
      {params.paid ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll run marked paid.</div> : null}

      <section className="surface-card mb-6">
        <form className="grid gap-4 md:grid-cols-4 md:items-end">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-800">Operator</span>
            <select name="operator_id" defaultValue={selectedOperatorId} className="field-input">
              {operators.map((member) => (
                <option key={member.id} value={member.id}>{member.full_name}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-800">Period start</span>
            <input type="date" name="period_start" defaultValue={periodStart} className="field-input" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-800">Period end</span>
            <input type="date" name="period_end" defaultValue={periodEnd} className="field-input" />
          </label>
          <button className="btn-primary">Preview payroll</button>
        </form>
      </section>

      {!operators.length ? (
        <EmptyState title="No active pay profiles yet" body="Create an active pay profile before building payroll runs." action={<SecondaryButton href="/payroll/profiles">Open profiles</SecondaryButton>} />
      ) : preview ? (
        <>
          <section className="mb-6 grid gap-4 md:grid-cols-5">
            <div className="surface-card">
              <div className="text-sm text-slate-500">Completed routes</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{preview.completedRoutesCount}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm text-slate-500">Completed stops</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{preview.completedStopsCount}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm text-slate-500">Payroll km</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{preview.totalPayrollDistanceKm.toFixed(2)}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm text-slate-500">Missing distance stops</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{preview.missingDistanceWarnings.length}</div>
            </div>
            <div className="surface-card">
              <div className="text-sm text-slate-500">Net pay</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{moneyLabel(preview.netPay)}</div>
            </div>
          </section>

          <section className="surface-card mb-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Preview totals</h2>
                <p className="mt-1 text-sm text-slate-500">Only completed work inside the selected period is included.</p>
              </div>
              <form action={refreshPayrollPeriod}>
                <input type="hidden" name="operator_id" value={selectedOperatorId} />
                <input type="hidden" name="period_start" value={periodStart} />
                <input type="hidden" name="period_end" value={periodEnd} />
                <input type="hidden" name="return_path" value={`/payroll/periods?operator_id=${selectedOperatorId}&period_start=${periodStart}&period_end=${periodEnd}`} />
                <button className="btn-primary">{existingPeriod.data ? "Refresh payroll" : "Create payroll"}</button>
              </form>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div><div className="text-sm text-slate-500">Base salary</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.baseSalaryAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Route pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.routePayAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Stop pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.stopPayAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Distance pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.distancePayAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Fuel allowance</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.fuelAllowanceAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Bonuses</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.bonusAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Deductions</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.deductionAmount)}</div></div>
              <div><div className="text-sm text-slate-500">Gross pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(preview.grossPay)}</div></div>
            </div>
          </section>

          <section className="surface-card mb-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-slate-900">Included routes</h2>
              <p className="mt-1 text-sm text-slate-500">Each route rolls up its completed stops and the total payroll km contributed by those stops.</p>
            </div>
            {!preview.includedRoutes.length ? (
              <EmptyState title="No completed routes in this period" body="Pick another operator or date range if completed work should be included." />
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
              <p className="mt-1 text-sm text-slate-500">Stops with missing location distance stay in the payroll run, but they contribute 0 km until fixed.</p>
            </div>
            {!preview.includedStops.length ? (
              <EmptyState title="No completed stops in this period" body="Completed routes without completed stops still count for route pay, but there are no stop lines to preview." />
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
                <p className="mt-1 text-sm text-slate-500">Fix these location records to restore km pay and fuel allowance for the affected stops.</p>
              </div>
              <SecondaryButton href="/locations">Open locations</SecondaryButton>
            </div>
            {!preview.missingDistanceWarnings.length ? (
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
      ) : null}

      <section className="surface-card mt-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Recent payroll runs</h2>
          <p className="mt-1 text-sm text-slate-500">Use the detail view to review totals, add adjustments, or mark a payroll run paid.</p>
        </div>
        {!recentPeriods.length ? (
          <EmptyState title="No payroll runs yet" body="Preview a payroll run above, then create the first record." />
        ) : (
          <DataTable headers={["Operator", "Period", "Status", "Routes", "Stops", "Net pay", "Paid at", "Action"]}>
            {recentPeriods.map((period) => (
              <tr key={period.id}>
                <td className="font-medium text-slate-900">{memberNameById.get(period.operator_id) ?? "Operator"}</td>
                <td>{period.period_start} to {period.period_end}</td>
                <td><StatusBadge status={period.status ?? "draft"} /></td>
                <td>{period.completed_routes_count ?? 0}</td>
                <td>{period.completed_stops_count ?? 0}</td>
                <td>{moneyLabel(period.net_total_lyd ?? 0)}</td>
                <td>{period.paid_at ? new Date(period.paid_at).toLocaleString("en-US") : "-"}</td>
                <td><Link href={`/payroll/periods/${period.id}`} className="link-secondary">Open detail</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
