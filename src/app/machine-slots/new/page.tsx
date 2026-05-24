import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { parseMachineSlotForm, validateMachineSlot } from "@/lib/machine-slots";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function createSlot(fd: FormData) {
  "use server";
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/machine-slots/new?error=Supabase%20is%20not%20configured.");
  const profile = await getCurrentProfile();

  const payload = parseMachineSlotForm(fd);
  const error = validateMachineSlot(payload);
  if (error) redirect(`/machine-slots/new?error=${encodeURIComponent(error)}&machine_id=${encodeURIComponent(payload.machine_id)}`);

  const { data: slot, error: insertError } = await supabase.from("machine_slots").insert(payload).select("id, machine_id, product_id, slot_code, capacity, min_qty, par_qty, active").single();
  if (insertError) {
    console.error("[machine-slots:create] Failed to insert slot", { payload, error: insertError });
    redirect(`/machine-slots/new?error=${encodeURIComponent(insertError.message)}&machine_id=${encodeURIComponent(payload.machine_id)}`);
  }

  if (slot) {
    await logActivity({
      profile,
      action: "create",
      entityType: "machine_planogram",
      entityId: slot.id,
      entityLabel: `Slot ${slot.slot_code}`,
      afterData: slot,
      metadata: { machine_id: slot.machine_id, product_id: slot.product_id },
      summary: `Created machine planogram slot ${slot.slot_code}`,
    });
  }

  revalidatePath("/machine-slots");
  redirect(`/machine-slots?machine_id=${payload.machine_id}`);
}

export default async function NewMachineSlotPage({ searchParams }: { searchParams: Promise<{ machine_id?: string; error?: string }> }) {
  const { machine_id = "", error } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: machines }, { data: products }] = supabase
    ? await Promise.all([
        supabase.from("machines").select("id, name, machine_code").order("name"),
        supabase.from("products").select("id, name, sku").eq("active", true).order("name"),
      ])
    : [{ data: [] }, { data: [] }];

  return (
    <>
      <FormPageLayout>
        <PageHeader title="Add Slot" subtitle="Add a physical vending machine slot to a machine planogram." action={<SecondaryButton href={machine_id ? `/machine-slots?machine_id=${machine_id}` : "/machine-slots"}>Back to planogram</SecondaryButton>} />
        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}
        <LocalDraftForm action={createSlot} formType="machine-slot" draftKeyParts={["new", machine_id || "no-machine"]} className="space-y-5">
          <FormSection title="Slot details">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Machine" required hint="Choose the machine this slot belongs to.">
                <select name="machine_id" defaultValue={machine_id} required className="field-input">
                  <option value="">Select machine</option>
                  {machines?.map((machine: any) => (
                    <option key={machine.id} value={machine.id}>{machine.name} ({machine.machine_code})</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Slot Code" required hint="Physical slot/tray code, e.g. A1, B3, R2-C5.">
                <input name="slot_code" required placeholder="A1" className="field-input uppercase" />
              </FormField>
              <FormField label="Product" required hint="Product assigned to this slot.">
                <select name="product_id" required className="field-input">
                  <option value="">Select product</option>
                  {products?.map((product: any) => (
                    <option key={product.id} value={product.id}>{product.name}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Status">
                <select name="active" defaultValue="true" className="field-input">
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </FormField>
              <FormField label="Capacity" required hint="Maximum units the slot can hold.">
                <input type="number" min="1" name="capacity" required placeholder="10" className="field-input" />
              </FormField>
              <FormField label="Minimum Quantity" required hint="Refill should be considered at or below this quantity.">
                <input type="number" min="0" name="min_qty" required placeholder="2" className="field-input" />
              </FormField>
              <FormField label="Par Quantity" required hint="Target quantity after refill.">
                <input type="number" min="1" name="par_qty" required placeholder="8" className="field-input" />
              </FormField>
            </div>
          </FormSection>
          <div className="flex gap-3">
            <PrimaryButton>Add Slot</PrimaryButton>
            <SecondaryButton href={machine_id ? `/machine-slots?machine_id=${machine_id}` : "/machine-slots"}>Cancel</SecondaryButton>
          </div>
        </LocalDraftForm>
      </FormPageLayout>
    </>
  );
}
