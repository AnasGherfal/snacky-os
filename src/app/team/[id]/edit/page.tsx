import { notFound, redirect } from "next/navigation";
import { TeamMemberForm } from "@/components/TeamMemberForm";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, normalizeRoles, parseAppRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { deactivateTeamMember, deleteTeamMember, updateTeamMember } from "@/lib/team-actions";

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

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return (
      <>
        <ErrorState title="Team unavailable" body="Supabase is not configured." action={<SecondaryButton href="/team">Back to team</SecondaryButton>} />
      </>
    );
  }

  const { data: member, error: memberError } = await supabase
    .from("team_members")
    .select("id, full_name, email, phone, role, roles, can_add_products, active, active_status, auth_user_id, must_change_password")
    .eq("id", id)
    .maybeSingle();

  if (memberError) console.error("[team:edit] Failed to load member", { id, error: memberError });
  if (!member) notFound();

  const role = parseAppRole(member.role) ?? "viewer";
  const roles = normalizeRoles((member as any).roles, member.role);
  const isActive = member.active !== false && member.active_status !== "inactive";
  const viewingOwnAccount = profile.team_member_id === member.id || profile.id === member.auth_user_id;

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Edit team member"
          subtitle={`Update roles, login access, and account status for ${member.full_name}.`}
          action={<SecondaryButton href={`/team/${member.id}`}>Back to profile</SecondaryButton>}
        />
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

        <section className="surface-card border border-rose-200 p-5">
          <div className="mb-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-rose-600">Danger zone</div>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">Remove team access</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Deactivate people who have worked in Snacky so their route, cash, inventory, payroll, purchase, issue, and CRM history stays intact. Permanent delete is only for unused or mistaken team records.
            </p>
          </div>

          {viewingOwnAccount ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              You cannot deactivate or permanently delete the account you are currently using.
            </div>
          ) : (
            <div className="grid gap-5 xl:grid-cols-2">
              <form action={deactivateTeamMember} className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <input type="hidden" name="id" value={member.id} />
                <h3 className="font-semibold text-amber-950">Deactivate member</h3>
                <p className="mt-1 text-sm text-amber-900">
                  Removes Snacky OS access while preserving all history and records. This is the normal choice when someone leaves the team.
                </p>
                {isActive ? (
                  <>
                    <label className="mt-4 block text-sm font-medium text-amber-950">
                      Reason
                      <input
                        name="reason"
                        required
                        className="field-input mt-1"
                        placeholder="Left the team / access no longer needed"
                      />
                    </label>
                    <label className="mt-3 flex items-start gap-2 text-sm text-amber-950">
                      <input name="confirm_action" type="checkbox" value="yes" required className="mt-1" />
                      <span>I confirm this member should lose access to Snacky OS.</span>
                    </label>
                    <button type="submit" className="mt-4 inline-flex min-h-10 items-center justify-center rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100">
                      Deactivate member
                    </button>
                  </>
                ) : (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-white/70 p-3 text-sm font-medium text-amber-900">
                    This member is already inactive.
                  </div>
                )}
              </form>

              <form action={deleteTeamMember} className="rounded-lg border border-rose-200 bg-rose-50 p-4">
                <input type="hidden" name="id" value={member.id} />
                <h3 className="font-semibold text-rose-950">Delete permanently</h3>
                <p className="mt-1 text-sm text-rose-900">
                  Use this only for a duplicate, test, or mistaken member. Snacky OS checks every linked record first and blocks deletion if this person has operational history.
                </p>
                <label className="mt-4 block text-sm font-medium text-rose-950">
                  Reason
                  <input
                    name="reason"
                    required
                    className="field-input mt-1"
                    placeholder="Duplicate member / test account / created by mistake"
                  />
                </label>
                <label className="mt-3 block text-sm font-medium text-rose-950">
                  Type DELETE to confirm
                  <input
                    name="delete_confirmation"
                    required
                    pattern="DELETE"
                    className="field-input mt-1 font-mono"
                    autoComplete="off"
                    placeholder="DELETE"
                  />
                </label>
                <label className="mt-3 flex items-start gap-2 text-sm text-rose-950">
                  <input name="confirm_action" type="checkbox" value="yes" required className="mt-1" />
                  <span>I understand this permanently removes the team member and their login account.</span>
                </label>
                <button type="submit" className="mt-4 inline-flex min-h-10 items-center justify-center rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700">
                  Delete permanently
                </button>
              </form>
            </div>
          )}
        </section>
      </FormPageLayout>
    </>
  );
}
