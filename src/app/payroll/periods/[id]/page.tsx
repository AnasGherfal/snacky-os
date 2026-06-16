import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, FormField, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel, type PayrollAdjustmentRow, type PayrollPeriodRow } from "@/lib/payroll";
import { deletePayrollAdjustment, markPayrollPeriodPaid, refreshPayrollPeriod, savePayrollAdjustment } from "@/lib/payroll-actions";
import { buildPayrollPeriodSummary, getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

type PayrollPeriodDetailRow = PayrollPeriodRow & {
  finance_transaction_id?: string | null;
};

export default async function PayrollPeriodDetailPage({
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
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll period unavailable" body="Supabase is not configured, so Snacky OS cannot load this payroll run." />
      </>
    );
  }

  const { data: period } = await supabase.from("payroll_periods").select("*").eq("id", id).maybeSingle();
  if (!period) redirect("/payroll/periods?error=Payroll%20run%20not%20found.");
  const periodRow = period as PayrollPeriodDetailRow;

  const [{ data: operator }, { data: adjustments }, summary] = await Promise.all([
    supabase.from("team_members").select("id, full_name").eq("id", periodRow.operator_id).maybeSingle(),
    supabase.from("payroll_adjustments").select("*").eq("payroll_period_id", id).order("created_at", { ascending: true }),
    buildPayrollPeriodSummary({
      supabase,
      operatorId: periodRow.operator_id,
      periodStart: periodRow.period_start,
      periodEnd: periodRow.period_end,
      existingPeriodId: id,
    }),
  ]);

  const preview = summary ?? null;

  return (
    <>
      <PageHeader
        title={`${operator?.full_name ?? "Operator"} payroll`}
        subtitle={`Payroll run ${periodRow.period_start} to ${periodRow.period_end}.`}
        breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Payroll run", href: "/payroll/periods" }, { label: operator?.full_name ?? "Operator" }]}
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href={`/payroll/periods?operator_id=${periodRow.operator_id}&period_start=${periodRow.period_start}&period_end=${periodRow.period_end}`}>Back to preview</SecondaryButton>
            {periodRow.status !== "paid" ? (
              <form action={refreshPayrollPeriod}>
                <input type="hidden" name="operator_id" value={periodRow.operator_id} />
                <input type="hidden" name="period_start" value={periodRow.period_start} />
                <input type="hidden" name="period_end" value={periodRow.period_end} />
                <input type="hidden" name="return_path" value={`/payroll/periods/${id}`} />
                <button className="btn-secondary">Refresh payroll</button>
              </form>
            ) : null}
            {periodRow.status !== "paid" ? (
              <form action={markPayrollPeriodPaid}>
                <input type="hidden" name="payroll_period_id" value={id} />
                <button className="btn-primary">Mark paid</button>
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
          <div className="mt-2"><StatusBadge status={periodRow.status} /></div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Completed routes</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{periodRow.completed_routes_count ?? periodRow.route_count ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Completed stops</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{periodRow.completed_stops_count ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Payroll km</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{Number(periodRow.total_payroll_distance_km ?? 0).toFixed(2)}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Net pay</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{moneyLabel(periodRow.net_total_lyd)}</div>
        </div>
      </div>

      <section className="surface-card mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Payroll totals</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div><div className="text-sm text-slate-500">Base salary</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.base_salary_amount_lyd ?? periodRow.base_salary_lyd)}</div></div>
          <div><div className="text-sm text-slate-500">Route pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.route_pay_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Stop pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.stop_pay_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Distance pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.distance_pay_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Fuel allowance</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.fuel_allowance_amount_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Bonuses</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.bonus_total_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Deductions</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.deduction_total_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Gross pay</div><div className="mt-1 font-semibold text-slate-900">{moneyLabel(periodRow.gross_total_lyd ?? 0)}</div></div>
          <div><div className="text-sm text-slate-500">Paid at</div><div className="mt-1 font-semibold text-slate-900">{periodRow.paid_at ? new Date(periodRow.paid_at).toLocaleString("en-US") : "-"}</div></div>
        </div>
        {periodRow.finance_transaction_id ? (
          <div className="mt-4">
            <Link href={`/finance/transactions/${periodRow.finance_transaction_id}`} className="link-secondary">Open linked finance transaction</Link>
          </div>
        ) : null}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Period adjustments</h2>
          <p className="mt-1 text-sm text-slate-500">Bonuses and deductions require a reason so payroll stays auditable.</p>
        </div>
        {periodRow.status !== "paid" ? (
          <form action={savePayrollAdjustment} className="mb-5 grid gap-4 md:grid-cols-5 md:items-end">
            <input type="hidden" name="payroll_period_id" value={id} />
            <FormField label="Type" required>
              <select name="adjustment_type" className="field-input" defaultValue="bonus">
                <option value="bonus">Bonus</option>
                <option value="deduction">Deduction</option>
              </select>
            </FormField>
            <FormField label="Label" required>
              <input name="label" className="field-input" placeholder="Performance bonus" />
            </FormField>
            <FormField label="Amount LYD" required>
              <input name="amount_lyd" type="number" min="0.01" step="0.01" className="field-input" placeholder="50" />
            </FormField>
            <div className="md:col-span-2">
              <FormField label="Reason" required>
                <input name="reason" className="field-input" placeholder="Why was this adjustment added?" />
              </FormField>
            </div>
            <button className="btn-primary md:col-span-5">Add adjustment</button>
          </form>
        ) : (
          <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Paid payroll runs are locked. Add all bonuses or deductions before marking the run paid.</div>
        )}

        {!adjustments?.length ? (
          <EmptyState title="No adjustments added" body="Use adjustments only when a bonus or deduction should be audited outside the standard payroll formula." />
        ) : (
          <DataTable headers={["Type", "Label", "Amount", "Reason", "Action"]}>
            {((adjustments ?? []) as PayrollAdjustmentRow[]).map((adjustment) => (
              <tr key={adjustment.id}>
                <td><StatusBadge status={adjustment.adjustment_type} /></td>
                <td>{adjustment.label}</td>
                <td>{moneyLabel(adjustment.amount_lyd)}</td>
                <td>{adjustment.reason}</td>
                <td>
                  {periodRow.status !== "paid" ? (
                    <ConfirmDialog
                      action={deletePayrollAdjustment}
                      triggerLabel="Delete"
                      title="Delete payroll adjustment?"
                      description="This will remove the adjustment and refresh the payroll totals for the run."
                      confirmLabel="Delete adjustment"
                      buttonClassName="btn-danger"
                      confirmButtonClassName="btn-danger"
                      hiddenFields={[{ name: "payroll_period_id", value: id }, { name: "adjustment_id", value: adjustment.id }]}
                    />
                  ) : (
                    <span className="text-sm text-slate-400">Locked</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Included routes</h2>
          <p className="mt-1 text-sm text-slate-500">Completed routes count for per-route pay. Completed stops under each route count for stop pay and distance.</p>
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

      <section className="surface-card">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Missing distance warnings</h2>
          <p className="mt-1 text-sm text-slate-500">These stops stayed in the run with 0 km until their location payroll distance is configured.</p>
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
