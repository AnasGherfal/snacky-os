import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel } from "@/lib/payroll";
import { getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

type TeamMemberNameRow = {
  full_name?: string | null;
};

type PayrollOverviewPeriodRow = {
  id: string;
  operator_id: string;
  net_total_lyd?: number | string | null;
  route_count?: number | null;
  status?: string | null;
};

type PayrollOverviewRouteRow = {
  id: string;
  route_date?: string | null;
  status?: string | null;
  operator?: TeamMemberNameRow | TeamMemberNameRow[] | null;
};

type PayrollBreakdownSummaryRow = {
  route_id: string;
  total_pay_lyd?: number | string | null;
  payroll_period_id?: string | null;
};

function monthStart() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-01`;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function PayrollOverviewPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll unavailable" body="Supabase is not configured, so Snacky OS cannot load payroll data." />
      </>
    );
  }

  const periodStart = monthStart();
  const [{ count: activeProfiles }, { data: currentPeriods }, { data: routesNeedingVerification }, { data: payrollPendingRoutes }] = await Promise.all([
    supabase.from("operator_pay_profiles").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("payroll_periods").select("id, operator_id, net_total_lyd, route_count, status").eq("period_start", periodStart).order("net_total_lyd", { ascending: false }),
    supabase
      .from("routes")
      .select("id, route_date, status, operator:team_members(full_name)")
      .in("status", ["completed", "reviewed", "disputed"])
      .not("operator_id", "is", null)
      .order("route_date", { ascending: false })
      .limit(12),
    supabase
      .from("routes")
      .select("id, route_date, status, operator:team_members(full_name)")
      .in("status", ["payroll_pending", "verified"])
      .not("operator_id", "is", null)
      .order("route_date", { ascending: false })
      .limit(12),
  ]);

  const verificationRoutes = (routesNeedingVerification ?? []) as PayrollOverviewRouteRow[];
  const pendingRoutes = (payrollPendingRoutes ?? []) as PayrollOverviewRouteRow[];
  const routeIds = Array.from(new Set([...verificationRoutes, ...pendingRoutes].map((route) => route.id)));
  const { data: breakdowns } = routeIds.length
    ? await supabase.from("route_pay_breakdowns").select("route_id, total_pay_lyd, payroll_period_id").in("route_id", routeIds)
    : { data: [] };
  const breakdownByRouteId = new Map(((breakdowns ?? []) as PayrollBreakdownSummaryRow[]).map((row) => [row.route_id, row]));
  const scheduledNetTotal = ((currentPeriods ?? []) as PayrollOverviewPeriodRow[]).reduce((sum: number, period) => sum + Number(period.net_total_lyd ?? 0), 0);

  const quickLinks = [
    {
      title: "Operator Pay Profiles",
      body: "Set monthly salary, route base, stop rate, and operator payroll permissions.",
      href: "/payroll/profiles",
    },
    {
      title: "Route Pay Rules",
      body: "Manage distance zones, default extras, and the fixed route pay rule set.",
      href: "/payroll/rules",
    },
    {
      title: "Storage Locations",
      body: "Maintain storage coordinates for future map-based route distance calculation.",
      href: "/storage-locations",
    },
    {
      title: "Payroll Periods",
      body: "Refresh monthly payroll periods, add bonuses or deductions, and mark periods paid.",
      href: "/payroll/periods",
    },
  ];

  return (
    <>
      <PageHeader
        title="Payroll"
        subtitle="Operator pay profiles, verified route pay, and monthly payroll periods for Snacky OS."
        action={<PrimaryButton href="/payroll/periods">Open payroll periods</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll changes saved.</div> : null}

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Active pay profiles</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{activeProfiles ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">This month periods</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{currentPeriods?.length ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Scheduled this month</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{moneyLabel(scheduledNetTotal)}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Routes waiting for verification</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{routesNeedingVerification?.length ?? 0}</div>
        </div>
      </div>

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {quickLinks.map((link) => (
          <Link key={link.href} href={link.href} className="surface-card rounded-xl border border-slate-200 transition hover:-translate-y-0.5 hover:shadow-md">
            <h2 className="text-base font-semibold text-slate-900">{link.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{link.body}</p>
          </Link>
        ))}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Routes waiting for pay verification</h2>
            <p className="mt-1 text-sm text-slate-500">Completed routes only start payroll after an admin verifies their stored route pay breakdown.</p>
          </div>
          <SecondaryButton href="/routes">Open routes</SecondaryButton>
        </div>
        {!routesNeedingVerification?.length ? (
          <EmptyState title="No completed routes waiting for payroll verification" body="Finished routes will appear here when they are ready for the payroll review step." />
        ) : (
          <DataTable headers={["Date", "Operator", "Route status", "Current pay", "Action"]}>
            {verificationRoutes.map((route) => {
              const breakdown = breakdownByRouteId.get(route.id);
              const operator = firstRelation(route.operator);
              return (
                <tr key={route.id}>
                  <td>{route.route_date}</td>
                  <td>{operator?.full_name ?? "-"}</td>
                  <td><StatusBadge status={route.status} /></td>
                  <td>{breakdown ? moneyLabel(breakdown.total_pay_lyd) : "Not calculated yet"}</td>
                  <td><Link href={`/payroll/routes/${route.id}`} className="link-secondary">Open pay detail</Link></td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </section>

      <section className="surface-card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Verified and payroll-pending routes</h2>
            <p className="mt-1 text-sm text-slate-500">These routes are ready to be rolled into monthly payroll periods or are already waiting inside one.</p>
          </div>
          <SecondaryButton href="/payroll/periods">Open periods</SecondaryButton>
        </div>
        {!payrollPendingRoutes?.length ? (
          <EmptyState title="No verified routes ready for payroll" body="Once a route pay breakdown is verified, it will appear here until it is paid." />
        ) : (
          <DataTable headers={["Date", "Operator", "Route status", "Pay", "Period", "Action"]}>
            {pendingRoutes.map((route) => {
              const breakdown = breakdownByRouteId.get(route.id);
              const operator = firstRelation(route.operator);
              return (
                <tr key={route.id}>
                  <td>{route.route_date}</td>
                  <td>{operator?.full_name ?? "-"}</td>
                  <td><StatusBadge status={route.status} /></td>
                  <td>{breakdown ? moneyLabel(breakdown.total_pay_lyd) : "-"}</td>
                  <td>{breakdown?.payroll_period_id ? <Link href={`/payroll/periods/${breakdown.payroll_period_id}`} className="link-secondary">Open period</Link> : "-"}</td>
                  <td><Link href={`/payroll/routes/${route.id}`} className="link-secondary">Open pay detail</Link></td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </section>
    </>
  );
}
