import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll, normalizeRoles } from "@/lib/authz";
import {
  inferredRoleLevelFromTeamMember,
  moneyLabel,
  operatorPayProfileBaseMonthlySalary,
  operatorPayProfileBonus,
  operatorPayProfileDeduction,
  operatorPayProfileFuelAllowancePerKm,
  operatorPayProfileIsActive,
  operatorPayProfilePayPerKm,
  operatorPayProfilePayPerRoute,
  operatorPayProfilePayPerStop,
  type OperatorPayProfileRow,
} from "@/lib/payroll";
import { getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

type PayrollProfileTeamMemberRow = {
  id: string;
  full_name?: string | null;
  role?: string | null;
  roles?: string[] | null;
  active?: boolean | null;
  active_status?: string | null;
};

export default async function OperatorPayProfilesPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll profiles unavailable" body="Supabase is not configured, so Snacky OS cannot load operator pay profiles." />
      </>
    );
  }

  const [{ data: members, error: membersError }, { data: payProfiles, error: payProfilesError }] = await Promise.all([
    supabase
      .from("team_members")
      .select("id, full_name, role, roles, active, active_status")
      .or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}")
      .order("full_name"),
    supabase.from("operator_pay_profiles").select("*").order("updated_at", { ascending: false }),
  ]);

  if (membersError || payProfilesError) {
    console.error("[payroll:profiles] Failed to load payroll profiles", { membersError, payProfilesError });
    return (
      <>
        <ErrorState
          title="Could not load payroll profiles"
          body="Snacky OS could not load operator pay profile settings. Apply the latest payroll repair migration if this is a new environment."
          action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
        />
      </>
    );
  }

  const profileByTeamMemberId = new Map(((payProfiles ?? []) as OperatorPayProfileRow[]).map((row) => [row.team_member_id, row]));
  const rows = ((members ?? []) as PayrollProfileTeamMemberRow[]).map((member) => {
    const payProfile = profileByTeamMemberId.get(member.id) ?? null;
    return {
      member,
      payProfile,
      roles: normalizeRoles(member.roles, member.role),
      inferredRoleLevel: inferredRoleLevelFromTeamMember(member),
    };
  });

  return (
    <>
      <PageHeader
        title="Operator Pay Profiles"
        subtitle="Set the exact rates used by Snacky payroll: base salary, per-route pay, per-stop pay, distance pay, fuel allowance, bonuses, and deductions."
        action={<PrimaryButton href="/payroll">Back to payroll</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Operator pay profile saved.</div> : null}

      {!rows.length ? (
        <EmptyState title="No route performers found" body="Create at least one active operator before configuring payroll." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map(({ member, payProfile, roles, inferredRoleLevel }) => {
            const isActive = payProfile
              ? operatorPayProfileIsActive(payProfile) && member.active !== false && member.active_status !== "inactive"
              : member.active !== false && member.active_status !== "inactive";

            return (
              <article key={member.id} className="surface-card rounded-2xl border border-slate-200">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">{member.full_name}</h2>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {roles.map((role) => <StatusBadge key={role} status={role} />)}
                      <StatusBadge status={isActive ? "active" : "inactive"} />
                    </div>
                  </div>
                  <Link href={`/payroll/profiles/${member.id}`} className="btn-secondary">
                    {payProfile ? "Edit profile" : "Create profile"}
                  </Link>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Base monthly salary</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">{payProfile ? moneyLabel(operatorPayProfileBaseMonthlySalary(payProfile)) : "-"}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Pay per route</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">{payProfile ? moneyLabel(operatorPayProfilePayPerRoute(payProfile)) : "-"}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Pay per stop</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">{payProfile ? moneyLabel(operatorPayProfilePayPerStop(payProfile)) : "-"}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Pay per km</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">{payProfile ? moneyLabel(operatorPayProfilePayPerKm(payProfile)) : "-"}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Fuel allowance per km</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">{payProfile ? moneyLabel(operatorPayProfileFuelAllowancePerKm(payProfile)) : "-"}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Bonus / deduction</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">
                      {payProfile ? `${moneyLabel(operatorPayProfileBonus(payProfile))} / ${moneyLabel(operatorPayProfileDeduction(payProfile))}` : "-"}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
                  <div className="font-medium text-slate-900">Payroll formula</div>
                  <div className="mt-1">
                    Base salary + completed routes x route rate + completed stops x stop rate + total payroll km x km rate + total payroll km x fuel allowance + bonuses - deductions
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {payProfile
                      ? `Active from ${payProfile.active_from ?? "not set"}${payProfile.active_to ? ` until ${payProfile.active_to}` : ""}.`
                      : `No profile yet. Suggested starter role: ${inferredRoleLevel.replaceAll("_", " ")}.`}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="mt-4">
        <SecondaryButton href="/payroll">Back to overview</SecondaryButton>
      </div>
    </>
  );
}
