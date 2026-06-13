import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel } from "@/lib/payroll";
import { refreshPayrollPeriod } from "@/lib/payroll-actions";
import { getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

type PayrollPeriodSummaryRow = {
  id: string;
  operator_id: string;
  period_start: string;
  period_end: string;
  status?: string | null;
  route_count?: number | null;
  route_pay_total_lyd?: number | string | null;
  net_total_lyd?: number | string | null;
  paid_at?: string | null;
};

type OperatorPayProfileSummaryRow = {
  id: string;
  team_member_id: string;
  role_level?: string | null;
  active?: boolean | null;
};

type PayrollTeamMemberRow = {
  id: string;
  full_name?: string | null;
  role?: string | null;
  roles?: string[] | null;
  active?: boolean | null;
  active_status?: string | null;
};

function defaultMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default async function PayrollPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; error?: string; saved?: string; paid?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(String(params.month ?? "")) ? String(params.month) : defaultMonthValue();
  const periodStart = `${month}-01`;
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll periods unavailable" body="Supabase is not configured, so Snacky OS cannot load payroll periods." />
      </>
    );
  }

  const [{ data: periods }, { data: payProfiles }, { data: members }] = await Promise.all([
    supabase.from("payroll_periods").select("id, operator_id, period_start, period_end, status, route_count, route_pay_total_lyd, net_total_lyd, paid_at").eq("period_start", periodStart).order("net_total_lyd", { ascending: false }),
    supabase.from("operator_pay_profiles").select("id, team_member_id, role_level, active").eq("active", true).order("team_member_id"),
    supabase
      .from("team_members")
      .select("id, full_name, role, roles, active, active_status")
      .or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}")
      .order("full_name"),
  ]);

  const periodByOperatorId = new Map(((periods ?? []) as PayrollPeriodSummaryRow[]).map((period) => [period.operator_id, period]));
  const profileByOperatorId = new Map(((payProfiles ?? []) as OperatorPayProfileSummaryRow[]).map((payProfile) => [payProfile.team_member_id, payProfile]));
  const rows = ((members ?? []) as PayrollTeamMemberRow[])
    .filter((member) => profileByOperatorId.has(member.id))
    .map((member) => ({
      member,
      payProfile: profileByOperatorId.get(member.id),
      period: periodByOperatorId.get(member.id) ?? null,
    }));

  return (
    <>
      <PageHeader
        title="Payroll Periods"
        subtitle={`Monthly payroll periods for ${month}. Refresh each operator to roll verified routes into the monthly pay run.`}
        breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Payroll periods" }]}
        action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll period refreshed.</div> : null}
      {params.paid ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll period marked paid.</div> : null}

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-800">Payroll month</span>
            <input type="month" name="month" defaultValue={month} className="field-input" />
          </label>
          <button className="btn-primary">Open month</button>
        </form>
      </section>

      {!rows.length ? (
        <EmptyState title="No active pay profiles yet" body="Create operator pay profiles before building monthly payroll periods." action={<SecondaryButton href="/payroll/profiles">Open profiles</SecondaryButton>} />
      ) : (
        <DataTable headers={["Operator", "Role level", "Status", "Route count", "Route pay", "Net total", "Paid at", "Actions"]}>
          {rows.map(({ member, payProfile, period }) => (
            <tr key={member.id}>
              <td className="font-medium text-slate-900">{member.full_name}</td>
              <td><StatusBadge status={payProfile?.role_level ?? "missing"} /></td>
              <td><StatusBadge status={period?.status ?? "draft"} /></td>
              <td>{period?.route_count ?? 0}</td>
              <td>{moneyLabel(period?.route_pay_total_lyd ?? 0)}</td>
              <td>{moneyLabel(period?.net_total_lyd ?? 0)}</td>
              <td>{period?.paid_at ? new Date(period.paid_at).toLocaleString("en-US") : "-"}</td>
              <td>
                <div className="flex flex-wrap gap-2">
                  <form action={refreshPayrollPeriod}>
                    <input type="hidden" name="operator_id" value={member.id} />
                    <input type="hidden" name="period_start" value={month} />
                    <input type="hidden" name="return_path" value={`/payroll/periods?month=${month}`} />
                    <button className="btn-secondary">Refresh</button>
                  </form>
                  {period ? <Link href={`/payroll/periods/${period.id}`} className="link-secondary">Open detail</Link> : <span className="text-sm text-slate-500">Create by refresh</span>}
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
