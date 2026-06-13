import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll, normalizeRoles } from "@/lib/authz";
import { moneyLabel, type OperatorPayProfileRow } from "@/lib/payroll";
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

  const [{ data: members }, { data: payProfiles }] = await Promise.all([
    supabase
      .from("team_members")
      .select("id, full_name, role, roles, active, active_status")
      .or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}")
      .order("full_name"),
    supabase.from("operator_pay_profiles").select("*").order("updated_at", { ascending: false }),
  ]);

  const profileByTeamMemberId = new Map(((payProfiles ?? []) as OperatorPayProfileRow[]).map((row) => [row.team_member_id, row]));
  const rows = ((members ?? []) as PayrollProfileTeamMemberRow[]).map((member) => {
    const payProfile = profileByTeamMemberId.get(member.id) ?? null;
    return {
      member,
      payProfile,
      roles: normalizeRoles(member.roles, member.role),
    };
  });

  return (
    <>
      <PageHeader
        title="Operator Pay Profiles"
        subtitle="Set the base salary and per-route pay defaults that feed the monthly Snacky payroll engine."
        action={<PrimaryButton href="/payroll">Back to payroll</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Operator pay profile saved.</div> : null}

      {!rows.length ? (
        <EmptyState title="No route performers found" body="Create at least one active operator or supervisor who can execute routes before configuring payroll." />
      ) : (
        <DataTable headers={["Team member", "Roles", "Role level", "Base salary", "Route base", "Stop rate", "Permissions", "Status", "Action"]}>
          {rows.map(({ member, payProfile, roles }) => (
            <tr key={member.id}>
              <td className="font-medium text-slate-900">{member.full_name}</td>
              <td><div className="flex flex-wrap gap-1">{roles.map((role) => <StatusBadge key={role} status={role} />)}</div></td>
              <td>{payProfile ? <StatusBadge status={payProfile.role_level} /> : <span className="text-slate-500">Not created</span>}</td>
              <td>{payProfile ? moneyLabel(payProfile.base_salary_lyd) : "-"}</td>
              <td>{payProfile ? moneyLabel(payProfile.default_route_base_lyd) : "-"}</td>
              <td>{payProfile ? moneyLabel(payProfile.default_stop_rate_lyd) : "-"}</td>
              <td>
                {payProfile ? (
                  <div className="space-y-1 text-xs text-slate-600">
                    <div>{payProfile.can_collect_cash ? "Can collect cash" : "No cash collection"}</div>
                    <div>{payProfile.can_buy_stock ? "Can buy stock" : "No buying trips"}</div>
                  </div>
                ) : (
                  <span className="text-slate-500">-</span>
                )}
              </td>
              <td><StatusBadge status={payProfile?.active === false || member.active === false || member.active_status === "inactive" ? "inactive" : "active"} /></td>
              <td>
                <Link href={`/payroll/profiles/${member.id}`} className="link-secondary">
                  {payProfile ? "Edit profile" : "Create profile"}
                </Link>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      <div className="mt-4">
        <SecondaryButton href="/payroll">Back to overview</SecondaryButton>
      </div>
    </>
  );
}
