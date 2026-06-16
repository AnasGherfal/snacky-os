import { redirect } from "next/navigation";
import { ErrorState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll, normalizeRoles } from "@/lib/authz";
import {
  defaultOperatorPayProfileValues,
  inferredRoleLevelFromTeamMember,
  normalizeOperatorRoleLevel,
  operatorPayProfileBaseMonthlySalary,
  operatorPayProfileBonus,
  operatorPayProfileDeduction,
  operatorPayProfileFuelAllowancePerKm,
  operatorPayProfilePayPerKm,
  operatorPayProfilePayPerRoute,
  operatorPayProfilePayPerStop,
} from "@/lib/payroll";
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

  const [{ data: member, error: memberError }, { data: payProfile, error: payProfileError }] = await Promise.all([
    supabase.from("team_members").select("id, full_name, role, roles, active, active_status").eq("id", id).maybeSingle(),
    supabase.from("operator_pay_profiles").select("*").eq("team_member_id", id).maybeSingle(),
  ]);

  if (memberError || payProfileError) {
    console.error("[payroll:profile-detail] Failed to load payroll profile detail", { memberError, payProfileError, teamMemberId: id });
  }

  if (!member) redirect("/payroll/profiles?error=Team%20member%20not%20found.");

  const defaultRoleLevel = normalizeOperatorRoleLevel(payProfile?.role_level ?? inferredRoleLevelFromTeamMember(member));
  const defaults = defaultOperatorPayProfileValues(defaultRoleLevel);
  const roles = normalizeRoles(member.roles, member.role);
  const today = new Date().toISOString().slice(0, 10);
  const activeFrom = payProfile?.active_from ?? defaults.active_from ?? today;
  const activeTo = payProfile?.active_to ?? "";
  const isActive = payProfile?.is_active ?? payProfile?.active ?? (member.active_status === "inactive" ? false : member.active !== false);

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={member.full_name}
          subtitle={`Payroll profile for ${member.full_name}. Roles: ${roles.join(", ")}.`}
          breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Profiles", href: "/payroll/profiles" }, { label: member.full_name }]}
          action={<SecondaryButton href="/payroll/profiles">Back to profiles</SecondaryButton>}
        />

        {query.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{query.error}</div> : null}
        {query.saved ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Payroll profile saved.</div> : null}

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <div className="font-medium text-slate-900">Payroll formula</div>
          <div className="mt-1">
            Base salary + completed route pay + completed stop pay + distance pay + fuel allowance + bonuses - deductions
          </div>
        </div>

        <form action={saveOperatorPayProfile} className="space-y-6">
          <input type="hidden" name="team_member_id" value={member.id} />
          <input type="hidden" name="role_level" value={defaultRoleLevel} />

          <FormSection title="Pay rates" description="These rates are used directly when Snacky calculates payroll from completed routes and completed stops.">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <FormField label="Base monthly salary LYD" required>
                <input
                  name="base_monthly_salary_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfileBaseMonthlySalary(payProfile) : defaults.base_monthly_salary_lyd ?? defaults.base_salary_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Pay per route LYD" required>
                <input
                  name="pay_per_route_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfilePayPerRoute(payProfile) : defaults.pay_per_route_lyd ?? defaults.default_route_base_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Pay per stop LYD" required>
                <input
                  name="pay_per_stop_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfilePayPerStop(payProfile) : defaults.pay_per_stop_lyd ?? defaults.default_stop_rate_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Pay per km LYD" required>
                <input
                  name="pay_per_km_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfilePayPerKm(payProfile) : defaults.pay_per_km_lyd ?? defaults.default_km_rate_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Fuel allowance per km LYD">
                <input
                  name="fuel_allowance_per_km_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfileFuelAllowancePerKm(payProfile) : defaults.fuel_allowance_per_km_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Bonus LYD">
                <input
                  name="bonus_lyd"
                  type="number"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfileBonus(payProfile) : defaults.bonus_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Deduction LYD">
                <input
                  name="deduction_lyd"
                  type="number"
                  step="0.01"
                  defaultValue={payProfile ? operatorPayProfileDeduction(payProfile) : defaults.deduction_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Active dates" description="Use the active window to show when this pay profile applies. Snacky keeps one profile row per operator and refreshes it in place.">
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="Active from" required>
                <input name="active_from" type="date" defaultValue={activeFrom} className="field-input" />
              </FormField>
              <FormField label="Active to">
                <input name="active_to" type="date" defaultValue={activeTo} className="field-input" />
              </FormField>
              <FormField label="Status" required>
                <select name="is_active" defaultValue={String(isActive)} className="field-input">
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Notes" description="Keep contract notes, payroll reminders, or context that explains this operator’s rates.">
            <FormField label="Notes">
              <textarea
                name="notes"
                rows={4}
                defaultValue={payProfile?.notes ?? defaults.notes ?? ""}
                className="field-input"
                placeholder="Optional payroll note, contract detail, or internal reminder."
              />
            </FormField>
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
