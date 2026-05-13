import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/AppShell";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { parseMachineSlotForm, validateMachineSlot } from "@/lib/machine-slots";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function updateSlot(fd: FormData) {
  "use server";
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  const id = String(fd.get("id") || "");
  const payload = parseMachineSlotForm(fd);
  const error = validateMachineSlot(payload);
  if (error) redirect(`/machine-slots/${id}/edit?error=${encodeURIComponent(error)}`);

  const { error: updateError } = await supabase.from("machine_slots").update(payload).eq("id", id);
  if (updateError) {
    console.error("[machine-slots:update] Failed to update slot", { id, payload, error: updateError });
    redirect(`/machine-slots/${id}/edit?error=${encodeURIComponent(updateError.message)}`);
  }

  revalidatePath("/machine-slots");
  redirect(`/machine-slots?machine_id=${payload.machine_id}`);
}

export default async function EditMachineSlotPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: slot }, { data: machines }, { data: products }] = await Promise.all([
    supabase.from("machine_slots").select("*").eq("id", id).single(),
    supabase.from("machines").select("id, name, machine_code").order("name"),
    supabase.from("products").select("id, name, sku").eq("active", true).order("name"),
  ]);

  if (!slot) notFound();

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Edit Slot" subtitle="Update the product assignment and refill rules for this machine slot." action={<SecondaryButton href={`/machine-slots?machine_id=${slot.machine_id}`}>Back to planogram</SecondaryButton>} />
        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}
        <form action={updateSlot} className="space-y-5">
          <input type="hidden" name="id" value={id} />
          <FormSection title="Slot details">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Machine" required hint="Choose the machine this slot belongs to.">
                <select name="machine_id" defaultValue={slot.machine_id} required className="field-input">
                  {machines?.map((machine: any) => (
                    <option key={machine.id} value={machine.id}>{machine.name} ({machine.machine_code})</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Slot Code" required hint="Physical slot/tray code, e.g. A1, B3, R2-C5.">
                <input name="slot_code" required defaultValue={slot.slot_code} className="field-input uppercase" />
              </FormField>
              <FormField label="Product" required hint="Product assigned to this slot.">
                <select name="product_id" defaultValue={slot.product_id} required className="field-input">
                  {products?.map((product: any) => (
                    <option key={product.id} value={product.id}>{product.name}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Status">
                <select name="active" defaultValue={String(slot.active)} className="field-input">
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </FormField>
              <FormField label="Capacity" required hint="Maximum units the slot can hold.">
                <input type="number" min="1" name="capacity" required defaultValue={slot.capacity} className="field-input" />
              </FormField>
              <FormField label="Minimum Quantity" required hint="Refill should be considered at or below this quantity.">
                <input type="number" min="0" name="min_qty" required defaultValue={slot.min_qty} className="field-input" />
              </FormField>
              <FormField label="Par Quantity" required hint="Target quantity after refill.">
                <input type="number" min="1" name="par_qty" required defaultValue={slot.par_qty} className="field-input" />
              </FormField>
            </div>
          </FormSection>
          <div className="flex gap-3">
            <PrimaryButton>Save Slot</PrimaryButton>
            <SecondaryButton href={`/machine-slots?machine_id=${slot.machine_id}`}>Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </AppShell>
  );
}
