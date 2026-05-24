import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { createInventoryMovementCorrection } from "@/lib/inventory-actions";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const movementReasons = [
  "purchase_received",
  "storage_to_operator_bag",
  "operator_bag_to_machine",
  "operator_bag_to_storage",
  "machine_to_storage",
  "damaged",
  "expired",
  "stock_count_adjustment",
  "manual_correction",
  "product_substitution",
  "historical_route_deduction",
] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "-";
}

function entityTypeLabel(type: string | null | undefined) {
  return type ? type.replaceAll("_", " ") : "-";
}

function entityLabel(
  type: string | null | undefined,
  id: string | null | undefined,
  labelMaps: { machineById: Map<string, any>; storageById: Map<string, any>; userById: Map<string, any> },
) {
  if (type === "historical_route") return "Historical route correction";
  if (!type || !id) return "-";
  if (type === "machine") {
    const machine = labelMaps.machineById.get(id);
    return machine ? machine.name : shortId(id);
  }
  if (type === "storage") {
    const storage = labelMaps.storageById.get(id);
    return storage ? storage.name : shortId(id);
  }
  if (type === "operator_bag") {
    const user = labelMaps.userById.get(id);
    return user ? user.full_name : shortId(id);
  }
  return shortId(id);
}

function routeLabel(id: string | null | undefined, routeById: Map<string, any>) {
  if (!id) return "-";
  const route = routeById.get(id);
  return route ? `${route.route_date} (${shortId(id)})` : shortId(id);
}

function purchaseLabel(id: string | null | undefined, purchaseById: Map<string, any>) {
  if (!id) return "-";
  const purchase = purchaseById.get(id);
  return purchase?.receipt_number ?? purchase?.order_date ?? shortId(id);
}

function machineLabel(id: string | null | undefined, machineById: Map<string, any>) {
  if (!id) return "-";
  const machine = machineById.get(id);
  return machine ? `${machine.name}${machine.machine_code ? ` (${machine.machine_code})` : ""}` : shortId(id);
}

export default async function InventoryMovementsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    product_id?: string;
    reason?: string;
    user_id?: string;
    route_id?: string;
    purchase_id?: string;
    machine_id?: string;
    date_from?: string;
    date_to?: string;
    error?: string;
    corrected?: string;
  } & SearchParamsRecord>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/inventory/movements")) {
    redirect("/unauthorized");
  }
  const canCreateCorrections = isOwnerAdminRole(profile);

  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const supabase = await getAuthenticatedSupabaseServerClient();

  if (!supabase) {
    return (
      <>
        <ErrorState
          title="Inventory movement log unavailable"
          body="Supabase is not configured, so Snacky OS cannot load real inventory_movements rows."
          action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
        />
      </>
    );
  }

  const [
    { data: products, error: productsError },
    { data: users, error: usersError },
    { data: routes, error: routesError },
    { data: purchases, error: purchasesError },
    { data: machines, error: machinesError },
    { data: storages, error: storagesError },
  ] = await Promise.all([
    supabase.from("products").select("id, sku, name").order("name").limit(500),
    supabase.from("team_members").select("id, full_name").order("full_name").limit(500),
    supabase.from("routes").select("id, route_date").order("route_date", { ascending: false }).limit(200),
    supabase.from("purchase_orders").select("id, receipt_number, order_date").order("order_date", { ascending: false }).limit(200),
    supabase.from("machines").select("id, name, machine_code").order("name").limit(500),
    supabase.from("storage_locations").select("id, name").order("name").limit(500),
  ]);

  const setupError = productsError ?? usersError ?? routesError ?? purchasesError ?? machinesError ?? storagesError;
  if (setupError) {
    console.error("[inventory:movements] Failed to load filter data", setupError);
    return (
      <>
        <ErrorState
          title="Could not load movement filters"
          body="Snacky OS could not load the product, user, route, purchase, machine, or storage data needed for the movement log."
          action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
        />
      </>
    );
  }

  const search = String(params.q ?? "").trim();
  const matchingProductIds = search
    ? ((await supabase
        .from("products")
        .select("id")
        .or(["sku", "name"].map((column) => `${column}.ilike.${supabaseLikePattern(search.replaceAll(",", " "))}`).join(","))
        .limit(100)).data ?? []).map((product: any) => product.id)
    : [];

  let movementQuery = supabase
    ?.from("inventory_movements")
    .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, related_route_stop_id, related_purchase_id, related_purchase_line_id, related_machine_id, reversed_movement_id, correction_reason, notes, created_by, created_at, product:products(id, sku, name), created_by_member:team_members(id, full_name)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (movementQuery && params.product_id) movementQuery = movementQuery.eq("product_id", params.product_id);
  if (movementQuery && params.reason && movementReasons.includes(params.reason as any)) movementQuery = movementQuery.eq("reason", params.reason);
  if (movementQuery && params.user_id) movementQuery = movementQuery.eq("created_by", params.user_id);
  if (movementQuery && params.route_id) movementQuery = movementQuery.eq("related_route_id", params.route_id);
  if (movementQuery && params.purchase_id) movementQuery = movementQuery.eq("related_purchase_id", params.purchase_id);
  if (movementQuery && params.machine_id) movementQuery = movementQuery.or(`related_machine_id.eq.${params.machine_id},to_entity_id.eq.${params.machine_id},from_entity_id.eq.${params.machine_id}`);
  if (movementQuery && params.date_from) movementQuery = movementQuery.gte("created_at", `${params.date_from}T00:00:00`);
  if (movementQuery && params.date_to) movementQuery = movementQuery.lte("created_at", `${params.date_to}T23:59:59`);
  if (movementQuery && search) {
    const pattern = supabaseLikePattern(search.replaceAll(",", " "));
    const clauses = [`notes.ilike.${pattern}`, `correction_reason.ilike.${pattern}`];
    if (matchingProductIds.length) clauses.push(`product_id.in.(${matchingProductIds.join(",")})`);
    movementQuery = movementQuery.or(clauses.join(","));
  }

  const { data: movements, count, error: movementError } = movementQuery ? await movementQuery.range(from, to) : { data: [], count: 0, error: null };
  if (movementError) {
    console.error("[inventory:movements] Failed to load inventory_movements", movementError);
    return (
      <>
        <ErrorState
          title="Could not load inventory movements"
          body="The movement log reads directly from inventory_movements, but that query failed. No fake rows are shown."
          action={<SecondaryButton href="/inventory/movements">Retry</SecondaryButton>}
        />
      </>
    );
  }

  const routeById = new Map((routes ?? []).map((route: any) => [route.id, route]));
  const purchaseById = new Map((purchases ?? []).map((purchase: any) => [purchase.id, purchase]));
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  const storageById = new Map((storages ?? []).map((storage: any) => [storage.id, storage]));
  const userById = new Map((users ?? []).map((user: any) => [user.id, user]));
  const labelMaps = { machineById, storageById, userById };
  const movementRows = movements ?? [];
  return (
    <>
      <PageHeader
        title="Inventory Movement Log"
        subtitle="Append-only product movement ledger for purchases, route picks, fills, returns, waste, and corrections."
        action={<PrimaryButton href="/inventory/movements/new">New correction movement</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.corrected ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Correction created for movement {params.corrected}.</div> : null}

      <section className="surface-card mb-6 space-y-4">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
          <input type="hidden" name="pageSize" value={pageSize} />
          <input name="q" defaultValue={params.q ?? ""} placeholder="Search product name, SKU, notes..." className="field-input md:col-span-2" />
          <select name="product_id" defaultValue={params.product_id ?? ""} className="field-input">
            <option value="">All products</option>
            {products?.map((product: any) => <option key={product.id} value={product.id}>{product.name}{product.sku ? ` (${product.sku})` : ""}</option>)}
          </select>
          <select name="reason" defaultValue={params.reason ?? ""} className="field-input">
            <option value="">All reasons</option>
            {movementReasons.map((reason) => <option key={reason} value={reason}>{reason.replaceAll("_", " ")}</option>)}
          </select>
          <select name="user_id" defaultValue={params.user_id ?? ""} className="field-input">
            <option value="">All users</option>
            {users?.map((user: any) => <option key={user.id} value={user.id}>{user.full_name}</option>)}
          </select>
          <select name="route_id" defaultValue={params.route_id ?? ""} className="field-input">
            <option value="">All routes</option>
            {routes?.map((route: any) => <option key={route.id} value={route.id}>{route.route_date} ({shortId(route.id)})</option>)}
          </select>
          <select name="purchase_id" defaultValue={params.purchase_id ?? ""} className="field-input">
            <option value="">All purchases</option>
            {purchases?.map((purchase: any) => <option key={purchase.id} value={purchase.id}>{purchase.receipt_number ?? purchase.order_date ?? shortId(purchase.id)}</option>)}
          </select>
          <select name="machine_id" defaultValue={params.machine_id ?? ""} className="field-input">
            <option value="">All machines</option>
            {machines?.map((machine: any) => <option key={machine.id} value={machine.id}>{machine.name}{machine.machine_code ? ` (${machine.machine_code})` : ""}</option>)}
          </select>
          <input name="date_from" type="date" defaultValue={params.date_from ?? ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={params.date_to ?? ""} className="field-input" />
          <div className="flex gap-2">
            <button className="btn-primary">Filter</button>
            <Link href="/inventory/movements" className="btn-secondary">Reset</Link>
          </div>
        </form>
      </section>

      {!movementRows.length ? (
        <EmptyState title="No movements match these filters" body="Inventory movements will appear here when purchases are received, routes are executed, or correction movements are created." />
      ) : (
        <>
          <div className="space-y-3 xl:hidden">
            {movementRows.map((movement: any) => (
              <article key={movement.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500">{formatDate(movement.created_at)}</div>
                    <div className="mt-1 break-words text-base font-semibold text-slate-900">
                      {movement.product?.id ? (
                        <Link href={`/products/${movement.product.id}`} className="link-secondary text-base">
                          {movement.product?.name ?? "Unknown product"}
                        </Link>
                      ) : (
                        "Unknown product"
                      )}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">{movement.product?.sku ?? "No SKU"}</div>
                  </div>
                  <div className="rounded-lg bg-slate-100 px-3 py-2 text-center">
                    <div className="text-xs text-slate-500">Qty</div>
                    <div className="text-lg font-semibold text-slate-900">{movement.quantity}</div>
                  </div>
                </div>
                <div className="mt-4 grid gap-3">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">From</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={entityTypeLabel(movement.from_entity_type)} />
                      <span className="text-sm text-slate-700">{entityLabel(movement.from_entity_type, movement.from_entity_id, labelMaps)}</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">To</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={entityTypeLabel(movement.to_entity_type)} />
                      <span className="text-sm text-slate-700">{entityLabel(movement.to_entity_type, movement.to_entity_id, labelMaps)}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge status={String(movement.reason).replaceAll("_", " ")} />
                  {movement.related_route_id ? <Link href={`/routes/${movement.related_route_id}`} className="link-secondary">{routeLabel(movement.related_route_id, routeById)}</Link> : null}
                  {movement.related_purchase_id ? <Link href={`/purchases/${movement.related_purchase_id}`} className="link-secondary">{purchaseLabel(movement.related_purchase_id, purchaseById)}</Link> : null}
                </div>
                <div className="mt-3 text-sm text-slate-600">
                  <div>Machine: {machineLabel(movement.related_machine_id, machineById)}</div>
                  <div>User: {movement.created_by_member?.full_name ?? "-"}</div>
                  {movement.notes ? <div className="mt-1 break-words">Notes: {movement.notes}</div> : null}
                </div>
                {canCreateCorrections ? (
                  <div className="mt-4">
                    <ConfirmDialog
                      action={createInventoryMovementCorrection}
                      triggerLabel="Create Correction"
                      title="Create correction movement?"
                      description="This will add a new opposite ledger movement. The original inventory movement will stay unchanged."
                      confirmLabel="Create correction"
                      buttonClassName="btn-secondary w-full px-3 py-2"
                      confirmButtonClassName="btn-danger"
                      hiddenFields={[{ name: "id", value: movement.id }]}
                    />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <div className="hidden xl:block">
            <DataTable headers={["Date / Time", "Product", "SKU", "Qty", "From type", "From label", "To type", "To label", "Reason", "Route", "Purchase", "Machine", "User", "Notes", "Actions"]}>
              {movementRows.map((movement: any) => (
                <tr key={movement.id}>
                  <td>{formatDate(movement.created_at)}</td>
                  <td>
                    {movement.product?.id ? (
                      <Link href={`/products/${movement.product.id}`} className="link-secondary font-medium">
                        {movement.product?.name ?? "Unknown product"}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-900">Unknown product</span>
                    )}
                  </td>
                  <td>{movement.product?.sku ?? "-"}</td>
                  <td className="font-semibold">{movement.quantity}</td>
                  <td><StatusBadge status={entityTypeLabel(movement.from_entity_type)} /></td>
                  <td>{entityLabel(movement.from_entity_type, movement.from_entity_id, labelMaps)}</td>
                  <td><StatusBadge status={entityTypeLabel(movement.to_entity_type)} /></td>
                  <td>{entityLabel(movement.to_entity_type, movement.to_entity_id, labelMaps)}</td>
                  <td><StatusBadge status={String(movement.reason).replaceAll("_", " ")} /></td>
                  <td>{movement.related_route_id ? <Link href={`/routes/${movement.related_route_id}`} className="link-secondary">{routeLabel(movement.related_route_id, routeById)}</Link> : "-"}</td>
                  <td>{movement.related_purchase_id ? <Link href={`/purchases/${movement.related_purchase_id}`} className="link-secondary">{purchaseLabel(movement.related_purchase_id, purchaseById)}</Link> : "-"}</td>
                  <td>{machineLabel(movement.related_machine_id, machineById)}</td>
                  <td>{movement.created_by_member?.full_name ?? "-"}</td>
                  <td>{movement.notes ?? "-"}</td>
                  <td>
                    {canCreateCorrections ? (
                      <ConfirmDialog
                        action={createInventoryMovementCorrection}
                        triggerLabel="Create Correction"
                        title="Create correction movement?"
                        description="This will add a new opposite ledger movement. The original inventory movement will stay unchanged."
                        confirmLabel="Create correction"
                        buttonClassName="btn-secondary px-3 py-2"
                        confirmButtonClassName="btn-danger"
                        hiddenFields={[{ name: "id", value: movement.id }]}
                      />
                    ) : (
                      <span className="text-sm text-slate-500">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </div>
          <PaginationControls basePath="/inventory/movements" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="movements" />
        </>
      )}
    </>
  );
}
