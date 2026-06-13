import { redirect } from "next/navigation";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton, ErrorState } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll, normalizeRoles } from "@/lib/authz";
import { defaultOperatorPayProfileValues, inferredRoleLevelFromTeamMember, normalizeOperatorRoleLevel } from "@/lib/payroll";
import { saveOperatorPayProfile } from "@/lib/payroll-actions";
import { getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

export default async function OperatorPayProfileDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const { id } = await params;
  const query = await searchParams;
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll profile unavailable" body="Supabase is not configured, so Snacky OS cannot edit this payroll profile." />
      </>
    );
  }

  const [{ data: member }, { data: payProfile }] = await Promise.all([
    supabase.from("team_members").select("id, full_name, role, roles, active, active_status").eq("id", id).maybeSingle(),
    supabase.from("operator_pay_profiles").select("*").eq("team_member_id", id).maybeSingle(),
  ]);

  if (!member) redirect("/payroll/profiles?error=Team%20member%20not%20found.");

  const defaultRoleLevel = normalizeOperatorRoleLevel(payProfile?.role_level ?? inferredRoleLevelFromTeamMember(member));
  const defaults = defaultOperatorPayProfileValues(defaultRoleLevel);
  const roles = normalizeRoles(member.roles, member.role);

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={member.full_name}
          subtitle={`Payroll profile for ${member.full_name}. Selected roles: ${roles.join(", ")}.`}
          breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Profiles", href: "/payroll/profiles" }, { label: member.full_name }]}
          action={<SecondaryButton href="/payroll/profiles">Back to profiles</SecondaryButton>}
        />

        {query.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{query.error}</div> : null}
        {query.saved ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll profile saved.</div> : null}

        <form action={saveOperatorPayProfile} className="space-y-6">
          <input type="hidden" name="team_member_id" value={member.id} />
          <input type="hidden" name="active" value={String(payProfile?.active ?? (member.active_status === "inactive" ? false : member.active !== false))} />

          <FormSection title="Role level and monthly salary" description="Base salary and allowances are paid once per payroll month before verified route totals are added.">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Role level" required>
                <select name="role_level" defaultValue={defaultRoleLevel} className="field-input">
                  <option value="junior_operator">Junior operator</option>
                  <option value="senior_operator">Senior operator</option>
                  <option value="backup_operator">Backup operator</option>
                </select>
              </FormField>
              <FormField label="Base salary LYD" required>
                <input name="base_salary_lyd" type="number" min="0" step="0.01" defaultValue={payProfile?.base_salary_lyd ?? defaults.base_salary_lyd} className="field-input" />
              </FormField>
              <FormField label="Car allowance LYD" required>
                <input name="car_allowance_lyd" type="number" min="0" step="0.01" defaultValue={payProfile?.car_allowance_lyd ?? defaults.car_allowance_lyd} className="field-input" />
              </FormField>
              <FormField label="Phone allowance LYD" required>
                <input name="phone_allowance_lyd" type="number" min="0" step="0.01" defaultValue={payProfile?.phone_allowance_lyd ?? defaults.phone_allowance_lyd} className="field-input" />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Per-route defaults" description="These values feed the route pay engine before route-specific extras, distance, and manual adjustments are applied.">
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="Route base LYD" required>
                <input name="default_route_base_lyd" type="number" min="0" step="0.01" defaultValue={payProfile?.default_route_base_lyd ?? defaults.default_route_base_lyd} className="field-input" />
              </FormField>
              <FormField label="Stop rate LYD" required>
                <input name="default_stop_rate_lyd" type="number" min="0" step="0.01" defaultValue={payProfile?.default_stop_rate_lyd ?? defaults.default_stop_rate_lyd} className="field-input" />
              </FormField>
              <FormField label="KM rate LYD" required hint="Saved now so km-rate distance pay can be switched on later.">
                <input name="default_km_rate_lyd" type="number" min="0" step="0.01" defaultValue={payProfile?.default_km_rate_lyd ?? defaults.default_km_rate_lyd} className="field-input" />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Permissions and notes" description="These flags do not grant app access. They only tell the payroll engine whether route extras like cash collection or buying trips are valid for this operator.">
            <div className="space-y-3">
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4">
                <input name="can_collect_cash" type="checkbox" value="yes" defaultChecked={Boolean(payProfile?.can_collect_cash ?? defaults.can_collect_cash)} className="mt-1" />
                <span>
                  <span className="block font-semibold text-slate-900">can_collect_cash</span>
                  <span className="text-sm text-slate-500">Allows automatic or manual cash collection extras to count in payroll.</span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4">
                <input name="can_buy_stock" type="checkbox" value="yes" defaultChecked={Boolean(payProfile?.can_buy_stock ?? defaults.can_buy_stock)} className="mt-1" />
                <span>
                  <span className="block font-semibold text-slate-900">can_buy_stock</span>
                  <span className="text-sm text-slate-500">Allows buying trip extras to count without a manual override exception.</span>
                </span>
              </label>
              <FormField label="Notes">
                <textarea name="notes" rows={4} defaultValue={payProfile?.notes ?? defaults.notes ?? ""} className="field-input" placeholder="Optional payroll note, contract detail, or internal reminder." />
              </FormField>
            </div>
          </FormSection>

          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Save payroll profile</PrimaryButton>
            <SecondaryButton href="/payroll/profiles">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </>
  );
}
