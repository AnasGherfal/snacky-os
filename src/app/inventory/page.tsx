import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function inventoryStatus(currentQty: number, reservedQty: number, availableQty: number) {
  if (currentQty <= 0) return "out_of_stock";
  if (availableQty <= 0 && reservedQty > 0) return "reserved";
  if (availableQty <= 10) return "low_stock";
  return "available";
}

function formatEntity(type: string | null | undefined, name: string | null | undefined) {
  return name ? `${type}: ${name}` : type ?? "-";
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const profile = await getCurrentProfile();
  const userContext = profile
    ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }
    : null;

  if (!profile || !canAccessPath(userContext, "/inventory")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Inventory unavailable" body="Supabase is not configured, so Snacky OS cannot load ledger-based inventory." />
      </>
    );
  }
  const canSeeCost = canViewFinancials(userContext);
  const { data: products, count: productCount, error: productsError } = await supabase
    .from("products")
    .select("id, sku, name, category, cost_price, current_cost_price_lyd", { count: "exact" })
    .order("name")
    .range(from, to);
  const productIds = (products ?? []).map((product: any) => product.id);
  const [
    { data: inventoryLocationRows, error: inventoryError },
    { data: reservedRows, error: reservedError },
    { data: operatorBagRowsData, error: operatorBagError },
    { data: movements, error: movementsError },
  ] = await Promise.all([
    productIds.length
      ? supabase
          .from("current_inventory_by_location")
          .select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand")
          .eq("location_type", "storage")
          .in("product_id", productIds)
          .order("product_name")
      : Promise.resolve({ data: [], error: null }),
    productIds.length
      ? supabase
      .from("route_stock_lines")
      .select("product_id, planned_qty, picked_qty, routes!inner(status)")
          .in("routes.status", ["draft", "assigned"])
          .in("product_id", productIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("current_inventory_by_location")
      .select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand")
      .eq("location_type", "operator_bag")
      .order("location_name")
      .order("product_name")
      .range(from, to),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")
      .order("created_at", { ascending: false })
      .limit(pageSize),
  ]);
  const loadError = inventoryError ?? productsError ?? reservedError ?? operatorBagError ?? movementsError;
  if (loadError) {
    console.error("[inventory] Failed to load inventory page", loadError);
    return (
      <>
        <ErrorState title="Could not load inventory" body="Snacky OS could not load ledger inventory, product, reservation, or movement data." action={<SecondaryButton href="/inventory">Retry</SecondaryButton>} />
      </>
    );
  }

  const productById = new Map((products ?? []).map((product: any) => [product.id, product]));
  const storageRows = (inventoryLocationRows ?? []).filter((row: any) => row.location_type === "storage");
  const operatorBagRows = (operatorBagRowsData ?? [])
    .filter((row: any) => row.location_type === "operator_bag" && Number(row.quantity_on_hand ?? 0) > 0)
    .sort((a: any, b: any) => String(a.location_name ?? "").localeCompare(String(b.location_name ?? "")) || String(a.product_name ?? "").localeCompare(String(b.product_name ?? "")));
  const storageByProduct = new Map<string, number>();
  storageRows.forEach((row: any) => {
    storageByProduct.set(row.product_id, (storageByProduct.get(row.product_id) ?? 0) + Number(row.quantity_on_hand ?? 0));
  });

  const reservedByProduct = new Map<string, number>();
  (reservedRows ?? []).forEach((row: any) => {
    const qty = Math.max(0, Number(row.planned_qty ?? 0) - Number(row.picked_qty ?? 0));
    reservedByProduct.set(row.product_id, (reservedByProduct.get(row.product_id) ?? 0) + qty);
  });

  const inventoryRows = Array.from(new Set([...(products ?? []).map((product: any) => product.id), ...storageByProduct.keys()]))
    .map((productId) => {
      const product: any = productById.get(productId);
      const currentQty = storageByProduct.get(productId) ?? 0;
      const reservedQty = reservedByProduct.get(productId) ?? 0;
      const availableQty = Math.max(0, currentQty - reservedQty);
      return {
        productId,
        productName: product?.name ?? storageRows.find((row: any) => row.product_id === productId)?.product_name ?? "Unknown product",
        sku: product?.sku ?? "-",
        category: product?.category ?? "-",
        cost: Number(product?.current_cost_price_lyd ?? product?.cost_price ?? 0),
        currentQty,
        reservedQty,
        availableQty,
        status: inventoryStatus(currentQty, reservedQty, availableQty),
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));

  const inventoryHeaders = ["Product", "SKU", "Category", "Current Storage Qty", "Reserved for Routes", "Available Qty", ...(canSeeCost ? ["Cost"] : []), "Status"];

  return (
    <>
      <PageHeader
        title="Storage Inventory"
        subtitle="Ledger-calculated storage stock, route reservations, available quantity, and movement history."
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/inventory/movements">Movement Log</SecondaryButton><PrimaryButton href="/inventory/movements/new">New Stock Movement</PrimaryButton></div>}
      />

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shown storage units</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{inventoryRows.reduce((sum, row) => sum + row.currentQty, 0)}</div>
          <p className="mt-1 text-sm text-slate-500">Sellable stock in storage locations</p>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shown reserved units</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{inventoryRows.reduce((sum, row) => sum + row.reservedQty, 0)}</div>
          <p className="mt-1 text-sm text-slate-500">Assigned to draft or assigned routes</p>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Operator bag units</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{operatorBagRows.reduce((sum: number, row: any) => sum + Number(row.quantity_on_hand ?? 0), 0)}</div>
          <p className="mt-1 text-sm text-slate-500">{new Set(operatorBagRows.map((row: any) => row.location_id)).size} active bags with stock</p>
        </div>
      </div>

      {!inventoryRows.length ? (
        <EmptyState title="No storage inventory yet" body="Create inventory movements into storage to populate calculated balances." />
      ) : (
        <>
          <MobileCardList>
            {inventoryRows.map((row) => (
              <MobileRecordCard key={row.productId}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words text-base font-semibold text-slate-900">{row.productName}</h2>
                    <p className="mt-1 break-words text-xs text-slate-500">{row.sku} - {row.category}</p>
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <MobileField label="Current">{row.currentQty}</MobileField>
                  <MobileField label="Reserved">{row.reservedQty}</MobileField>
                  <MobileField label="Available"><span className="font-semibold text-slate-950">{row.availableQty}</span></MobileField>
                </div>
                {canSeeCost ? <div className="mt-3"><MobileField label="Cost">{lyd(row.cost)}</MobileField></div> : null}
              </MobileRecordCard>
            ))}
          </MobileCardList>
          <DataTable className="hidden md:block" headers={inventoryHeaders}>
            {inventoryRows.map((row) => (
              <tr key={row.productId}>
                <td className="font-medium text-slate-900">{row.productName}</td>
                <td>{row.sku}</td>
                <td>{row.category}</td>
                <td>{row.currentQty}</td>
                <td>{row.reservedQty}</td>
                <td className="font-semibold">{row.availableQty}</td>
                {canSeeCost ? <td>{lyd(row.cost)}</td> : null}
                <td><StatusBadge status={row.status} /></td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/inventory" searchParams={params} page={page} pageSize={pageSize} totalCount={productCount ?? 0} itemLabel="products" />
        </>
      )}

      <section className="mt-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Operator Bag Inventory</h2>
            <p className="text-sm text-slate-500">Stock currently outside storage and assigned to operators.</p>
          </div>
        </div>
        {!operatorBagRows.length ? (
          <EmptyState title="No operator bag stock" body="Operator bag balances appear after route picking and disappear as machines are filled or leftovers are returned." />
        ) : (
          <>
            <MobileCardList>
              {operatorBagRows.map((row: any) => (
                <MobileRecordCard key={`${row.location_id}-${row.product_id}`}>
                  <h3 className="break-words text-base font-semibold text-slate-900">{row.product_name ?? productById.get(row.product_id)?.name ?? "Unknown product"}</h3>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <MobileField label="Operator">{row.location_name ?? "Unknown operator"}</MobileField>
                    <MobileField label="Quantity"><span className="font-semibold text-slate-950">{Number(row.quantity_on_hand ?? 0)}</span></MobileField>
                  </div>
                </MobileRecordCard>
              ))}
            </MobileCardList>
            <DataTable className="hidden md:block" headers={["Operator", "Product", "Quantity"]}>
              {operatorBagRows.map((row: any) => (
                <tr key={`${row.location_id}-${row.product_id}`}>
                  <td className="font-medium text-slate-900">{row.location_name ?? "Unknown operator"}</td>
                  <td>{row.product_name ?? productById.get(row.product_id)?.name ?? "Unknown product"}</td>
                  <td className="font-semibold">{Number(row.quantity_on_hand ?? 0)}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Stock Movement History</h2>
            <p className="text-sm text-slate-500">Recent ledger entries. Stock balances are never edited directly.</p>
          </div>
        </div>
        {!movements?.length ? (
          <EmptyState title="No movements recorded" body="New purchase receipts, route picks, returns, adjustments, and waste movements will appear here." />
        ) : (
          <>
            <MobileCardList>
              {movements.map((movement: any) => (
                <MobileRecordCard key={movement.id}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-base font-semibold text-slate-900">{movement.product?.name ?? "Unknown product"}</h3>
                      <p className="mt-1 text-xs text-slate-500">{new Date(movement.created_at).toLocaleString("en-US")}</p>
                    </div>
                    <StatusBadge status={movement.reason} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label="Qty">{movement.quantity}</MobileField>
                    <MobileField label="Route">{movement.related_route_id ? movement.related_route_id.slice(0, 8) : "-"}</MobileField>
                    <MobileField label="From">{formatEntity(movement.from_entity_type, movement.from_entity_id)}</MobileField>
                    <MobileField label="To">{formatEntity(movement.to_entity_type, movement.to_entity_id)}</MobileField>
                  </div>
                </MobileRecordCard>
              ))}
            </MobileCardList>
            <DataTable className="hidden md:block" headers={["Created", "Product", "Qty", "From", "To", "Reason", "Route"]}>
              {movements.map((movement: any) => (
                <tr key={movement.id}>
                  <td>{new Date(movement.created_at).toLocaleString("en-US")}</td>
                  <td className="font-medium">{movement.product?.name ?? "Unknown product"}</td>
                  <td>{movement.quantity}</td>
                  <td>{formatEntity(movement.from_entity_type, movement.from_entity_id)}</td>
                  <td>{formatEntity(movement.to_entity_type, movement.to_entity_id)}</td>
                  <td><StatusBadge status={movement.reason} /></td>
                  <td>{movement.related_route_id ? movement.related_route_id.slice(0, 8) : "-"}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </section>
    </>
  );
}
