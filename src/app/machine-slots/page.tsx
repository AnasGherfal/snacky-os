import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, FormField, PageHeader, PrimaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function saveSlot(fd: FormData) {
  "use server";
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  const id = String(fd.get("id") || "");
  const payload = {
    machine_id: String(fd.get("machine_id") || ""),
    slot_code: String(fd.get("slot_code") || "").trim().toUpperCase(),
    product_id: String(fd.get("product_id") || ""),
    capacity: Number(fd.get("capacity") || 0),
    min_qty: Number(fd.get("min_qty") || 0),
    par_qty: Number(fd.get("par_qty") || 0),
    active: String(fd.get("active") || "true") === "true",
  };

  if (!payload.machine_id || !payload.slot_code || !payload.product_id || payload.capacity <= 0 || payload.par_qty <= 0) return;

  if (id) {
    await supabase.from("machine_slots").update(payload).eq("id", id);
  } else {
    await supabase.from("machine_slots").insert(payload);
  }

  revalidatePath("/machine-slots");
  redirect("/machine-slots");
}

export default async function MachineSlotsPage() {
  const supabase = getSupabaseServerClient();
  const [{ data: slots }, { data: machines }, { data: products }] = supabase
    ? await Promise.all([
        supabase
          .from("machine_slots")
          .select("id, slot_code, capacity, min_qty, par_qty, active, machine_id, product_id, machine:machines(id, name, machine_code), product:products(id, name, sku)")
          .order("machine_id")
          .order("slot_code"),
        supabase.from("machines").select("id, name, machine_code").order("name"),
        supabase.from("products").select("id, name, sku").eq("active", true).order("name"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const slotRows = (slots ?? []) as any[];
  const machineRows = (machines ?? []) as any[];
  const productRows = (products ?? []) as any[];
  const activeSlots = slotRows.filter((slot) => slot.active).length;
  const machineCount = new Set(slotRows.map((slot) => slot.machine_id)).size;
  const incompleteSlots = slotRows.filter((slot) => Number(slot.min_qty ?? 0) > Number(slot.par_qty ?? 0) || Number(slot.par_qty ?? 0) > Number(slot.capacity ?? 0)).length;

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          title="Machine Slots"
          subtitle="Define each machine planogram: slot, assigned product, capacity, minimum quantity, and par quantity."
        />

        {!supabase ? (
          <EmptyState title="Connect Supabase to manage machine slots" body="Add environment variables and restart the app." />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <SectionCard>
                <div className="text-sm text-slate-500">Active slots</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{activeSlots}</div>
              </SectionCard>
              <SectionCard>
                <div className="text-sm text-slate-500">Machines planned</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{machineCount}</div>
              </SectionCard>
              <SectionCard>
                <div className="text-sm text-slate-500">Rules needing review</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{incompleteSlots}</div>
              </SectionCard>
            </div>

            <SectionCard>
              <div className="mb-5">
                <h2 className="text-base font-semibold text-slate-900">Add slot</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Start with the machine, enter the physical slot code, then set capacity, minimum, and par. Refill recommendations use these values.
                </p>
              </div>
              <form action={saveSlot} className="grid gap-4 lg:grid-cols-6">
                <FormField label="Machine" required>
                  <select name="machine_id" required className="field-input">
                    <option value="">Select machine</option>
                    {machineRows.map((machine: any) => (
                      <option key={machine.id} value={machine.id}>
                        {machine.name} ({machine.machine_code})
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Slot code" required hint="Example: A1, B3">
                  <input required name="slot_code" placeholder="A1" className="field-input uppercase" />
                </FormField>
                <FormField label="Product" required>
                  <select name="product_id" required className="field-input">
                    <option value="">Select product</option>
                    {productRows.map((product: any) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Capacity" required>
                  <input required type="number" min="1" name="capacity" placeholder="10" className="field-input" />
                </FormField>
                <FormField label="Min" required hint="Trigger point">
                  <input required type="number" min="0" name="min_qty" placeholder="2" className="field-input" />
                </FormField>
                <FormField label="Par" required hint="Target fill">
                  <input required type="number" min="1" name="par_qty" placeholder="8" className="field-input" />
                </FormField>
                <div className="lg:col-span-6">
                  <PrimaryButton>Add slot</PrimaryButton>
                </div>
              </form>
            </SectionCard>

            <SectionCard>
              <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Planogram slots</h2>
                  <p className="mt-1 text-sm text-slate-500">Update one row at a time. Par must not exceed capacity.</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Recommendation rule: VMS stock below par creates a refill need.
                </div>
              </div>

              {!slotRows.length ? (
                <EmptyState title="No machine slots yet" body="Add slots so the system can compare VMS stock against par levels and generate refill recommendations." />
              ) : (
                <div className="space-y-3">
                  <DataTable headers={["Machine", "Slot", "Product", "Capacity", "Min", "Par", "Status", "Save"]}>
                    {slotRows.map((slot: any) => {
                      const needsReview = Number(slot.min_qty ?? 0) > Number(slot.par_qty ?? 0) || Number(slot.par_qty ?? 0) > Number(slot.capacity ?? 0);

                      return (
                        <tr key={slot.id} className={needsReview ? "bg-amber-50/70" : undefined}>
                          <td className="min-w-56">
                            <form id={`slot-${slot.id}`} action={saveSlot} />
                            <input form={`slot-${slot.id}`} type="hidden" name="id" value={slot.id} />
                            <select form={`slot-${slot.id}`} name="machine_id" defaultValue={slot.machine_id} className="field-input">
                              {machineRows.map((machine: any) => (
                                <option key={machine.id} value={machine.id}>
                                  {machine.name} ({machine.machine_code})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="min-w-28">
                            <input form={`slot-${slot.id}`} name="slot_code" defaultValue={slot.slot_code} className="field-input uppercase" />
                          </td>
                          <td className="min-w-56">
                            <select form={`slot-${slot.id}`} name="product_id" defaultValue={slot.product_id} className="field-input">
                              {productRows.map((product: any) => (
                                <option key={product.id} value={product.id}>
                                  {product.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="min-w-24">
                            <input form={`slot-${slot.id}`} type="number" min="1" name="capacity" defaultValue={slot.capacity} className="field-input" />
                          </td>
                          <td className="min-w-24">
                            <input form={`slot-${slot.id}`} type="number" min="0" name="min_qty" defaultValue={slot.min_qty} className="field-input" />
                          </td>
                          <td className="min-w-24">
                            <input form={`slot-${slot.id}`} type="number" min="1" name="par_qty" defaultValue={slot.par_qty} className="field-input" />
                          </td>
                          <td>
                            <select form={`slot-${slot.id}`} name="active" defaultValue={String(slot.active)} className="field-input min-w-28">
                              <option value="true">Active</option>
                              <option value="false">Archived</option>
                            </select>
                            {needsReview ? <div className="mt-2"><StatusBadge status="needs_review" /></div> : null}
                          </td>
                          <td>
                            <button form={`slot-${slot.id}`} className="btn-primary">
                              Save
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </DataTable>
                </div>
              )}
            </SectionCard>
          </>
        )}
      </div>
    </AppShell>
  );
}
