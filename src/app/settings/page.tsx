import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { EmptyState, FormField, FormSection, PageHeader, SectionCard, StatusBadge } from "@/components/ui";
import { accessTokenCookie, getCurrentProfile, refreshTokenCookie } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";

async function logout() {
  "use server";

  const cookieStore = await cookies();
  cookieStore.delete(accessTokenCookie);
  cookieStore.delete(refreshTokenCookie);
  redirect("/login");
}

export default async function SettingsPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  return (
    <>
      <PageHeader title="Settings" subtitle="Company defaults, language preference, and account controls." />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <FormSection title="Company settings">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Company name">
                <input className="field-input" value="Snacky" readOnly />
              </FormField>
              <FormField label="Operating country">
                <input className="field-input" value="Libya" readOnly />
              </FormField>
              <FormField label="Default currency">
                <input className="field-input" value="LYD" readOnly />
              </FormField>
              <FormField label="Business timezone">
                <input className="field-input" value="Africa/Tripoli" readOnly />
              </FormField>
            </div>
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
              Company defaults are read-only during this phase so operational screens stay stable.
            </div>
          </FormSection>

          <FormSection title="Language">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Interface language">
                <select className="field-input" defaultValue="en">
                  <option value="en">English</option>
                  <option value="ar">Arabic</option>
                </select>
              </FormField>
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
                The active language can also be changed from the top bar. This setting keeps the preference visible in the admin settings area.
              </div>
            </div>
          </FormSection>

          <EmptyState
            title="Editable settings are not enabled yet"
            body="The next step is to store company defaults in Supabase with audited changes. For now, these values document the operating assumptions used across Snacky OS."
          />
        </div>

        <SectionCard>
          <div className="space-y-4 p-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Account</h2>
              <p className="mt-1 text-sm text-slate-500">Signed in as the current Snacky OS user.</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-sm font-medium text-slate-900">{profile?.full_name ?? "Unknown user"}</div>
              <div className="mt-1 text-sm text-slate-500">{profile?.email ?? "No email on profile"}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <StatusBadge status={profile?.role ?? "unknown"} />
                <StatusBadge status={profile?.active_status ?? "unknown"} />
              </div>
            </div>
            <form action={logout}>
              <button className="btn-primary w-full" type="submit">Logout</button>
            </form>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
