import { notFound, redirect } from "next/navigation";
import { TeamMemberForm } from "@/components/TeamMemberForm";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, normalizeRoles, parseAppRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { updateTeamMember } from "@/lib/team-actions";

export const dynamic = "force-dynamic";

export default async function EditTeamMemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return (
      <>
        <ErrorState title="Team unavailable" body="Supabase is not configured." action={<SecondaryButton href="/team">Back to team</SecondaryButton>} />
      </>
    );
  }

  const { data: member, error: memberError } = await supabase
    .from("team_members")
    .select("id, full_name, email, phone, role, roles, can_add_products, active, auth_user_id, must_change_password")
    .eq("id", id)
    .maybeSingle();

  if (memberError) console.error("[team:edit] Failed to load member", { id, error: memberError });
  if (!member) notFound();

  const role = parseAppRole(member.role) ?? "viewer";
  const roles = normalizeRoles((member as any).roles, member.role);

  return (
    <>
      <FormPageLayout>
        <PageHeader title="Edit team member" subtitle={`Update role, status, and contact details for ${member.full_name}.`} />
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
            {error}
          </div>
        ) : null}
        <TeamMemberForm
          action={updateTeamMember}
          submitLabel="Save changes"
          member={{
            id: member.id,
            full_name: member.full_name,
            email: member.email,
            phone: member.phone,
            role,
            roles,
            can_add_products: Boolean((member as any).can_add_products),
            active: member.active,
            auth_user_id: member.auth_user_id,
            must_change_password: member.must_change_password,
          }}
        />
      </FormPageLayout>
    </>
  );
}
