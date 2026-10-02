import { LocalDraftForm } from "@/components/LocalDraft";
import { CashRemovalBoxPlanner } from "@/components/CashRemovalBoxPlanner";
import { FormField, FormSection, PrimaryButton, SecondaryButton } from "@/components/ui";

type MachineOption = {
  id: string;
  label: string;
};

export function CashRemovalForm({
  action,
  machines,
  selectedMachineId,
  clientSubmissionId,
  cancelHref,
}: {
  action: (formData: FormData) => void | Promise<void>;
  machines: MachineOption[];
  selectedMachineId?: string;
  clientSubmissionId: string;
  cancelHref: string;
}) {
  const libyaNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);

  return (
    <LocalDraftForm action={action} formType="cash-removal" draftKeyParts={[clientSubmissionId]} className="space-y-5">
      <input type="hidden" name="client_submission_id" value={clientSubmissionId} />

      <FormSection
        title="Cash removed from machines"
        description="Record each machine amount now, then group machines by the physical cash box or sealed bag that actually contains the money. This record is not connected to a route."
      >
        <div className="space-y-5">
          <CashRemovalBoxPlanner machines={machines} selectedMachineId={selectedMachineId} />

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Actual removal date and time" required>
              <input name="removed_at" type="datetime-local" required defaultValue={libyaNow} className="field-input" />
            </FormField>

            <FormField label="Removal type" required hint="Choose partial only when cash was intentionally left inside a selected machine.">
              <select name="removal_type" required defaultValue="full" className="field-input">
                <option value="full">Full — selected machine cash boxes emptied</option>
                <option value="partial">Partial — cash remains in one or more selected machines</option>
              </select>
            </FormField>

            <FormField label="Cash compartments emptied" required hint="Select every compartment opened during this collection. Use partial removal if anything remains.">
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  ["notes", "Banknotes box"],
                  ["coins", "Coins box"],
                  ["recycler", "Note recycler"],
                  ["change_float", "Change float"],
                ].map(([value, label]) => (
                  <label key={value} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800">
                    <input type="checkbox" name="compartments" value={value} />
                    {label}
                  </label>
                ))}
              </div>
            </FormField>

            <FormField label="Removal / exception notes" hint="Required for partial removal. State what remained and why.">
              <textarea name="notes" rows={3} className="field-input" placeholder="Handover details, cash left behind, or anything unusual." />
            </FormField>
          </div>
        </div>
      </FormSection>

      <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
        <PrimaryButton>Record cash removal</PrimaryButton>
        <SecondaryButton href={cancelHref}>Cancel</SecondaryButton>
      </div>
    </LocalDraftForm>
  );
}
