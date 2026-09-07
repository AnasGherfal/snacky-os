import { LocalDraftForm } from "@/components/LocalDraft";
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
        description="Record the physical removal now. The money is counted later as one batch, even when cash boxes are mixed. This record is not connected to a route."
      >
        <div className="space-y-5">
          <FormField label="Machines emptied" required hint="Select every machine whose cash is inside this bag or batch.">
            <div className="grid gap-2 sm:grid-cols-2">
              {machines.map((machine) => (
                <label key={machine.id} className="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    name="machine_ids"
                    value={machine.id}
                    defaultChecked={machine.id === selectedMachineId}
                    className="h-4 w-4"
                  />
                  <span>{machine.label}</span>
                </label>
              ))}
            </div>
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Actual removal date and time" required>
              <input name="removed_at" type="datetime-local" required defaultValue={libyaNow} className="field-input" />
            </FormField>

            <FormField label="Removal type" required hint="Choose partial only when cash was intentionally left inside the machine.">
              <select name="removal_type" required defaultValue="full" className="field-input">
                <option value="full">Full — cash box emptied</option>
                <option value="partial">Partial — cash remains in machine</option>
              </select>
            </FormField>

            <FormField label="Tamper-evident bag / seal ID" required hint="Write this exact unique ID on the physical bag. It cannot be reused.">
              <input name="cash_bag_id" required autoCapitalize="characters" className="field-input uppercase" placeholder="Example: CASH-2026-0906-01" />
            </FormField>

            <FormField label="Cash compartments emptied" required hint="Select every compartment opened. Use partial removal if anything remains.">
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

            <FormField label="Photo of sealed bag" required hint="Show the closed bag and readable seal ID before leaving the machine area.">
              <input name="evidence_file" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" required className="field-input" />
            </FormField>

            <FormField label="Removal / exception notes" hint="Required for partial removal. State what remained and why.">
              <textarea name="notes" rows={3} className="field-input" placeholder="Handover details, cash left behind, or anything unusual." />
            </FormField>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            <div className="font-semibold">No amount is entered here</div>
            <p className="mt-1">Saving creates a sealed “removed — handoff due” batch. A different person receives it into storage, finance counts one combined total, then reconciles and banks it.</p>
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
