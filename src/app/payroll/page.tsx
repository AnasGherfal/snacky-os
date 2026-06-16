import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { locationPayrollDistanceKm, moneyLabel, operatorPayProfileIsActive, type OperatorPayProfileRow } from "@/lib/payroll";
import { getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

type PayrollOverviewPeriodRow = {
  id: string;
  operator_id: string;
  period_start: string;
  period_end: string;
  status?: string | null;
  net_total_lyd?: number | string | null;
  route_count?: number | null;
  completed_routes_count?: number | null;
  completed_stops_count?: number | null;
  paid_at?: string | null;
};

type TeamMemberNameRow = {
  id: string;
  full_name?: string | null;
};

function currentMonthStart() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
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

  const monthStart = currentMonthStart();
  const [{ data: payProfiles, error: payProfilesError }, { data: periods, error: periodsError }, { data: locations, error: locationsError }, { data: teamMembers }, { count: completedRouteCount }] = await Promise.all([
    supabase.from("operator_pay_profiles").select("*").order("updated_at", { ascending: false }),
    supabase.from("payroll_periods").select("*").order("period_start", { ascending: false }).limit(8),
    supabase.from("locations").select("*").eq("status", "active").order("name"),
    supabase.from("team_members").select("id, full_name"),
    supabase.from("routes").select("id", { count: "exact", head: true }).gte("completed_at", `${monthStart}T00:00:00`).in("status", ["completed", "reviewed", "verified", "payroll_pending", "paid", "disputed"]),
  ]);

  if (payProfilesError || periodsError || locationsError) {
    console.error("[payroll:overview] Failed to load payroll overview", { payProfilesError, periodsError, locationsError });
    return (
      <>
        <ErrorState
          title="Could not load payroll overview"
          body="Snacky OS could not load payroll setup data. Apply the latest payroll repair migration if this is a new environment."
          action={<SecondaryButton href="/dashboard">Back to dashboard</SecondaryButton>}
        />
      </>
    );
  }

  const activeProfiles = ((payProfiles ?? []) as OperatorPayProfileRow[]).filter((row) => operatorPayProfileIsActive(row));
  const activeLocations = (locations ?? []) as any[];
  const distanceConfiguredCount = activeLocations.filter((location) => locationPayrollDistanceKm(location) !== null).length;
  const missingDistanceLocations = activeLocations.filter((location) => locationPayrollDistanceKm(location) === null);
  const recentPeriods = (periods ?? []) as PayrollOverviewPeriodRow[];
  const teamMemberById = new Map(((teamMembers ?? []) as TeamMemberNameRow[]).map((member) => [member.id, member.full_name ?? "Operator"]));
  const scheduledNetTotal = recentPeriods
    .filter((period) => period.period_start === monthStart)
    .reduce((sum, period) => sum + Number(period.net_total_lyd ?? 0), 0);

  const quickLinks = [
    {
      title: "Operator Pay Profiles",
      body: "Set base salary, route rate, stop rate, km pay, fuel allowance, bonuses, and deductions.",
      href: "/payroll/profiles",
    },
    {
      title: "Location Payroll Distance",
      body: "Set storage source, one-way distance, and round-trip behavior for each active machine location.",
      href: "/locations",
    },
    {
      title: "Payroll Run",
      body: "Preview completed routes and stops for an operator, then create or refresh the payroll run.",
      href: "/payroll/periods",
    },
  ];

  return (
    <>
      <PageHeader
        title="Payroll"
        subtitle="Snacky payroll is built from completed routes, completed stops, and payroll distance set on each location."
        action={<PrimaryButton href="/payroll/periods">Open payroll run</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll changes saved.</div> : null}

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Active pay profiles</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{activeProfiles.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Locations with payroll distance</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{distanceConfiguredCount}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Completed routes this month</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{completedRouteCount ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Scheduled payroll this month</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{moneyLabel(scheduledNetTotal)}</div>
        </div>
      </div>

      <section className="mb-6 grid gap-4 md:grid-cols-3">
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
            <h2 className="text-lg font-semibold text-slate-900">Locations missing payroll distance</h2>
            <p className="mt-1 text-sm text-slate-500">A missing location distance does not crash payroll, but Snacky will calculate that stop as 0 km until it is fixed.</p>
          </div>
          <SecondaryButton href="/locations">Open locations</SecondaryButton>
        </div>
        {!missingDistanceLocations.length ? (
          <EmptyState title="All active locations have payroll distance" body="Completed stops can now contribute distance pay and fuel allowance cleanly." />
        ) : (
          <DataTable headers={["Location", "Type", "Status", "Action"]}>
            {missingDistanceLocations.slice(0, 10).map((location: any) => (
              <tr key={location.id}>
                <td className="font-medium text-slate-900">{location.name}</td>
                <td>{location.location_type ?? "-"}</td>
                <td><StatusBadge status="missing_distance" /></td>
                <td><Link href={`/locations/${location.id}`} className="link-secondary">Set payroll distance</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Recent payroll runs</h2>
            <p className="mt-1 text-sm text-slate-500">Each run stays idempotent for the same operator and period start, and finance is created only when the run is marked paid.</p>
          </div>
          <SecondaryButton href="/payroll/periods">Open payroll run</SecondaryButton>
        </div>
        {!recentPeriods.length ? (
          <EmptyState title="No payroll runs yet" body="Open Payroll Run to preview completed work and create the first payroll record." />
        ) : (
          <DataTable headers={["Operator", "Period", "Status", "Routes", "Stops", "Net pay", "Action"]}>
            {recentPeriods.map((period) => (
              <tr key={period.id}>
                <td className="font-medium text-slate-900">{teamMemberById.get(period.operator_id) ?? "Operator"}</td>
                <td>{period.period_start} to {period.period_end}</td>
                <td><StatusBadge status={period.status} /></td>
                <td>{period.completed_routes_count ?? period.route_count ?? 0}</td>
                <td>{period.completed_stops_count ?? 0}</td>
                <td>{moneyLabel(period.net_total_lyd ?? 0)}</td>
                <td><Link href={`/payroll/periods/${period.id}`} className="link-secondary">Open detail</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
