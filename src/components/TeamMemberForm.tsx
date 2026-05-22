import { FormField, FormSection, SecondaryButton, StatusBadge } from "@/components/ui";
import { TemporaryPasswordInput } from "@/components/TemporaryPasswordInput";
import { appRoles, AppRole } from "@/lib/authz";
import { roleDescriptions } from "@/lib/team";

type TeamMemberFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  backHref?: string;
  member?: {
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    role: AppRole;
    roles?: AppRole[] | null;
    can_add_products?: boolean | null;
    active: boolean;
    auth_user_id?: string | null;
    must_change_password?: boolean;
  };
};

export function TeamMemberForm({ action, submitLabel, backHref = "/team", member }: TeamMemberFormProps) {
  const selectedRoles = new Set(member?.roles?.length ? member.roles : [member?.role ?? "operator"]);

  return (
    <form action={action} className="space-y-6">
      {member ? <input type="hidden" name="id" value={member.id} /> : null}

      <FormSection title="Team member" description="Keep identity and contact details clean so assignments, logs, and route work can be traced to the right person.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Full name" required>
            <input name="full_name" defaultValue={member?.full_name ?? ""} required className="field-input" autoComplete="name" />
          </FormField>
          <FormField label="Email" hint="Use the same email as the Supabase Auth account to link login access.">
            <input name="email" type="email" defaultValue={member?.email ?? ""} className="field-input" autoComplete="email" />
          </FormField>
          <FormField label="Phone">
            <input name="phone" defaultValue={member?.phone ?? ""} className="field-input" autoComplete="tel" />
          </FormField>
          <FormField label="Status" hint="Use the safe deactivate action from the activity page to disable login access.">
            <input type="hidden" name="active" value={String(member?.active ?? true)} />
            <input value={(member?.active ?? true) ? "Active" : "Inactive"} readOnly className="field-input bg-slate-50" />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Roles and access" description="Assign every job this person performs. Permissions combine across selected roles.">
        <input type="hidden" name="role" value={member?.role ?? "operator"} />
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {appRoles.map((role) => (
              <label key={role} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
                <input name="roles" type="checkbox" value={role} defaultChecked={selectedRoles.has(role)} className="mt-1" />
                <span>
                  <span className="mb-2 block"><StatusBadge status={role} /></span>
                  <span className="block text-xs leading-5 text-slate-600">{roleDescriptions[role]}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <input name="can_add_products" type="checkbox" value="yes" defaultChecked={Boolean(member?.can_add_products)} className="mt-1" />
            <span>
              <span className="block font-semibold">can_add_products</span>
              Allow this user to create products from purchase or inventory screens. Operators do not get this by default.
            </span>
          </label>
        </div>
      </FormSection>

      <FormSection title={member?.auth_user_id ? "Login access" : "Create login access"} description="Use temporary passwords only for account setup or reset; activity history remains attached to this team member.">
        {member?.auth_user_id ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            This team member is linked to a Supabase Auth login. Generate a new temporary password here only when resetting access.
            {member.must_change_password ? <div className="mt-2 font-semibold">Password change is currently required.</div> : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">For operators and team members who need to sign in, create Supabase Auth login access now.</p>
        )}
        <TemporaryPasswordInput />
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button className="btn-primary">{submitLabel}</button>
        <SecondaryButton href={backHref}>Cancel</SecondaryButton>
      </div>
    </form>
  );
}
