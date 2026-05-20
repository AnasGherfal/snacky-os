import Link from "next/link";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function MachinePlanogramsPage({ searchParams }: { searchParams: Promise<{ machine_id?: string }> }) {
  const { machine_id } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: machines }, { data: slots }] = supabase
    ? await Promise.all([
        supabase.from("machines").select("id, name, machine_code, status").order("name"),
        supabase
          .from("machine_slots")
          .select("id, slot_code, capacity, min_qty, par_qty, active, machine_id, product:products(id, name, sku)")
          .order("slot_code"),
      ])
    : [{ data: [] }, { data: [] }];

  const machineRows = (machines ?? []) as any[];
  const slotRows = (slots ?? []) as any[];
  const selectedMachineId = machine_id || machineRows[0]?.id || "";
  const selectedMachine = machineRows.find((machine) => machine.id === selectedMachineId);
  const selectedSlots = slotRows.filter((slot) => slot.machine_id === selectedMachineId);
  const machinesWithoutSlots = machineRows.filter((machine) => !slotRows.some((slot) => slot.machine_id === machine.id));

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Machine Planograms"
          subtitle="Optional Snacky slot rules for future planogram sync. Current refill recommendations come from imported VMS machine goods stock."
          action={<PrimaryButton href={selectedMachineId ? `/machine-slots/new?machine_id=${selectedMachineId}` : "/machine-slots/new"}>Add Slot</PrimaryButton>}
        />

        {!supabase ? (
          <EmptyState title="Connect Supabase to manage planograms" body="Add environment variables and restart the app." />
        ) : !machineRows.length ? (
          <EmptyState title="No machines available" body="Create machines before configuring their planograms." />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <SectionCard>
                <div className="text-sm font-medium text-slate-900">Capacity</div>
                <p className="mt-1 text-sm text-slate-500">Maximum units this slot can hold.</p>
              </SectionCard>
              <SectionCard>
                <div className="text-sm font-medium text-slate-900">Minimum Quantity</div>
                <p className="mt-1 text-sm text-slate-500">When the product reaches this level, it should be refilled.</p>
              </SectionCard>
              <SectionCard>
                <div className="text-sm font-medium text-slate-900">Par Quantity</div>
                <p className="mt-1 text-sm text-slate-500">Target quantity after refill.</p>
              </SectionCard>
            </div>

            <SectionCard>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Select machine</h2>
                  <p className="mt-1 text-sm text-slate-500">Planograms are managed machine by machine.</p>
                </div>
                <form className="w-full lg:w-96">
                  <select name="machine_id" defaultValue={selectedMachineId} className="field-input" aria-label="Select machine">
                    {machineRows.map((machine) => (
                      <option key={machine.id} value={machine.id}>
                        {machine.name} ({machine.machine_code})
                      </option>
                    ))}
                  </select>
                  <button className="sr-only" type="submit">Filter</button>
                </form>
              </div>
            </SectionCard>

            {machinesWithoutSlots.length ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <span className="font-semibold">Planograms optional:</span> {machinesWithoutSlots.length} machine{machinesWithoutSlots.length === 1 ? "" : "s"} have no Snacky slots yet. Refill recommendations still use imported VMS machine goods stock while planogram sync is pending.
              </div>
            ) : null}

            <SectionCard>
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">{selectedMachine?.name ?? "Machine"}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {selectedMachine?.machine_code ?? "No code"} - {selectedSlots.length} configured slot{selectedSlots.length === 1 ? "" : "s"}
                  </p>
                </div>
                <PrimaryButton href={selectedMachineId ? `/machine-slots/new?machine_id=${selectedMachineId}` : "/machine-slots/new"}>Add Slot</PrimaryButton>
              </div>

              {!selectedSlots.length ? (
                <div className="space-y-4">
                  <EmptyState title="No Snacky slots configured for this machine yet." body="That is okay for the current phase. VMS machine goods imports can still generate refill recommendations when products are mapped and capacity is available." />
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
                    Add slots here only when you want to override VMS capacity with Snacky min/par rules.
                  </div>
                </div>
              ) : (
                <DataTable headers={["Slot Code", "Product", "Capacity", "Minimum Quantity", "Par Quantity", "Status", "Actions"]}>
                  {selectedSlots.map((slot) => {
                    const invalid = Number(slot.min_qty) > Number(slot.par_qty) || Number(slot.par_qty) > Number(slot.capacity);

                    return (
                      <tr key={slot.id} className={invalid ? "bg-amber-50/70" : undefined}>
                        <td className="font-semibold text-slate-900">{slot.slot_code}</td>
                        <td>
                          <div className="font-medium text-slate-900">{slot.product?.name ?? "Unknown product"}</div>
                          <div className="text-xs text-slate-500">{slot.product?.sku ?? "-"}</div>
                        </td>
                        <td>{slot.capacity}</td>
                        <td>{slot.min_qty}</td>
                        <td>{slot.par_qty}</td>
                        <td>
                          <StatusBadge status={invalid ? "needs_review" : slot.active ? "active" : "inactive"} />
                        </td>
                        <td>
                          <Link className="btn-secondary" href={`/machine-slots/${slot.id}/edit`}>
                            Edit
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </DataTable>
              )}
            </SectionCard>
          </>
        )}
      </div>
    </>
  );
}
