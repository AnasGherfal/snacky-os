import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { RouteCreatedToast } from "@/app/routes/[id]/RouteCreatedToast";
import { cancelRoute, deleteDraftRoute } from "@/lib/route-actions";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

export default async function RouteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error = "" } = await searchParams;
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Route unavailable" body="Supabase is not configured, so route details cannot be loaded." action={<SecondaryButton href="/routes">Back to routes</SecondaryButton>} />
      </>
    );
  }

  const { data: route, error: routeError } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status, started_at, completed_at, cancelled_at, cancelled_by, cancellation_reason, notes, created_at")
    .eq("id", id)
    .maybeSingle();

  if (routeError) {
    console.error("[routes:detail] Failed to load route by id", { id, error: routeError });
  }

  if (!route) {
    return (
      <>
        <PageHeader
          title="Route details"
          subtitle="This route could not be loaded."
          breadcrumbs={[{ label: "Operations", href: "/routes" }, { label: "Routes", href: "/routes" }, { label: "Missing route" }]}
          action={<SecondaryButton href="/routes">Back to routes</SecondaryButton>}
        />
        <ErrorState
          title="Route not found"
          body="The route may have been deleted, failed to save, or you may not have permission to view it."
          action={<SecondaryButton href="/routes/new">Create route</SecondaryButton>}
        />
      </>
    );
  }

  const routeRow: any = route;
  const [{ data: operator }, { data: stops, error: stopsError }, { data: stopItems, error: stopItemsError }, { data: routeStock, error: routeStockError }, { data: fillLines, error: fillLinesError }, { data: pickListItems, error: pickListItemsError }] = await Promise.all([
    routeRow.operator_id
      ? supabase.from("team_members").select("id, full_name").eq("id", routeRow.operator_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("route_stops")
      .select("id, stop_order, status, machine_id")
      .eq("route_id", id)
      .order("stop_order", { ascending: true }),
    supabase
      .from("route_stop_items")
      .select("id, route_stop_id, machine_id, product_id, machine_slot_id, slot_code, planned_quantity, source")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("route_stock_lines")
      .select("id, product_id, planned_qty, picked_qty, returned_qty, product:products(name)")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("route_stop_fill_lines")
      .select("id, route_stop_id, machine_id, assigned_product_id, product_id, substitute_product_id, action_type, assigned_qty, actual_qty, difference_qty, reason, notes, missing_product_name, needs_review, created_at")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("route_pick_list_items")
      .select("id, product_id, planned_qty, picked_qty, action_type, substituted_for_product_id, reason, notes, needs_review, created_at, product:products!route_pick_list_items_product_id_fkey(id, name), substituted_product:products!route_pick_list_items_substituted_for_product_id_fkey(id, name)")
      .eq("route_id", id)
      .order("created_at", { ascending: true }),
  ]);

  if (stopsError) console.error("[routes:detail] Failed to load route stops", { id, error: stopsError });
  let routeStopItems = stopItems ?? [];
  if (stopItemsError) {
    if (isMissingTable(stopItemsError, "route_stop_items")) {
      const { data: fallbackOrders, error: fallbackError } = await supabase
        .from("refill_orders")
        .select("id, machine_id, refill_order_lines(id, machine_slot_id, slot_code, product_id, final_qty_to_take, suggested_qty, source)")
        .eq("route_id", id);
      if (fallbackError) {
        console.error("[routes:detail] Failed to load fallback refill lines", { id, error: fallbackError });
      } else {
        routeStopItems = (fallbackOrders ?? []).flatMap((order: any) =>
          (order.refill_order_lines ?? []).map((line: any) => {
            const stop = (stops ?? []).find((routeStop: any) => routeStop.machine_id === order.machine_id);
            return {
              id: line.id,
              route_stop_id: stop?.id ?? null,
              machine_id: order.machine_id,
              product_id: line.product_id,
              machine_slot_id: line.machine_slot_id,
              slot_code: line.slot_code,
              planned_quantity: Number(line.final_qty_to_take ?? line.suggested_qty ?? 0),
              source: line.source ?? (line.machine_slot_id ? "refill_recommendation" : "manual_admin_assignment"),
            };
          }),
        );
      }
    } else {
      console.error("[routes:detail] Failed to load route stop items", { id, error: stopItemsError });
    }
  }
  if (routeStockError) console.error("[routes:detail] Failed to load route stock", { id, error: routeStockError });
  if (fillLinesError) console.error("[routes:detail] Failed to load operator fill lines", { id, error: fillLinesError });
  if (pickListItemsError && !isMissingTable(pickListItemsError, "route_pick_list_items")) console.error("[routes:detail] Failed to load route pick list items", { id, error: pickListItemsError });

  const routeStops = stops ?? [];
  const machineIds = Array.from(new Set([...routeStops.map((stop: any) => stop.machine_id), ...(stopItems ?? []).map((item: any) => item.machine_id)].filter(Boolean)));
  const productIds = Array.from(new Set([
    ...routeStopItems.map((line: any) => line.product_id),
    ...(routeStock ?? []).map((line: any) => line.product_id),
    ...(fillLines ?? []).flatMap((line: any) => [line.assigned_product_id, line.product_id, line.substitute_product_id]),
    ...(pickListItems ?? []).flatMap((line: any) => [line.product_id, line.substituted_for_product_id]),
  ].filter(Boolean)));
  const [{ data: machines }, { data: products }, { data: movements }, { data: cashCollections }, { data: issues }] = await Promise.all([
    machineIds.length ? supabase.from("machines").select("id, name, machine_code").in("id", machineIds) : Promise.resolve({ data: [] }),
    productIds.length ? supabase.from("products").select("id, name").in("id", productIds) : Promise.resolve({ data: [] }),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")
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
  const routeActivityQueries: PromiseLike<any>[] = [
    supabase
      .from("system_activity_logs")
      .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
      .eq("entity_type", "route")
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ];
  const stopIds = routeStops.map((stop: any) => stop.id).filter(Boolean);
  const cashIds = (cashCollections ?? []).map((cash: any) => cash.id).filter(Boolean);
  if (stopIds.length) {
    routeActivityQueries.push(
      supabase
        .from("system_activity_logs")
        .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
        .eq("entity_type", "route_stop")
        .in("entity_id", stopIds)
        .order("created_at", { ascending: false })
        .limit(100),
    );
  }
  if (cashIds.length) {
    routeActivityQueries.push(
      supabase
        .from("system_activity_logs")
        .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
        .eq("entity_type", "cash_collection")
        .in("entity_id", cashIds)
        .order("created_at", { ascending: false })
        .limit(100),
    );
  }
  routeActivityQueries.push(
    supabase
      .from("system_activity_logs")
      .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
      .contains("metadata", { route_id: id })
      .order("created_at", { ascending: false })
      .limit(100),
  );
  const activityResults = await Promise.all(routeActivityQueries);
  activityResults.forEach((result: any) => {
    if (result.error) console.error("[routes:detail] Failed to load route activity", { id, error: result.error });
  });
  const routeActivityRows = activityResults
    .flatMap((result: any) => result.data ?? [])
    .filter((activity: any, index: number, rows: any[]) => rows.findIndex((row: any) => row.id === activity.id) === index)
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 100);
  const hasPickMovements = Boolean(movements?.some((movement: any) => movement.reason === "storage_to_operator_bag"));
  const hasReturnMovements = Boolean(movements?.some((movement: any) => movement.reason === "operator_bag_to_storage"));
  const completedStopCount = routeStops.filter((stop: any) => stop.status === "completed").length;
  const timeline = [
    { label: "Draft", done: true, detail: `Created ${new Date(routeRow.created_at).toLocaleString("en-US")}` },
    { label: "Assigned", done: ["assigned", "in_progress", "completed", "reviewed"].includes(routeRow.status), detail: operator?.full_name ?? "Operator pending" },
    { label: "Picked", done: hasPickMovements || ["in_progress", "completed", "reviewed"].includes(routeRow.status), detail: hasPickMovements ? "Storage moved to operator bag" : "Awaiting pick confirmation" },
    { label: "Stops completed", done: routeStops.length > 0 && completedStopCount === routeStops.length, detail: `${completedStopCount}/${routeStops.length} stops` },
    { label: "Cash recorded", done: Boolean(cashCollections?.length), detail: `${cashCollections?.length ?? 0} cash records` },
    { label: "Leftovers returned", done: hasReturnMovements || ["completed", "reviewed"].includes(routeRow.status), detail: hasReturnMovements ? "Operator bag returned to storage" : "Awaiting leftover return" },
    { label: "Completed", done: ["completed", "reviewed"].includes(routeRow.status), detail: routeRow.completed_at ? new Date(routeRow.completed_at).toLocaleString("en-US") : "Not completed" },
    { label: "Reviewed", done: routeRow.status === "reviewed", detail: routeRow.status === "reviewed" ? "Admin review complete" : "Pending admin review" },
  ];
  return (
    <>
      <RouteCreatedToast />
      <div className="space-y-6">
        <PageHeader
          title="Route details"
          subtitle={`Route for ${routeRow.route_date}`}
          breadcrumbs={[{ label: "Operations", href: "/routes" }, { label: "Routes", href: "/routes" }, { label: routeRow.route_date }]}
          action={
            <div className="flex flex-wrap gap-2">
              <SecondaryButton href="/routes">Back to routes</SecondaryButton>
              {routeRow.status === "draft" ? (
                <ConfirmDialog
                  action={deleteDraftRoute}
                  triggerLabel="Delete draft"
                  title="Delete draft route?"
                  description="Draft routes can be hard-deleted only before inventory, cash, or finance history exists."
                  confirmLabel="Delete draft"
                  buttonClassName="btn-danger"
                  confirmButtonClassName="btn-danger"
                  hiddenFields={[{ name: "id", value: id }]}
                />
              ) : null}
              {["assigned", "in_progress"].includes(routeRow.status) ? (
                <ConfirmDialog
                  action={cancelRoute}
                  triggerLabel="Cancel route"
                  title="Cancel route?"
                  description="Cancelled routes stay in history with their planned work, movements, and operator activity."
                  confirmLabel="Cancel route"
                  buttonClassName="btn-danger"
                  confirmButtonClassName="btn-danger"
                  hiddenFields={[{ name: "id", value: id }]}
                />
              ) : null}
            </div>
          }
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div> : null}

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
                  <td>{item.product?.name ?? productById.get(item.product_id)?.name ?? "Unknown product"}</td>
                  <td>{item.planned_qty}</td>
                  <td>{item.picked_qty}</td>
                  <td>{item.returned_qty}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Machine-level planned items</h2>
          {!routeStops.length ? (
            <EmptyState title="No stops added yet" body="Machine-level planned products will appear under each stop." />
          ) : (
            <div className="space-y-6">
              {routeStops.map((stop: any) => {
                const items = routeStopItems.filter((item: any) => item.route_stop_id === stop.id || item.machine_id === stop.machine_id);
                return (
                <div key={stop.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm text-slate-500">Machine</div>
                      <div className="font-medium">{machineById.get(stop.machine_id)?.name ?? "Unknown machine"}</div>
                      <div className="text-sm text-slate-500">{machineById.get(stop.machine_id)?.machine_code ?? "-"}</div>
                    </div>
                    <StatusBadge status={stop.status} />
                  </div>
                  {items.length ? (
                    <DataTable headers={["Slot", "Product", "Planned qty", "Source"]}>
                      {items.map((line: any) => (
                        <tr key={line.id}>
                          <td>{line.slot_code ?? "-"}</td>
                          <td>{productById.get(line.product_id)?.name ?? "Unknown product"}</td>
                          <td>{line.planned_quantity}</td>
                          <td>{line.source === "refill_recommendation" ? "Refill recommendation" : "Manual admin assignment"}</td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <div className="text-sm text-slate-500">No planned products for this machine.</div>
                  )}
                </div>
              )})}
            </div>
          )}
        </section>

        <section className="surface-card p-4">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Confirmed pick list</h2>
              <p className="text-sm text-slate-500">Actual products picked before the operator left storage.</p>
            </div>
            <StatusBadge status={(pickListItems ?? []).some((line: any) => line.needs_review) ? "needs_review" : "ok"} />
          </div>
          {!pickListItems?.length ? (
            <EmptyState title="Pick list not confirmed" body="The operator has not confirmed storage-to-bag picking for this route yet." />
          ) : (
            <DataTable headers={["Product", "Type", "Planned", "Picked", "Review", "Reason"]}>
              {pickListItems.map((line: any) => (
                <tr key={line.id}>
                  <td>{line.product?.name ?? productById.get(line.product_id)?.name ?? "Unknown product"}</td>
                  <td><StatusBadge status={line.action_type} /></td>
                  <td>{line.planned_qty}</td>
                  <td>{line.picked_qty}</td>
                  <td><StatusBadge status={line.needs_review ? "needs_review" : "ok"} /></td>
                  <td>
                    <div>{line.reason ?? "-"}</div>
                    {line.substituted_for_product_id ? (
                      <div className="mt-1 text-xs text-slate-500">
                        Substituted for {line.substituted_product?.name ?? productById.get(line.substituted_for_product_id)?.name ?? "unknown product"}
                      </div>
                    ) : null}
                    {line.notes ? <div className="mt-1 text-xs text-slate-500">{line.notes}</div> : null}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="surface-card p-4">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Operator changes</h2>
              <p className="text-sm text-slate-500">Actual stop fills, shortages, extras, substitutions, and missing product reports.</p>
            </div>
            <StatusBadge status={(fillLines ?? []).some((line: any) => line.needs_review) ? "needs_review" : "ok"} />
          </div>
          {!fillLines?.length ? (
            <EmptyState title="No operator changes recorded" body="Completed stop actuals will appear here after the operator finishes a machine stop." />
          ) : (
            <DataTable headers={["Machine", "Type", "Planned product", "Actual product", "Assigned", "Actual", "Diff", "Review", "Reason"]}>
              {fillLines.map((line: any) => (
                <tr key={line.id}>
                  <td>{machineById.get(line.machine_id)?.name ?? "Unknown machine"}</td>
                  <td><StatusBadge status={line.action_type} /></td>
                  <td>{line.missing_product_name ?? productById.get(line.assigned_product_id)?.name ?? "-"}</td>
                  <td>{productById.get(line.product_id)?.name ?? productById.get(line.substitute_product_id)?.name ?? "-"}</td>
                  <td>{line.assigned_qty}</td>
                  <td>{line.actual_qty}</td>
                  <td>{line.difference_qty > 0 ? `+${line.difference_qty}` : line.difference_qty}</td>
                  <td><StatusBadge status={line.needs_review ? "needs_review" : "ok"} /></td>
                  <td>
                    <div>{line.reason ?? "-"}</div>
                    {line.notes ? <div className="mt-1 text-xs text-slate-500">{line.notes}</div> : null}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section className="surface-card p-4">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Inventory movements</h2>
              <p className="text-sm text-slate-500">Ledger entries generated by this route.</p>
            </div>
            <SecondaryButton href={`/inventory/movements?route_id=${id}`}>Open full log</SecondaryButton>
          </div>
          {!movements?.length ? (
            <EmptyState title="No inventory movements yet" body="Pick, fill, and leftover movements for this route will appear here." />
          ) : (
            <DataTable headers={["Created", "Product", "Qty", "From", "To", "Reason", "User", "Notes"]}>
              {movements.map((movement: any) => (
                <tr key={movement.id}>
                  <td>{new Date(movement.created_at).toLocaleString("en-US")}</td>
                  <td className="font-medium">{movement.product?.name ?? "Unknown product"}</td>
                  <td>{movement.quantity}</td>
                  <td><StatusBadge status={movement.from_entity_type} /></td>
                  <td><StatusBadge status={movement.to_entity_type} /></td>
                  <td>{movement.reason}</td>
                  <td>{movement.created_by_member?.full_name ?? "-"}</td>
                  <td>{movement.notes ?? "-"}</td>
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
              <DataTable headers={["Machine", "Expected", "Counted", "Variance", "Status"]}>
                {cashCollections.map((cash: any) => (
                  <tr key={cash.id}>
                    <td>{machineById.get(cash.machine_id)?.name ?? "Unknown machine"}</td>
                    <td>{cash.vms_expected_cash === null ? "-" : lyd(cash.vms_expected_cash)}</td>
                    <td>{cash.actual_cash_collected === null ? "-" : lyd(cash.actual_cash_collected)}</td>
                    <td>{cash.variance === null ? "-" : lyd(cash.variance)}</td>
                    <td><StatusBadge status={String(cash.review_status ?? "").replaceAll("_", " ")} /></td>
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

        {routeRow.status === "cancelled" ? (
          <section className="surface-card p-4">
            <h2 className="text-lg font-semibold">Cancellation</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div><div className="text-sm text-slate-500">Cancelled at</div><div className="font-medium">{routeRow.cancelled_at ? new Date(routeRow.cancelled_at).toLocaleString("en-US") : "-"}</div></div>
              <div><div className="text-sm text-slate-500">Reason</div><div className="font-medium">{routeRow.cancellation_reason ?? "-"}</div></div>
            </div>
          </section>
        ) : null}

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Status timeline</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            {timeline.map((item) => (
              <div key={item.label} className={`rounded-lg border p-3 ${item.done ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                <div className="text-sm font-semibold text-slate-900">{item.label}</div>
                <div className="mt-1 text-xs text-slate-600">{item.detail}</div>
                <div className="mt-2"><StatusBadge status={item.done ? "complete" : "pending"} /></div>
              </div>
            ))}
          </div>
        </section>

        <section className="surface-card p-4">
          <h2 className="text-lg font-semibold">Route activity</h2>
          <p className="mt-1 text-sm text-slate-500">Audit trail for route creation, picking, stop completion, cash review, issues, and leftover return.</p>
          {!routeActivityRows.length ? (
            <div className="mt-4">
              <EmptyState title="No route activity yet" body="Route actions will appear here as operators and admins work through the route." />
            </div>
          ) : (
            <div className="mt-4">
              <DataTable headers={["Created", "Action", "Entity", "User", "Summary"]}>
                {routeActivityRows.map((activity: any) => (
                  <tr key={activity.id}>
                    <td>{new Date(activity.created_at).toLocaleString("en-US")}</td>
                    <td><StatusBadge status={activity.action} /></td>
                    <td>{String(activity.entity_type ?? "-").replaceAll("_", " ")}</td>
                    <td>{activity.actor_name ?? activity.actor_role ?? "-"}</td>
                    <td>{activity.summary ?? activity.entity_label ?? "-"}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
