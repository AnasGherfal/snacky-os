import { FormField, FormSection, SecondaryButton, StatusBadge } from "@/components/ui";
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
  };
};

export function TeamMemberForm({ action, submitLabel, backHref = "/team", member }: TeamMemberFormProps) {
  return (
    <form action={action} className="space-y-6">
      {member ? <input type="hidden" name="id" value={member.id} /> : null}

      <FormSection title="Team member">
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
          <FormField label="Status">
            <select name="active" defaultValue={String(member?.active ?? true)} className="field-input">
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Role and access">
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

      <div className="flex flex-col gap-3 sm:flex-row">
        <button className="btn-primary">{submitLabel}</button>
        <SecondaryButton href={backHref}>Cancel</SecondaryButton>
      </div>
    </form>
  );
}
