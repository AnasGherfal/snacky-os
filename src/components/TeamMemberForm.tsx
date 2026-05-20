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
    active: boolean;
    auth_user_id?: string | null;
    must_change_password?: boolean;
  };
};

export function TeamMemberForm({ action, submitLabel, backHref = "/team", member }: TeamMemberFormProps) {
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

      <FormSection title="Role and access" description="Roles control which modules are visible. Operators stay focused on assigned route execution.">
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <FormField label="Role" required>
            <select name="role" defaultValue={member?.role ?? "operator"} className="field-input">
              {appRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </FormField>
          <div className="grid gap-2 sm:grid-cols-2">
            {appRoles.map((role) => (
              <div key={role} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2">
                  <StatusBadge status={role} />
                </div>
                <p className="text-xs leading-5 text-slate-600">{roleDescriptions[role]}</p>
              </div>
            ))}
          </div>
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
