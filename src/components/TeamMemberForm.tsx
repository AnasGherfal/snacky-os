import { FormField, FormSection, SecondaryButton, StatusBadge } from "@/components/ui";
import { TemporaryPasswordInput } from "@/components/TemporaryPasswordInput";
import { appRoles, AppRole } from "@/lib/authz";
import { roleDescriptions } from "@/lib/team";

type TeamMemberFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  backHref?: string;
  member?: {
    id: string; full_name: string; email: string | null; phone: string | null;
    role: AppRole; roles?: AppRole[] | null; can_add_products?: boolean | null;
    active: boolean; auth_user_id?: string | null; must_change_password?: boolean;
  };
};

export function TeamMemberForm({ action, submitLabel, backHref = "/team", member }: TeamMemberFormProps) {
  const selectedRoles = new Set(member?.roles?.length ? member.roles : [member?.role ?? "operator"]);
  // Access always starts from the saved server record. A browser draft must not
  // restore removed permissions, and the previous primary role is not submitted.
  return (
    <form action={action} className="space-y-6">
      {member ? <input type="hidden" name="id" value={member.id} /> : null}
      <FormSection title="Team member" description="Identity and contact details used for assignments and activity history.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Full name" required><input name="full_name" defaultValue={member?.full_name ?? ""} required className="field-input" autoComplete="name" /></FormField>
          <FormField label="Email" hint="Login access is linked by account ID, not by name."><input name="email" type="email" defaultValue={member?.email ?? ""} className="field-input" autoComplete="email" /></FormField>
          <FormField label="Phone"><input name="phone" defaultValue={member?.phone ?? ""} className="field-input" autoComplete="tel" /></FormField>
          <FormField label="Status" hint="Use the separate Deactivate action below to remove login access.">
            <input type="hidden" name="active" value={String(member?.active ?? true)} />
            <input value={(member?.active ?? true) ? "Active" : "Inactive"} readOnly className="field-input bg-slate-50" />
          </FormField>
        </div>
      </FormSection>
      <FormSection title="Roles and access" description="Selected roles replace the old roles. Uncheck any access this person no longer needs.">
        <p className="mb-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
          For investor-only access, select Investor and uncheck all other roles. The investor can read their own agreement, contributions, approved monthly statements, and payouts; they cannot edit operations or Finance.
          <span className="mt-2 block" dir="rtl">لدخول المستثمر فقط، اختر «مستثمر» وألغِ بقية الأدوار. لا تمنحه دور مشغّل أو صلاحيات مالية.</span>
        </p>
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {appRoles.map((role) => <label key={role} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
              <input name="roles" type="checkbox" value={role} defaultChecked={selectedRoles.has(role)} className="mt-1" />
              <span><span className="mb-2 block"><StatusBadge status={role} /></span><span className="block text-xs leading-5 text-slate-600">{roleDescriptions[role]}</span></span>
            </label>)}
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <input name="can_add_products" type="checkbox" value="yes" defaultChecked={Boolean(member?.can_add_products)} className="mt-1" />
            <span><span className="block font-semibold">Allow creating products</span>Additional product permission for staff. This is always disabled for an investor-only account.</span>
          </label>
        </div>
      </FormSection>
      <FormSection title={member?.auth_user_id ? "Login access" : "Create login access"} description="Changing roles does not require resetting a password.">
        {member?.auth_user_id ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          This member already has a login. Use a temporary password only for an intentional password reset.
          {member.must_change_password ? <div className="mt-2 font-semibold">Password change is currently required.</div> : null}
        </div> : <p className="text-sm text-slate-500">Create login access for members who need to sign in.</p>}
        <TemporaryPasswordInput />
      </FormSection>
      <div className="flex flex-col gap-3 sm:flex-row"><button className="btn-primary">{submitLabel}</button><SecondaryButton href={backHref}>Cancel</SecondaryButton></div>
    </form>
  );
}
