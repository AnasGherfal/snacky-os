import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { formatLastLogin, tempPasswordCookie } from "@/lib/team";

export const dynamic = "force-dynamic";

function parseTempPasswordCookie(value: string | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as { fullName: string; email: string; password: string };
  } catch {
    return null;
  }
}

export default async function TeamPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");
  const cookieStore = await cookies();
  const tempPassword = parseTempPasswordCookie(cookieStore.get(tempPasswordCookie)?.value);

  const supabase = getSupabaseServerClient();
  const [{ data: team }, { data: profiles }] = supabase
    ? await Promise.all([
        supabase.from("team_members").select("id, full_name, email, phone, role, active, active_status, auth_user_id, must_change_password").order("full_name"),
        supabase.from("profiles").select("id, email, team_member_id, last_login_at"),
      ])
    : [{ data: [] }, { data: [] }];

  const profileByTeamId = new Map((profiles ?? []).filter((profile: any) => profile.team_member_id).map((profile: any) => [profile.team_member_id, profile]));
  const profileByEmail = new Map((profiles ?? []).filter((profile: any) => profile.email).map((profile: any) => [String(profile.email).toLowerCase(), profile]));

  return (
    <AppShell>
      <PageHeader
        title="Team"
        subtitle="Manage Snacky OS users, roles, login links, and operational access."
        action={<PrimaryButton href="/team/new">Add team member</PrimaryButton>}
      />

      {tempPassword ? (
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-semibold">Copy this password now. It will not be shown again.</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div><span className="text-amber-800">User:</span> {tempPassword.fullName}</div>
            <div><span className="text-amber-800">Email:</span> {tempPassword.email}</div>
            <div><span className="text-amber-800">Temporary password:</span> <span className="font-mono font-semibold">{tempPassword.password}</span></div>
          </div>
        </div>
      ) : null}

      {process.env.NODE_ENV === "development" ? (
        <section className="surface-card mb-5">
          <h2 className="text-base font-semibold text-slate-900">Development operator login helper</h2>
          <p className="mt-1 text-sm text-slate-500">Use this to test the operator route flow locally. Passwords are only shown immediately after creation or reset.</p>
          <div className="mt-3 text-sm">
            {(team ?? []).find((member: any) => member.role === "operator" && member.email)?.email ?? "No operator email available yet."}
          </div>
        </section>
      ) : null}

      {!team?.length ? (
        <EmptyState title="No team members" body="Add admins, supervisors, warehouse users, and operators before assigning routes." />
      ) : (
        <DataTable headers={["Full name", "Email", "Phone", "Role", "Status", "Last login", "Actions"]}>
          {team.map((member: any) => {
            const profile = profileByTeamId.get(member.id) ?? profileByEmail.get(String(member.email ?? "").toLowerCase());

            return (
              <tr key={member.id}>
                <td className="font-medium text-slate-900">{member.full_name}</td>
                <td>{member.email ?? "-"}</td>
                <td>{member.phone ?? "-"}</td>
                <td><StatusBadge status={member.role} /></td>
                <td>
                  <div className="flex flex-col gap-1">
                    <StatusBadge status={member.active_status ?? (member.active ? "active" : "inactive")} />
                    {member.auth_user_id ? <span className="text-xs text-slate-500">Login enabled</span> : <span className="text-xs text-slate-400">No login</span>}
                    {member.must_change_password ? <span className="text-xs font-medium text-amber-700">Must change password</span> : null}
                  </div>
                </td>
                <td>{formatLastLogin(profile?.last_login_at)}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <Link className="link-secondary" href={`/team/${member.id}/activity`}>Activity</Link>
                    <Link className="link-secondary" href={`/team/${member.id}/edit`}>Edit</Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </AppShell>
  );
}
