import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function RouteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: route }, { data: stops }, { data: refillOrders }] = await Promise.all([
    supabase.from("routes").select("*, operator(id, full_name)").eq("id", id).single(),
    supabase
      .from("route_stops")
      .select("id, stop_order, status, machine(id, name, machine_code)")
      .eq("route_id", id)
      .order("stop_order", { ascending: true }),
    supabase
      .from("refill_orders")
      .select(
        "id, status, machine(id, name, machine_code), refill_order_lines(id, product_id, product(name), current_qty_vms, par_qty, suggested_qty, available_storage_qty, final_qty_to_take)"
      )
      .eq("route_id", id)
      .order("machine_id", { ascending: true }),
  ]);

  if (!route) notFound();

  const routeRow: any = route;

  const routeStops = stops ?? [];
  const orders = refillOrders ?? [];
  const pickMap = new Map<string, { productName: string; quantity: number }>();

  orders.forEach((order: any) => {
    order.refill_order_lines?.forEach((line: any) => {
      const key = String(line.product_id);
      const current = pickMap.get(key);
      const quantity = Number(line.final_qty_to_take ?? line.suggested_qty ?? 0);
      if (current) {
        current.quantity += quantity;
      } else {
        pickMap.set(key, { productName: line.product?.name ?? "Unknown", quantity });
      }
    });
  });

  const pickList = Array.from(pickMap.values());

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader title="Route details" subtitle={`Route for ${routeRow.route_date}`} action={<SecondaryButton href="/routes">Back to routes</SecondaryButton>} />

        <div className="grid gap-4 md:grid-cols-3">
          <SectionCard>
            <div className="space-y-2 p-4">
              <div className="text-sm text-slate-500">Status</div>
              <StatusBadge status={routeRow.status} />
            </div>
          </SectionCard>
          <SectionCard>
            <div className="space-y-2 p-4">
              <div className="text-sm text-slate-500">Operator</div>
              <div>{routeRow.operator?.full_name ?? "Unassigned"}</div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="space-y-2 p-4">
              <div className="text-sm text-slate-500">Stops</div>
              <div>{routeStops.length}</div>
            </div>
          </SectionCard>
        </div>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Route stops</h2>
          {!routeStops.length ? (
            <EmptyState title="No stops" body="This route currently has no machine stops." />
          ) : (
            <DataTable headers={["Order", "Machine", "Code", "Stop status"]}>
              {routeStops.map((stop: any) => (
                <tr key={stop.id}>
                  <td>{stop.stop_order}</td>
                  <td>{stop.machine?.name}</td>
                  <td>{stop.machine?.machine_code}</td>
                  <td><StatusBadge status={stop.status} /></td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Pick list</h2>
          {!pickList.length ? (
            <EmptyState title="No pick items" body="No refill order lines have been generated for this route yet." />
          ) : (
            <DataTable headers={["Product", "Total qty"]}>
              {pickList.map((item) => (
                <tr key={item.productName}>
                  <td>{item.productName}</td>
                  <td>{item.quantity}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Refill order details</h2>
          {!orders.length ? (
            <EmptyState title="No refill orders" body="This route does not have any refill orders created yet." />
          ) : (
            <div className="space-y-6">
              {orders.map((order: any) => (
                <div key={order.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm text-slate-500">Machine</div>
                      <div className="font-medium">{order.machine?.name}</div>
                      <div className="text-sm text-slate-500">{order.machine?.machine_code}</div>
                    </div>
                    <div>
                      <div className="text-sm text-slate-500">Order status</div>
                      <StatusBadge status={order.status} />
                    </div>
                  </div>
                  {order.refill_order_lines?.length ? (
                    <DataTable headers={["Product", "Current", "Par", "Suggested", "Take"]}>
                      {order.refill_order_lines.map((line: any) => (
                        <tr key={line.id}>
                          <td>{line.product?.name}</td>
                          <td>{line.current_qty_vms}</td>
                          <td>{line.par_qty}</td>
                          <td>{line.suggested_qty}</td>
                          <td>{line.final_qty_to_take}</td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <div className="text-sm text-slate-500">No lines created for this refill order.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
