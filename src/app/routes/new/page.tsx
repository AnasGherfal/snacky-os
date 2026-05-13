import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function redirectWithRouteError(message: string): never {
  redirect(`/routes/new?error=${encodeURIComponent(message)}`);
}

async function createRoute(fd: FormData) {
  "use server";
  const supabase = getSupabaseServerClient();
  if (!supabase) redirectWithRouteError("Supabase is not configured.");

  const route_date = String(fd.get("route_date") || "").trim();
  const operator_id = String(fd.get("operator_id") || "").trim();
  const manualMachineIds = fd.getAll("machine_ids").map((value) => String(value)).filter(Boolean);
  const recommendationSlotIds = fd.getAll("machine_slot_ids").map((value) => String(value)).filter(Boolean);

  if (!route_date || !operator_id || (!manualMachineIds.length && !recommendationSlotIds.length)) {
    redirectWithRouteError("Choose a route date, operator, and at least one machine or recommendation.");
  }

  const recommendationsResult = recommendationSlotIds.length
    ? await supabase
        .from("refill_recommendations")
        .select(
          "machine_id, machine_slot_id, product_id, current_qty, par_qty, suggested_qty, available_storage_qty, final_qty_to_take"
        )
        .in("machine_slot_id", recommendationSlotIds)
    : { data: [] };

  if ("error" in recommendationsResult && recommendationsResult.error) {
    redirectWithRouteError("Could not load selected refill recommendations.");
  }

  const recommendationRows = recommendationsResult.data ?? [];
  const recommendationMachineIds = recommendationRows.map((row: any) => row.machine_id).filter(Boolean);
  const selectedMachineIds = Array.from(new Set([...manualMachineIds, ...recommendationMachineIds]));

  if (!selectedMachineIds.length) {
    redirectWithRouteError("No valid machines were selected for this route.");
  }

  const routeInsert = await supabase
    .from("routes")
    .insert({ route_date, operator_id, status: "assigned" })
    .select("id")
    .single();

  if (routeInsert.error || !routeInsert.data) {
    redirectWithRouteError("Could not create the route. Check database permissions and try again.");
  }

  const routeId = routeInsert.data.id;
  const cleanupRoute = async () => {
    await supabase.from("refill_orders").delete().eq("route_id", routeId);
    await supabase.from("routes").delete().eq("id", routeId);
  };

  const stopsInsert = await supabase.from("route_stops").insert(
    selectedMachineIds.map((machine_id, index) => ({
      route_id: routeId,
      machine_id,
      stop_order: index + 1,
    }))
  );

  if (stopsInsert.error) {
    await cleanupRoute();
    redirectWithRouteError("Could not save route stops. The route was not created.");
  }

  if (recommendationRows.length) {
    const refillOrderInsert = await supabase
      .from("refill_orders")
      .insert(
        Array.from(new Set(recommendationMachineIds)).map((machine_id) => ({
          route_id: routeId,
          machine_id,
          status: "assigned",
        }))
      )
      .select("id, machine_id");

    if (refillOrderInsert.error || !refillOrderInsert.data?.length) {
      await cleanupRoute();
      redirectWithRouteError("Could not create refill orders. The route was not created.");
    }

    const orderByMachine = new Map<string, string>();
    refillOrderInsert.data.forEach((order: any) => {
      orderByMachine.set(order.machine_id, order.id);
    });

    const refillLines = recommendationRows
      .map((row: any) => ({
        refill_order_id: orderByMachine.get(row.machine_id),
        machine_slot_id: row.machine_slot_id,
        product_id: row.product_id,
        current_qty_vms: row.current_qty,
        par_qty: row.par_qty,
        suggested_qty: row.suggested_qty,
        available_storage_qty: row.available_storage_qty,
        final_qty_to_take: row.final_qty_to_take,
      }))
      .filter((line: any) => line.refill_order_id);

    const linesInsert = await supabase.from("refill_order_lines").insert(refillLines);

    if (linesInsert.error) {
      await cleanupRoute();
      redirectWithRouteError("Could not save refill order lines. The route was not created.");
    }
  }

  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);
  redirect(`/routes/${routeId}`);
}

export default async function NewRoutePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: operators }, { data: machines }, { data: recommendations }] = supabase
    ? await Promise.all([
        supabase.from("team_members").select("id, full_name").eq("role", "operator").eq("active", true).order("full_name"),
        supabase.from("machines").select("id, name, machine_code").eq("status", "active").order("name"),
        supabase
          .from("refill_recommendations")
          .select("machine_slot_id, machine_id, machine_name, machine_code, slot_code, product_name, current_qty, par_qty, suggested_qty, available_storage_qty")
          .order("machine_name")
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const today = new Date().toISOString().slice(0, 10);

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Create route" subtitle="Build a refill route from machine stops and refill recommendations." />
        {error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">
            {error}
          </div>
        ) : null}
        <form action={createRoute} className="space-y-6">
          <FormSection title="Route overview">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Route date" required>
                <input type="date" name="route_date" defaultValue={today} className="field-input" required />
              </FormField>
              <FormField label="Operator" required>
                <select name="operator_id" className="field-input" required>
                  <option value="">Select operator</option>
                  {operators?.map((operator: any) => (
                    <option key={operator.id} value={operator.id}>
                      {operator.full_name}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Refill recommendation rows">
            <p className="text-sm text-slate-500">Select recommended refill lines to create route stops and supply pick details automatically.</p>
            {!recommendations?.length ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                No active refill recommendations found. Import VMS stock and add machine slots to fill this list.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2" />
                      <th className="px-3 py-2">Machine</th>
                      <th className="px-3 py-2">Slot</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2">Current</th>
                      <th className="px-3 py-2">Par</th>
                      <th className="px-3 py-2">Take</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recommendations.map((row: any) => (
                      <tr key={row.machine_slot_id} className="border-t border-slate-200">
                        <td className="px-3 py-2">
                          <input type="checkbox" name="machine_slot_ids" value={row.machine_slot_id} className="h-4 w-4" />
                        </td>
                        <td className="px-3 py-2 font-medium">{row.machine_name}</td>
                        <td className="px-3 py-2">{row.slot_code}</td>
                        <td className="px-3 py-2">{row.product_name}</td>
                        <td className="px-3 py-2">{row.current_qty}</td>
                        <td className="px-3 py-2">{row.par_qty}</td>
                        <td className="px-3 py-2 font-semibold">{row.suggested_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </FormSection>

          <FormSection title="Add machine stops manually">
            <p className="text-sm text-slate-500">Choose machines that should be included in the route even if there is no recommendation row.</p>
            {!machines?.length ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                No active machines found. Create a machine first.
              </div>
            ) : (
              <div className="grid gap-2">
                {machines.map((machine: any) => (
                  <label key={machine.id} className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm hover:border-slate-400">
                    <input type="checkbox" name="machine_ids" value={machine.id} className="h-4 w-4" />
                    <span>{machine.name} <span className="text-slate-500">({machine.machine_code})</span></span>
                  </label>
                ))}
              </div>
            )}
          </FormSection>

          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Create route</PrimaryButton>
            <SecondaryButton href="/routes">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </AppShell>
  );
}
