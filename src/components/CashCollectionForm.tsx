import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormSection, PrimaryButton, SecondaryButton } from "@/components/ui";

type Option = {
  id: string;
  label: string;
  helper?: string | null;
};

type CashCollectionInitial = {
  id?: string;
  machineId?: string | null;
  routeId?: string | null;
  operatorId?: string | null;
  collectedAt?: string | null;
  expectedCash?: number | null;
  countedAmount?: number | null;
  cashBagId?: string | null;
  notes?: string | null;
};

function dateValue(value: string | null | undefined) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function amountValue(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

export function CashCollectionForm({
  action,
  machines,
  routes,
  operators,
  initial,
  submitLabel,
  countedRequired = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  machines: Option[];
  routes: Option[];
  operators: Option[];
  initial?: CashCollectionInitial;
  submitLabel: string;
  countedRequired?: boolean;
}) {
  return (
    <LocalDraftForm action={action} formType="cash-collection" draftKeyParts={[initial?.id ?? "new"]} className="space-y-5">
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      <FormSection
        title="Collection Details"
        description="Record only the physical cash removed and counted. Expected cash is reconciled for the full machine month in Finance Operations, not for each pickup."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Machine" required>
            <select name="machine_id" required defaultValue={initial?.machineId ?? ""} className="field-input">
              <option value="">Select machine</option>
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Date cash was removed" required>
            <input name="collected_at" type="date" required defaultValue={dateValue(initial?.collectedAt)} className="field-input" />
          </FormField>

          <FormField label="Operator">
            <select name="operator_id" defaultValue={initial?.operatorId ?? ""} className="field-input">
              <option value="">No operator linked</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Route">
            <select name="route_id" defaultValue={initial?.routeId ?? ""} className="field-input">
              <option value="">No route linked</option>
              {routes.map((route) => (
                <option key={route.id} value={route.id}>
                  {route.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label="Counted amount LYD"
            required={countedRequired}
            hint="Enter the amount physically counted from this pickup. Several pickups from the same machine are added together for the monthly close."
          >
            <input name="counted_amount_lyd" type="number" step="0.01" min="0" required={countedRequired} defaultValue={amountValue(initial?.countedAmount)} className="field-input" />
          </FormField>

          <FormField label="Cash bag / envelope ID">
            <input name="cash_bag_id" defaultValue={initial?.cashBagId ?? ""} className="field-input" placeholder="Envelope ID optional" />
          </FormField>

          <div className="md:col-span-2 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
            <div className="font-semibold">Monthly reconciliation</div>
            <p className="mt-1">
              Mid-month pickups do not have their own expected amount. At month-end, remove and count the remaining machine cash, then Finance Operations compares the sum of every pickup in that month with the month&apos;s VMS cash sales.
            </p>
          </div>

          <div className="md:col-span-2">
            <FormField label="Notes">
              <textarea name="notes" rows={4} defaultValue={initial?.notes ?? ""} className="field-input" placeholder="Count notes, envelope handoff, float retained in the machine, or source." />
            </FormField>
          </div>
        </div>
      </FormSection>

      <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
        <PrimaryButton>{submitLabel}</PrimaryButton>
        <SecondaryButton href={initial?.id ? `/cash-collections/${initial.id}` : "/cash-collections"}>Cancel</SecondaryButton>
      </div>
    </LocalDraftForm>
  );
}
