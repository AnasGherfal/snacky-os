import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import type { AppPermission } from "@/lib/authz";
import { getEffectivePermissions, isOwnerAdminRole, normalizeRoles } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
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

const permissionDebugItems: { permission: AppPermission; label: string }[] = [
  { permission: "products.view", label: "products.view" },
  { permission: "inventory.view", label: "inventory.view" },
  { permission: "storage.adjust", label: "storage.adjust" },
  { permission: "finance.view", label: "finance.view" },
];

export default async function TeamPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const cookieStore = await cookies();
  const tempPassword = parseTempPasswordCookie(cookieStore.get(tempPasswordCookie)?.value);

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Team unavailable" body="Supabase is not configured, so Snacky OS cannot load team members." />
      </>
    );
  }
  const { data: team, count, error: teamError } = await supabase
    .from("team_members")
    .select("id, full_name, email, phone, role, roles, can_add_products, active, active_status, auth_user_id, must_change_password", { count: "exact" })
    .order("full_name")
    .range(from, to);
  const memberIds = (team ?? []).map((member: any) => member.id).filter(Boolean);
  const memberEmails = (team ?? []).map((member: any) => String(member.email ?? "").toLowerCase()).filter(Boolean);
  const [{ data: profilesById, error: profilesByIdError }, { data: profilesByEmail, error: profilesByEmailError }, { data: devOperator }] = await Promise.all([
    memberIds.length ? supabase.from("profiles").select("id, email, team_member_id, last_login_at").in("team_member_id", memberIds) : Promise.resolve({ data: [], error: null }),
    memberEmails.length ? supabase.from("profiles").select("id, email, team_member_id, last_login_at").in("email", memberEmails) : Promise.resolve({ data: [], error: null }),
    process.env.NODE_ENV === "development"
      ? supabase.from("team_members").select("email").or("role.eq.operator,roles.cs.{operator}").not("email", "is", null).order("full_name").limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const loadError = teamError ?? profilesByIdError ?? profilesByEmailError;
  if (loadError) {
    console.error("[team] Failed to load team page", loadError);
    return (
      <>
        <ErrorState title="Could not load team" body="Snacky OS could not load team members or login profile metadata." action={<SecondaryButton href="/team">Retry</SecondaryButton>} />
      </>
    );
  }

  const profiles = [...(profilesById ?? []), ...(profilesByEmail ?? [])];
  const profileByTeamId = new Map(profiles.filter((profile: any) => profile.team_member_id).map((profile: any) => [profile.team_member_id, profile]));
  const profileByEmail = new Map(profiles.filter((profile: any) => profile.email).map((profile: any) => [String(profile.email).toLowerCase(), profile]));

  return (
    <>
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
            {devOperator?.email ?? "No operator email available yet."}
          </div>
        </section>
      ) : null}

      {!team?.length ? (
        <EmptyState title="No team members" body="Add admins, supervisors, warehouse users, and operators before assigning routes." />
      ) : (
        <>
          <DataTable headers={["Full name", "Email", "Phone", "Roles", "Effective permissions", "Product add", "Status", "Last login", "Actions"]}>
            {team.map((member: any) => {
              const profile = profileByTeamId.get(member.id) ?? profileByEmail.get(String(member.email ?? "").toLowerCase());
              const roles = normalizeRoles(member.roles, member.role);
              const effectivePermissions = new Set(getEffectivePermissions({ id: member.id, role: roles[0], roles, canAddProducts: member.can_add_products, activeStatus: member.active_status ?? (member.active ? "active" : "inactive") }));

              return (
                <tr key={member.id}>
                  <td className="font-medium text-slate-900">{member.full_name}</td>
                  <td>{member.email ?? "-"}</td>
                  <td>{member.phone ?? "-"}</td>
                  <td><div className="flex flex-wrap gap-1">{roles.map((role) => <StatusBadge key={role} status={role} />)}</div></td>
                  <td>
                    <div className="grid gap-1 text-xs">
                      {permissionDebugItems.map((item) => (
                        <div key={item.permission} className="flex items-center justify-between gap-3">
                          <span className="font-mono text-slate-600">{item.label}</span>
                          <span className={effectivePermissions.has(item.permission) ? "font-semibold text-emerald-700" : "font-semibold text-slate-400"}>
                            {effectivePermissions.has(item.permission) ? "yes" : "no"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </td>
                  <td>{member.can_add_products ? <StatusBadge status="enabled" /> : <span className="text-slate-500">-</span>}</td>
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
                      <Link className="link-secondary" href={`/team/${member.id}`}>Profile</Link>
                       <Link className="link-secondary" href={`/team/${member.id}/activity`}>Activity</Link>
                      <Link className="link-secondary" href={`/team/${member.id}/edit`}>Edit</Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/team" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="team members" />
        </>
      )}
    </>
  );
}
