import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { lyd } from "@/lib/format";
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

export default async function InventoryPage() {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/inventory")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  const canSeeCost = canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });

  const [{ data: storageRows }, { data: products }, { data: reservedRows }, { data: movements }] = supabase
    ? await Promise.all([
        supabase
          .from("current_inventory_by_location")
          .select("product_id, product_name, location_type, quantity_on_hand")
          .eq("location_type", "storage")
          .order("product_name"),
        supabase.from("products").select("id, sku, name, category, cost_price, current_cost_price_lyd").order("name"),
        supabase
          .from("route_stock_lines")
          .select("product_id, planned_qty, picked_qty, routes!inner(status)")
          .in("routes.status", ["draft", "assigned"]),
        supabase
          .from("inventory_movements")
          .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")
          .order("created_at", { ascending: false })
          .limit(50),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const productById = new Map((products ?? []).map((product: any) => [product.id, product]));
  const storageByProduct = new Map<string, number>();
  (storageRows ?? []).forEach((row: any) => {
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
        productName: product?.name ?? (storageRows ?? []).find((row: any) => row.product_id === productId)?.product_name ?? "Unknown product",
        sku: product?.sku ?? "-",
        category: product?.category ?? "-",
        cost: Number(product?.current_cost_price_lyd ?? product?.cost_price ?? 0),
        currentQty,
        reservedQty,
        availableQty,
        status: inventoryStatus(currentQty, reservedQty, availableQty),
      };
    })
    .filter((row) => row.currentQty !== 0 || row.reservedQty !== 0)
    .sort((a, b) => a.productName.localeCompare(b.productName));

  const inventoryHeaders = ["Product", "SKU", "Category", "Current Storage Qty", "Reserved for Routes", "Available Qty", ...(canSeeCost ? ["Cost"] : []), "Status"];

  return (
    <AppShell>
      <PageHeader
        title="Storage Inventory"
        subtitle="Ledger-calculated storage stock, route reservations, available quantity, and movement history."
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/inventory/movements">Movement Log</SecondaryButton><PrimaryButton href="/inventory/movements/new">New Stock Movement</PrimaryButton></div>}
      />

      {!inventoryRows.length ? (
        <EmptyState title="No storage inventory yet" body="Create inventory movements into storage to populate calculated balances." />
      ) : (
        <DataTable headers={inventoryHeaders}>
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
      )}

      <section className="surface-card mt-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Stock Movement History</h2>
            <p className="text-sm text-slate-500">Recent ledger entries. Stock balances are never edited directly.</p>
          </div>
        </div>
        {!movements?.length ? (
          <EmptyState title="No movements recorded" body="New purchase receipts, route picks, returns, adjustments, and waste movements will appear here." />
        ) : (
          <DataTable headers={["Created", "Product", "Qty", "From", "To", "Reason", "Route"]}>
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
        )}
      </section>
    </AppShell>
  );
}
