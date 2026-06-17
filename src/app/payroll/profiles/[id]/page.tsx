import { redirect } from "next/navigation";
import { DataTable, ErrorState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll, normalizeRoles } from "@/lib/authz";
import { defaultOperatorPayProfileValues, inferredRoleLevelFromTeamMember, moneyLabel, normalizeOperatorRoleLevel } from "@/lib/payroll";
import { saveOperatorPayProfileVersion } from "@/lib/payroll-v2-actions";
import { getPayrollV2ServerClient, listOperatorPayProfileVersions } from "@/lib/payroll-v2";

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
  const supabase = await getPayrollV2ServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll profile unavailable" body="Supabase is not configured, so Snacky OS cannot edit this payroll profile." />
      </>
    );
  }

  const [{ data: member, error: memberError }, payProfiles] = await Promise.all([
    supabase.from("team_members").select("id, full_name, role, roles, active, active_status").eq("id", id).maybeSingle(),
    listOperatorPayProfileVersions(supabase, [id]),
  ]);

  if (memberError) {
    console.error("[payroll:profile-detail] Failed to load payroll profile detail", { memberError, teamMemberId: id });
  }
  if (!member) redirect("/payroll/profiles?error=Team%20member%20not%20found.");

  const currentProfile = payProfiles.find((row) => Boolean(row.is_active)) ?? payProfiles[0] ?? null;
  const defaultRoleLevel = normalizeOperatorRoleLevel(inferredRoleLevelFromTeamMember(member));
  const defaults = defaultOperatorPayProfileValues(defaultRoleLevel);
  const roles = normalizeRoles(member.roles, member.role);
  const today = new Date().toISOString().slice(0, 10);

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
          <div className="font-medium text-slate-900">How versioning works</div>
          <div className="mt-1">
            Keep the effective since date simple. If you save a later effective date, Snacky closes the current active profile and creates a new version automatically.
          </div>
        </div>

        <form action={saveOperatorPayProfileVersion} className="space-y-6">
          <input type="hidden" name="operator_id" value={member.id} />
          <input type="hidden" name="profile_id" value={currentProfile?.id ?? ""} />

          <FormSection title="Current pay rules" description="Only the recurring pay rules belong here. Incident deductions are handled separately on the incidents page.">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <FormField label="Base monthly salary LYD" required>
                <input
                  name="base_monthly_salary_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={currentProfile?.base_monthly_salary_lyd ?? defaults.base_monthly_salary_lyd ?? defaults.base_salary_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Pay per route LYD" required>
                <input
                  name="pay_per_route_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={currentProfile?.pay_per_route_lyd ?? defaults.pay_per_route_lyd ?? defaults.default_route_base_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Pay per stop LYD" required>
                <input
                  name="pay_per_stop_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={currentProfile?.pay_per_stop_lyd ?? defaults.pay_per_stop_lyd ?? defaults.default_stop_rate_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Pay per km LYD" required>
                <input
                  name="pay_per_km_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={currentProfile?.pay_per_km_lyd ?? defaults.pay_per_km_lyd ?? defaults.default_km_rate_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
              <FormField label="Fuel allowance per km LYD">
                <input
                  name="fuel_allowance_per_km_lyd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={currentProfile?.fuel_allowance_per_km_lyd ?? defaults.fuel_allowance_per_km_lyd ?? 0}
                  className="field-input"
                />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Active profile" description="Use the toggle for the live profile. Effective since stays available as a quiet advanced field so historical payroll stays stable.">
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="Active profile" required>
                <select name="is_active" defaultValue={String(currentProfile?.is_active ?? true)} className="field-input">
                  <option value="true">ON</option>
                  <option value="false">OFF</option>
                </select>
              </FormField>
              <FormField label="Effective since" required hint="Defaults to today for the first profile. Set a later date to replace the current version cleanly.">
                <input name="active_from" type="date" defaultValue={currentProfile?.active_from ?? today} className="field-input" />
              </FormField>
              <FormField label="Active until" hint="Usually leave this empty while the profile is active.">
                <input name="active_to" type="date" defaultValue={currentProfile?.active_to ?? ""} className="field-input" />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Notes" description="Use notes for contract context or reminders. This does not affect payroll math.">
            <FormField label="Notes">
              <textarea
                name="notes"
                rows={4}
                defaultValue={currentProfile?.notes ?? defaults.notes ?? ""}
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

        <FormSection title="Profile history" description="Older versions stay visible so past payroll can be audited against the rates that were active at the time.">
          {!payProfiles.length ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">No pay profile history yet.</div>
          ) : (
            <DataTable headers={["Effective window", "Status", "Base salary", "Route / Stop / KM", "Fuel allowance"]}>
              {payProfiles.map((row) => (
                <tr key={row.id}>
                  <td>{row.active_from ?? "-"}{row.active_to ? ` to ${row.active_to}` : " to now"}</td>
                  <td><StatusBadge status={row.is_active ? "active" : "inactive"} /></td>
                  <td>{moneyLabel(row.base_monthly_salary_lyd ?? 0)}</td>
                  <td>{`${moneyLabel(row.pay_per_route_lyd ?? 0)} / ${moneyLabel(row.pay_per_stop_lyd ?? 0)} / ${moneyLabel(row.pay_per_km_lyd ?? 0)}`}</td>
                  <td>{moneyLabel(row.fuel_allowance_per_km_lyd ?? 0)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </FormSection>
      </FormPageLayout>
    </>
  );
}
