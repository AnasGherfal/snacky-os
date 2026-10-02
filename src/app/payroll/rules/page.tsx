import { redirect } from "next/navigation";
import { ErrorState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { updateRoutePayRules } from "@/lib/payroll-actions";
import { ensureRoutePayRules } from "@/lib/payroll";
import { getPayrollServerClient } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

export default async function RoutePayRulesPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Route pay rules unavailable" body="Supabase is not configured, so Snacky OS cannot load payroll rule settings." />
      </>
    );
  }

  const rules = await ensureRoutePayRules(supabase as any);

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Route Pay Rules"
          subtitle="Fixed rule set for distance zones and route or stop extras. Keep this simple until map-based distance is introduced."
          breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Route pay rules" }]}
          action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
        />

        {params.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
        {params.saved ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Route pay rules saved.</div> : null}

        <form action={updateRoutePayRules} className="space-y-6">
          <FormSection title="Distance pay" description="Snacky currently pays route distance by fixed zones. The km-rate value is still saved per operator profile so the engine can switch later without redoing master data.">
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="Distance pay mode" required>
                <select name="distance_pay_mode" defaultValue={rules.distance_pay_mode ?? "zone"} className="field-input">
                  <option value="zone">Zone based</option>
                  <option value="km_rate">KM rate</option>
                </select>
              </FormField>
              <FormField label="0-10 km LYD" required>
                <input name="zone_0_10_lyd" type="number" min="0" step="0.01" defaultValue={rules.zone_0_10_lyd ?? 0} className="field-input" />
              </FormField>
              <FormField label="11-20 km LYD" required>
                <input name="zone_11_20_lyd" type="number" min="0" step="0.01" defaultValue={rules.zone_11_20_lyd ?? 10} className="field-input" />
              </FormField>
              <FormField label="21-35 km LYD" required>
                <input name="zone_21_35_lyd" type="number" min="0" step="0.01" defaultValue={rules.zone_21_35_lyd ?? 20} className="field-input" />
              </FormField>
              <FormField label="36-50 km LYD" required>
                <input name="zone_36_50_lyd" type="number" min="0" step="0.01" defaultValue={rules.zone_36_50_lyd ?? 35} className="field-input" />
              </FormField>
              <FormField label="51-70 km LYD" required>
                <input name="zone_51_70_lyd" type="number" min="0" step="0.01" defaultValue={rules.zone_51_70_lyd ?? 50} className="field-input" />
              </FormField>
              <FormField label="70+ km LYD" hint="Leave empty if the route needs manual approval instead of an automatic amount.">
                <input name="zone_70_plus_lyd" type="number" min="0" step="0.01" defaultValue={rules.zone_70_plus_lyd ?? ""} className="field-input" />
              </FormField>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 md:col-span-2">
                <input name="zone_over_70_requires_approval" type="checkbox" value="yes" defaultChecked={Boolean(rules.zone_over_70_requires_approval ?? true)} className="mt-1" />
                <span>
                  <span className="block font-semibold text-slate-900">70+ km requires manager approval</span>
                  <span className="text-sm text-slate-500">Keep this on if long-distance routes should only become verified after owner/admin review.</span>
                </span>
              </label>
            </div>
          </FormSection>

          <FormSection title="Default extras" description="These are the default values the route pay detail page uses when admins add manual route or stop extras.">
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="Cash collection extra LYD" required>
                <input name="cash_collection_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.cash_collection_extra_lyd ?? 20} className="field-input" />
              </FormField>
              <FormField label="Deep cleaning extra LYD" required>
                <input name="deep_cleaning_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.deep_cleaning_extra_lyd ?? 0} className="field-input" />
              </FormField>
              <FormField label="Simple fix extra LYD" required>
                <input name="simple_fix_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.simple_fix_extra_lyd ?? 0} className="field-input" />
              </FormField>
              <FormField label="Emergency extra LYD" required>
                <input name="emergency_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.emergency_extra_lyd ?? 40} className="field-input" />
              </FormField>
              <FormField label="Friday / holiday extra LYD" required>
                <input name="friday_holiday_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.friday_holiday_extra_lyd ?? 0} className="field-input" />
              </FormField>
              <FormField label="Buying trip extra LYD" required>
                <input name="buying_trip_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.buying_trip_extra_lyd ?? 90} className="field-input" />
              </FormField>
              <FormField label="Heavy load extra LYD" required>
                <input name="heavy_load_extra_lyd" type="number" min="0" step="0.01" defaultValue={rules.heavy_load_extra_lyd ?? 0} className="field-input" />
              </FormField>
              <div className="md:col-span-2">
                <FormField label="Notes">
                  <textarea name="notes" rows={4} defaultValue={rules.notes ?? ""} className="field-input" placeholder="Optional payroll rule note for the Snacky team." />
                </FormField>
              </div>
            </div>
          </FormSection>

          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Save route pay rules</PrimaryButton>
            <SecondaryButton href="/payroll">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </>
  );
}
