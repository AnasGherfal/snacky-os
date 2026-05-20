import { PrimaryButton, SecondaryButton, FormField, FormSection } from "@/components/ui";
import { StorageLocationRow, storageLocationTypeHelpers, storageLocationTypeLabel, storageLocationTypes } from "@/lib/storage-locations";

type OperatorOption = {
  id: string;
  full_name: string;
  email: string | null;
  role: string;
};

export function StorageLocationForm({
  action,
  location,
  operators,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  location?: StorageLocationRow | null;
  operators: OperatorOption[];
  submitLabel: string;
}) {
  return (
    <form action={action} className="space-y-5">
      {location?.id ? <input type="hidden" name="id" value={location.id} /> : null}

      <FormSection title="Location Details" description="Name the physical or operational stock location and link an operator only when this is an operator bag.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Location name" required hint="Use a clear operational name like MAIN, Operator Bag - Ahmed, or Temporary Stock Count.">
            <input name="name" required defaultValue={location?.name ?? ""} className="field-input" placeholder="MAIN" />
          </FormField>

          <FormField label="Type" required>
            <select name="location_type" required defaultValue={location?.location_type ?? "main_storage"} className="field-input">
              {storageLocationTypes.map((type) => (
                <option key={type} value={type}>
                  {storageLocationTypeLabel(type)}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Related operator" hint="Required for operator bag locations. Leave empty for warehouses and internal locations.">
            <select name="related_operator_id" defaultValue={location?.related_operator_id ?? ""} className="field-input">
              <option value="">No related operator</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.full_name}{operator.email ? ` (${operator.email})` : ""}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Status" hint="Use the archive/deactivate control on the detail page to change availability.">
            <input type="hidden" name="active" value={String(location?.active ?? true)} />
            <input value={(location?.active ?? true) ? "Active" : "Archived"} readOnly className="field-input bg-slate-50" />
          </FormField>

          <div className="md:col-span-2">
            <FormField label="Address or notes" hint="Optional physical address, shelf label, vehicle plate, or operational note.">
              <textarea name="address" rows={4} defaultValue={location?.address ?? ""} className="field-input" placeholder="Warehouse address, shelf note, or route bag description" />
            </FormField>
          </div>
        </div>
      </FormSection>

      <section className="grid gap-3 md:grid-cols-3">
        {storageLocationTypeHelpers.map((helper) => (
          <div key={helper.title} className="surface-card rounded-lg p-4">
            <h3 className="text-sm font-semibold text-slate-900">{helper.title}</h3>
            <p className="mt-1 text-sm text-slate-500">{helper.body}</p>
          </div>
        ))}
      </section>

      <div className="flex flex-col gap-3 sm:flex-row">
        <PrimaryButton>{submitLabel}</PrimaryButton>
        <SecondaryButton href={location?.id ? `/storage-locations/${location.id}` : "/storage-locations"}>Cancel</SecondaryButton>
      </div>
    </form>
  );
}
