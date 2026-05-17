import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

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
  }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/inventory/movements")) {
    redirect("/unauthorized");
  }

  const params = await searchParams;
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return (
      <AppShell>
        <ErrorState
          title="Inventory movement log unavailable"
          body="Supabase is not configured, so Snacky OS cannot load real inventory_movements rows."
          action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
        />
      </AppShell>
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
    supabase.from("products").select("id, sku, name").order("name"),
    supabase.from("team_members").select("id, full_name").order("full_name"),
    supabase.from("routes").select("id, route_date").order("route_date", { ascending: false }).limit(200),
    supabase.from("purchase_orders").select("id, receipt_number, order_date").order("order_date", { ascending: false }).limit(200),
    supabase.from("machines").select("id, name, machine_code").order("name"),
    supabase.from("storage_locations").select("id, name").order("name"),
  ]);

  const setupError = productsError ?? usersError ?? routesError ?? purchasesError ?? machinesError ?? storagesError;
  if (setupError) {
    console.error("[inventory:movements] Failed to load filter data", setupError);
    return (
      <AppShell>
        <ErrorState
          title="Could not load movement filters"
          body="Snacky OS could not load the product, user, route, purchase, machine, or storage data needed for the movement log."
          action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
        />
      </AppShell>
    );
  }

  let movementQuery = supabase
    ?.from("inventory_movements")
    .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, related_route_stop_id, related_purchase_id, related_purchase_line_id, related_machine_id, notes, created_by, created_at, product:products(id, sku, name), created_by_member:team_members(id, full_name)")
    .order("created_at", { ascending: false })
    .limit(500);

  if (movementQuery && params.product_id) movementQuery = movementQuery.eq("product_id", params.product_id);
  if (movementQuery && params.reason && movementReasons.includes(params.reason as any)) movementQuery = movementQuery.eq("reason", params.reason);
  if (movementQuery && params.user_id) movementQuery = movementQuery.eq("created_by", params.user_id);
  if (movementQuery && params.route_id) movementQuery = movementQuery.eq("related_route_id", params.route_id);
  if (movementQuery && params.purchase_id) movementQuery = movementQuery.eq("related_purchase_id", params.purchase_id);
  if (movementQuery && params.machine_id) movementQuery = movementQuery.or(`related_machine_id.eq.${params.machine_id},to_entity_id.eq.${params.machine_id},from_entity_id.eq.${params.machine_id}`);
  if (movementQuery && params.date_from) movementQuery = movementQuery.gte("created_at", `${params.date_from}T00:00:00`);
  if (movementQuery && params.date_to) movementQuery = movementQuery.lte("created_at", `${params.date_to}T23:59:59`);

  const { data: movementData, error: movementError } = movementQuery ? await movementQuery : { data: [], error: null };
  if (movementError) {
    console.error("[inventory:movements] Failed to load inventory_movements", movementError);
    return (
      <AppShell>
        <ErrorState
          title="Could not load inventory movements"
          body="The movement log reads directly from inventory_movements, but that query failed. No fake rows are shown."
          action={<SecondaryButton href="/inventory/movements">Retry</SecondaryButton>}
        />
      </AppShell>
    );
  }

  const routeById = new Map((routes ?? []).map((route: any) => [route.id, route]));
  const purchaseById = new Map((purchases ?? []).map((purchase: any) => [purchase.id, purchase]));
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));
  const storageById = new Map((storages ?? []).map((storage: any) => [storage.id, storage]));
  const userById = new Map((users ?? []).map((user: any) => [user.id, user]));
  const labelMaps = { machineById, storageById, userById };
  const search = String(params.q ?? "").trim().toLowerCase();
  const movements = (movementData ?? []).filter((movement: any) => {
    if (!search) return true;
    const haystack = [
      movement.product?.name,
      movement.product?.sku,
      movement.notes,
    ].join(" ").toLowerCase();
    return haystack.includes(search);
  });

  return (
    <AppShell>
      <PageHeader
        title="Inventory Movement Log"
        subtitle="Append-only product movement ledger for purchases, route picks, fills, returns, waste, and corrections."
        action={<PrimaryButton href="/inventory/movements/new">New correction movement</PrimaryButton>}
      />

      <section className="surface-card mb-6 space-y-4">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
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

      {!movements.length ? (
        <EmptyState title="No movements match these filters" body="Inventory movements will appear here when purchases are received, routes are executed, or correction movements are created." />
      ) : (
        <DataTable headers={["Date / Time", "Product", "SKU", "Qty", "From type", "From label", "To type", "To label", "Reason", "Route", "Purchase", "Machine", "User", "Notes"]}>
          {movements.map((movement: any) => (
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
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
