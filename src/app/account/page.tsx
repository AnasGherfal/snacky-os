import { redirect } from "next/navigation";
import { FormField, FormSection, PageHeader, SectionCard, StatusBadge } from "@/components/ui";
import { changeOwnPassword, logoutFromAccount } from "@/lib/account-actions";
import { getCurrentProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  const { error, success } = await searchParams;

  return (
    <>
      <PageHeader title="Account" subtitle="View your Snacky OS profile, change your password, or log out." />

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <SectionCard>
          <div className="space-y-4 p-4">
            <h2 className="text-base font-semibold text-slate-900">Profile</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs text-slate-500">Name</div>
                <div className="mt-1 font-medium text-slate-900">{profile.full_name}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs text-slate-500">Email</div>
                <div className="mt-1 font-medium text-slate-900">{profile.email ?? "-"}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs text-slate-500">Role</div>
                <div className="mt-2"><StatusBadge status={profile.role} /></div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs text-slate-500">Status</div>
                <div className="mt-2"><StatusBadge status={profile.active_status} /></div>
              </div>
            </div>
            {profile.must_change_password ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
                You are using a temporary password. Change it before continuing regular operations.
              </div>
            ) : null}
          </div>
        </SectionCard>

        <div className="space-y-6">
          <FormSection title="Change password">
            {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
            {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">{success}</div> : null}
            <form action={changeOwnPassword} className="space-y-4">
              <FormField label="New password" required hint="Use at least 10 characters.">
                <input name="password" type="password" required minLength={10} className="field-input" autoComplete="new-password" />
              </FormField>
              <FormField label="Confirm new password" required>
                <input name="confirm_password" type="password" required minLength={10} className="field-input" autoComplete="new-password" />
              </FormField>
              <button className="btn-primary w-full">Change password</button>
            </form>
          </FormSection>

          <SectionCard>
            <form action={logoutFromAccount} className="space-y-3 p-4">
              <h2 className="text-base font-semibold text-slate-900">Session</h2>
              <p className="text-sm text-slate-500">Log out of this browser session.</p>
              <button className="btn-secondary w-full">Log out</button>
            </form>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
