import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { locationPayrollDistanceKm, moneyLabel } from "@/lib/payroll";
import { buildPayrollLoadFailureBody, getPayrollV2ServerClient, logPayrollQueryIssue, type PayrollQueryIssue, type PayrollRunRow } from "@/lib/payroll-v2";

export const dynamic = "force-dynamic";

type TeamMemberNameRow = {
  id: string;
  full_name?: string | null;
};

function currentMonthStart() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export default async function PayrollOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; paid?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollV2ServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll unavailable" body="Supabase is not configured, so Snacky OS cannot load payroll data." />
      </>
    );
  }

  const monthStart = currentMonthStart();
  const [
    payProfilesResult,
    payrollRunsResult,
    locationsResult,
    incidentsResult,
    { data: teamMembers },
    { count: completedRouteCount },
  ] = await Promise.all([
    supabase.from("operator_pay_profile_versions").select("*").eq("is_active", true).order("updated_at", { ascending: false }),
    supabase.from("payroll_runs").select("*").order("period_start", { ascending: false }).limit(8),
    supabase.from("locations").select("*").eq("status", "active").order("name"),
    supabase.from("operator_incidents").select("id, status", { count: "exact" }).in("status", ["pending", "approved"]),
    supabase.from("team_members").select("id, full_name"),
    supabase.from("routes").select("id", { count: "exact", head: true }).gte("completed_at", `${monthStart}T00:00:00`).in("status", ["completed", "reviewed", "verified", "payroll_pending", "paid", "disputed"]),
  ]);

  const payProfiles = payProfilesResult.data ?? [];
  const payrollRuns = payrollRunsResult.data ?? [];
  const locations = locationsResult.data ?? [];
  const incidents = incidentsResult.data ?? [];
  const issues: PayrollQueryIssue[] = [
    { table: "operator_pay_profile_versions", step: "load_active_pay_profiles", error: payProfilesResult.error, resultEmpty: !payProfilesResult.error && payProfiles.length === 0 },
    { table: "payroll_runs", step: "load_recent_payroll_runs", error: payrollRunsResult.error, resultEmpty: !payrollRunsResult.error && payrollRuns.length === 0 },
    { table: "locations", step: "load_active_locations", error: locationsResult.error, resultEmpty: !locationsResult.error && locations.length === 0 },
    { table: "operator_incidents", step: "load_pending_incidents", error: incidentsResult.error, resultEmpty: !incidentsResult.error && incidents.length === 0 },
  ].filter((issue) => Boolean(issue.error));

  if (issues.length) {
    issues.forEach((issue) =>
      logPayrollQueryIssue({
        module: "payroll:overview",
        profile,
        table: issue.table,
        step: issue.step,
        error: issue.error,
        resultEmpty: issue.resultEmpty,
      }),
    );
    return (
      <>
        <ErrorState
          title="Could not load payroll overview"
          body={buildPayrollLoadFailureBody({
            noun: "payroll overview",
            issues,
            defaultBody: "Snacky OS could not load payroll setup data right now.",
          })}
          action={<SecondaryButton href="/dashboard">Back to dashboard</SecondaryButton>}
        />
      </>
    );
  }

  const activeLocations = locations as Array<Record<string, unknown>>;
  const missingDistanceLocations = activeLocations.filter((location) => locationPayrollDistanceKm(location) === null);
  const distanceConfiguredCount = activeLocations.filter((location) => locationPayrollDistanceKm(location) !== null).length;
  const recentRuns = payrollRuns as PayrollRunRow[];
  const pendingIncidentCount = (incidents as Array<{ status?: string | null }>).filter((incident) => incident.status === "pending").length;
  const scheduledNetTotal = recentRuns
    .filter((run) => run.period_start === monthStart)
    .reduce((sum, run) => sum + Number(run.net_pay_lyd ?? 0), 0);
  const teamMemberById = new Map(((teamMembers ?? []) as TeamMemberNameRow[]).map((member) => [member.id, member.full_name ?? "Operator"]));

  const quickLinks = [
    {
      title: "Operator Pay Profiles",
      body: "Set only the recurring rules: base salary, route rate, stop rate, km pay, and fuel allowance.",
      href: "/payroll/profiles",
    },
    {
      title: "Location Payroll Distance",
      body: "Maintain the manual one-way or round-trip distance each completed stop should use.",
      href: "/payroll/distances",
    },
    {
      title: "Operator Incidents",
      body: "Approve or cancel incident deductions before they appear in payroll preview.",
      href: "/payroll/incidents",
    },
    {
      title: "Payroll Runs",
      body: "Preview completed work, create the run, and create finance only when it is marked paid.",
      href: "/payroll/periods",
    },
  ];

  return (
    <>
      <PageHeader
        title="Payroll"
        subtitle="Snacky payroll runs from completed routes, completed stops, location payroll distance, and approved incident deductions."
        action={<PrimaryButton href="/payroll/periods">Open payroll runs</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll changes saved.</div> : null}
      {params.paid ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll run marked paid.</div> : null}

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Active pay profiles</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{payProfiles?.length ?? 0}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Locations with payroll distance</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{distanceConfiguredCount}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Pending incidents</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{pendingIncidentCount}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Scheduled payroll this month</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{moneyLabel(scheduledNetTotal)}</div>
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

      {!payProfiles.length ? (
        <section className="mb-6">
          <EmptyState
            title="No operator pay profiles yet"
            body="Create the first pay profile before building payroll runs."
            action={<PrimaryButton href="/payroll/profiles">Create first pay profile</PrimaryButton>}
          />
        </section>
      ) : null}

      <section className="surface-card mb-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Locations missing payroll distance</h2>
            <p className="mt-1 text-sm text-slate-500">Missing distance never crashes payroll, but affected stops are calculated as 0 km until the location is fixed.</p>
          </div>
          <SecondaryButton href="/payroll/distances">Open distance setup</SecondaryButton>
        </div>
        {!missingDistanceLocations.length ? (
          <EmptyState title="All active locations have payroll distance" body="Completed stops can now contribute distance pay and fuel allowance cleanly." />
        ) : (
          <DataTable headers={["Location", "Type", "Status", "Action"]}>
            {missingDistanceLocations.slice(0, 10).map((location) => (
              <tr key={String(location.id)}>
                <td className="font-medium text-slate-900">{String(location.name ?? "Unknown location")}</td>
                <td>{String(location.location_type ?? "-")}</td>
                <td><StatusBadge status="missing_distance" /></td>
                <td><Link href="/payroll/distances" className="link-secondary">Set payroll distance</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Operations feeding payroll</h2>
            <p className="mt-1 text-sm text-slate-500">Only completed routes and completed stops count toward payroll runs.</p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <div className="text-sm text-slate-500">Completed routes this month</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{completedRouteCount ?? 0}</div>
          </div>
          <div>
            <div className="text-sm text-slate-500">Distance setup page</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">Manual KM</div>
          </div>
          <div>
            <div className="text-sm text-slate-500">Deduction source</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">Approved incidents</div>
          </div>
          <div>
            <div className="text-sm text-slate-500">Finance sync timing</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">On paid only</div>
          </div>
        </div>
      </section>

      <section className="surface-card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Recent payroll runs</h2>
            <p className="mt-1 text-sm text-slate-500">Runs stay idempotent per operator and exact period, and finance is only created after payment.</p>
          </div>
          <SecondaryButton href="/payroll/periods">Open payroll runs</SecondaryButton>
        </div>
        {!recentRuns.length ? (
          <EmptyState title="No payroll runs yet" body="Open Payroll Runs to preview completed work and create the first payroll record." />
        ) : (
          <DataTable headers={["Operator", "Period", "Status", "Routes", "Stops", "Net pay", "Action"]}>
            {recentRuns.map((run) => (
              <tr key={run.id}>
                <td className="font-medium text-slate-900">{teamMemberById.get(run.operator_id) ?? "Operator"}</td>
                <td>{run.period_start} to {run.period_end}</td>
                <td><StatusBadge status={run.status} /></td>
                <td>{run.completed_routes_count ?? 0}</td>
                <td>{run.completed_stops_count ?? 0}</td>
                <td>{moneyLabel(run.net_pay_lyd ?? 0)}</td>
                <td><Link href={`/payroll/periods/${run.id}`} className="link-secondary">Open detail</Link></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
