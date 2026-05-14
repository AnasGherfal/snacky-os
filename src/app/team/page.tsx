import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { formatLastLogin } from "@/lib/team";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  const [{ data: team }, { data: profiles }] = supabase
    ? await Promise.all([
        supabase.from("team_members").select("id, full_name, email, phone, role, active").order("full_name"),
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
                <td><StatusBadge status={member.active ? "active" : "inactive"} /></td>
                <td>{formatLastLogin(profile?.last_login_at)}</td>
                <td>
                  <Link className="link-secondary" href={`/team/${member.id}/edit`}>
                    Edit
                  </Link>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </AppShell>
  );
}
