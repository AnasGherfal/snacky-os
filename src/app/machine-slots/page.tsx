import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function MachinePlanogramsPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { machine_id?: string }> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const machine_id = String(params.machine_id ?? "");
  const supabase = getSupabaseServerClient();
  const { data: machines } = supabase
    ? await supabase.from("machines").select("id, name, machine_code, status").order("name").limit(500)
    : { data: [] };

  const machineRows = (machines ?? []) as any[];
  const selectedMachineId = machine_id || machineRows[0]?.id || "";
  const selectedMachine = machineRows.find((machine) => machine.id === selectedMachineId);
  const { data: slots, count: slotCount } = supabase && selectedMachineId
    ? await supabase
        .from("machine_slots")
        .select("id, slot_code, capacity, min_qty, par_qty, active, machine_id, product:products(id, name, sku)", { count: "exact" })
        .eq("machine_id", selectedMachineId)
        .order("slot_code")
        .range(from, to)
    : { data: [], count: 0 };
  const selectedSlots = (slots ?? []) as any[];

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
                  <input type="hidden" name="pageSize" value={pageSize} />
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

            <SectionCard>
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">{selectedMachine?.name ?? "Machine"}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {selectedMachine?.machine_code ?? "No code"} - {slotCount ?? 0} configured slot{slotCount === 1 ? "" : "s"}
                  </p>
                </div>
                <PrimaryButton href={selectedMachineId ? `/machine-slots/new?machine_id=${selectedMachineId}` : "/machine-slots/new"}>Add Slot</PrimaryButton>
              </div>

              {!(slotCount ?? 0) ? (
                <div className="space-y-4">
                  <EmptyState title="No Snacky slots configured for this machine yet." body="That is okay for the current phase. VMS machine goods imports can still generate refill recommendations when products are mapped and capacity is available." />
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
                    Add slots here only when you want to override VMS capacity with Snacky min/par rules.
                  </div>
                </div>
              ) : (
                <>
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
                  <PaginationControls basePath="/machine-slots" searchParams={params} page={page} pageSize={pageSize} totalCount={slotCount ?? 0} itemLabel="slots" />
                </>
              )}
            </SectionCard>
          </>
        )}
      </div>
    </>
  );
}
