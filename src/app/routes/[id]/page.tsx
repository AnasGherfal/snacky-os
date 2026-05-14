import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { RouteCreatedToast } from "@/app/routes/[id]/RouteCreatedToast";

export const dynamic = "force-dynamic";

export default async function RouteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <AppShell>
        <ErrorState title="Route unavailable" body="Supabase is not configured, so route details cannot be loaded." action={<SecondaryButton href="/routes">Back to routes</SecondaryButton>} />
      </AppShell>
    );
  }

  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status, started_at, completed_at, notes, created_at")
    .eq("id", id)
    .maybeSingle();

  if (routeError) {
    console.error("[routes:detail] Failed to load route by id", { id, error: routeError });
  }

  if (!route) {
    return (
      <AppShell>
        <PageHeader title="Route details" subtitle="This route could not be loaded." action={<SecondaryButton href="/routes">Back to routes</SecondaryButton>} />
        <ErrorState
          title="Route not found"
          body="The route may have been deleted, failed to save, or you may not have permission to view it."
          action={<SecondaryButton href="/routes/new">Create route</SecondaryButton>}
        />
      </AppShell>
    );
  }

  const routeRow: any = route;
  const [{ data: operator }, { data: stops, error: stopsError }, { data: refillOrders, error: refillOrdersError }, { data: routeStock, error: routeStockError }] = await Promise.all([
    routeRow.operator_id
      ? supabase.from("team_members").select("id, full_name").eq("id", routeRow.operator_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("route_stops")
      .select("id, stop_order, status, machine_id")
      .eq("route_id", id)
      .order("stop_order", { ascending: true }),
    supabase
      .from("refill_orders")
      .select("id, status, machine_id, refill_order_lines(id, product_id, current_qty_vms, par_qty, suggested_qty, available_storage_qty, final_qty_to_take)")
      .eq("route_id", id)
      .order("machine_id", { ascending: true }),
    supabase
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name)")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
  ]);

  if (stopsError) console.error("[routes:detail] Failed to load route stops", { id, error: stopsError });
  if (refillOrdersError) console.error("[routes:detail] Failed to load refill orders", { id, error: refillOrdersError });
  if (routeStockError) console.error("[routes:detail] Failed to load route stock", { id, error: routeStockError });

  const routeStops = stops ?? [];
  const orders = refillOrders ?? [];
  const machineIds = Array.from(new Set([...routeStops.map((stop: any) => stop.machine_id), ...orders.map((order: any) => order.machine_id)].filter(Boolean)));
  const productIds = Array.from(new Set(orders.flatMap((order: any) => order.refill_order_lines?.map((line: any) => line.product_id) ?? []).filter(Boolean)));
  const [{ data: machines }, { data: products }, { data: movements }, { data: cashCollections }, { data: issues }] = await Promise.all([
    machineIds.length ? supabase.from("machines").select("id, name, machine_code").in("id", machineIds) : Promise.resolve({ data: [] }),
    productIds.length ? supabase.from("products").select("id, name").in("id", productIds) : Promise.resolve({ data: [] }),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, to_entity_type, reason, created_at, product:products(name)")
      .eq("related_route_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("cash_collections")
      .select("id, machine_id, vms_expected_cash, actual_cash_collected, variance, review_status, collected_at")
      .eq("route_id", id)
      .order("collected_at", { ascending: false }),
    machineIds.length
      ? supabase
          .from("issues")
          .select("id, machine_id, issue_type, priority, status, description, created_at")
          .in("machine_id", machineIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  const productById = new Map((products ?? []).map((product: any) => [product.id, product]));
  return (
    <AppShell>
      <RouteCreatedToast />
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
              <div>{operator?.full_name ?? "Unassigned"}</div>
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
            <EmptyState title="No stops added yet" body="This route was created successfully, but it does not have machine stops yet." />
          ) : (
            <DataTable headers={["Order", "Machine", "Code", "Stop status"]}>
              {routeStops.map((stop: any) => (
                <tr key={stop.id}>
                  <td>{stop.stop_order}</td>
                  <td>{machineById.get(stop.machine_id)?.name ?? "Unknown machine"}</td>
                  <td>{machineById.get(stop.machine_id)?.machine_code ?? "-"}</td>
                  <td><StatusBadge status={stop.status} /></td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Route stock</h2>
          {!routeStock?.length ? (
            <EmptyState title="No route stock" body="No storage stock has been planned for this route yet." />
          ) : (
            <DataTable headers={["Product", "Planned", "Picked", "Returned"]}>
              {routeStock.map((item: any) => (
                <tr key={item.id}>
                  <td>{item.product?.name ?? "Unknown product"}</td>
                  <td>{item.planned_qty}</td>
                  <td>{item.picked_qty}</td>
                  <td>{item.returned_qty}</td>
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
                      <div className="font-medium">{machineById.get(order.machine_id)?.name ?? "Unknown machine"}</div>
                      <div className="text-sm text-slate-500">{machineById.get(order.machine_id)?.machine_code ?? "-"}</div>
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
                          <td>{productById.get(line.product_id)?.name ?? "Unknown product"}</td>
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

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Inventory movements</h2>
          {!movements?.length ? (
            <EmptyState title="No inventory movements yet" body="Pick, fill, and leftover movements for this route will appear here." />
          ) : (
            <DataTable headers={["Product", "Qty", "From", "To", "Reason", "Created"]}>
              {movements.map((movement: any) => (
                <tr key={movement.id}>
                  <td className="font-medium">{movement.product?.name ?? "Unknown product"}</td>
                  <td>{movement.quantity}</td>
                  <td><StatusBadge status={movement.from_entity_type} /></td>
                  <td><StatusBadge status={movement.to_entity_type} /></td>
                  <td>{movement.reason}</td>
                  <td>{new Date(movement.created_at).toLocaleString("en-US")}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          <section className="surface-card p-4">
            <h2 className="text-lg font-semibold">Cash collections</h2>
            {!cashCollections?.length ? (
              <EmptyState title="No cash collected yet" body="Cash records are created when operators complete machine stops." />
            ) : (
              <DataTable headers={["Machine", "Expected", "Actual", "Variance", "Status"]}>
                {cashCollections.map((cash: any) => (
                  <tr key={cash.id}>
                    <td>{machineById.get(cash.machine_id)?.name ?? "Unknown machine"}</td>
                    <td>{lyd(cash.vms_expected_cash)}</td>
                    <td>{lyd(cash.actual_cash_collected)}</td>
                    <td>{lyd(cash.variance)}</td>
                    <td><StatusBadge status={cash.review_status} /></td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>

          <section className="surface-card p-4">
            <h2 className="text-lg font-semibold">Issues reported</h2>
            {!issues?.length ? (
              <EmptyState title="No issues reported" body="Operator-reported machine issues for this route will appear here." />
            ) : (
              <DataTable headers={["Machine", "Type", "Priority", "Status"]}>
                {issues.map((issue: any) => (
                  <tr key={issue.id}>
                    <td>{machineById.get(issue.machine_id)?.name ?? "Unknown machine"}</td>
                    <td>{issue.issue_type}</td>
                    <td><StatusBadge status={issue.priority} /></td>
                    <td><StatusBadge status={issue.status} /></td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
