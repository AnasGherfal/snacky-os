import { BarList, KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { LOW_STORAGE_QTY, formatInteger } from "@/lib/kpi";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function InventoryDashboardPage() {
  await requireCurrentProfileForPath("/inventory-dashboard");
  const supabase = getSupabaseServerClient();
  const [inventoryResult, productsResult, reservedResult, recommendationsResult] = supabase
    ? await Promise.all([
        safeSupabaseQuery<any>({
          label: "inventory-dashboard.current_inventory_by_location",
          promise: supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, location_name, quantity_on_hand").order("product_name"),
        }),
        safeSupabaseQuery<any>({
          label: "inventory-dashboard.products",
          promise: supabase.from("products").select("id, sku, name, cost_price, current_cost_price_lyd, active").order("name"),
        }),
        safeSupabaseQuery<any>({
          label: "inventory-dashboard.refill_order_lines",
          promise: supabase
            .from("refill_order_lines")
            .select("product_id, final_qty_to_take, picked_qty, product:products(id, name), refill_order:refill_orders(id, status)")
            .in("refill_order.status", ["assigned", "picked", "in_progress"]),
        }),
        safeSupabaseQuery<any>({
          label: "inventory-dashboard.refill_recommendations",
          promise: supabase.from("refill_recommendations").select("product_id, product_name, final_qty_to_take, suggested_qty, available_storage_qty, priority"),
        }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

  const inventory = (inventoryResult.data ?? []) as any[];
  const products = (productsResult.data ?? []) as any[];
  const reservedLines = (reservedResult.data ?? []) as any[];
  const recommendations = (recommendationsResult.data ?? []) as any[];
  const costByProduct = new Map(products.map((product) => [String(product.id), Number(product.current_cost_price_lyd ?? product.cost_price ?? 0)]));

  const storageRows = inventory.filter((row) => row.location_type === "storage");
  const operatorBagRows = inventory.filter((row) => row.location_type === "operator_bag");
  const machineRows = inventory.filter((row) => row.location_type === "machine");
  const storageByProduct = new Map<string, { productId: string; productName: string; quantity: number; value: number }>();

  storageRows.forEach((row) => {
    const productId = String(row.product_id);
    const current = storageByProduct.get(productId) ?? { productId, productName: row.product_name, quantity: 0, value: 0 };
    const quantity = Number(row.quantity_on_hand ?? 0);
    current.quantity += quantity;
    current.value += quantity * (costByProduct.get(productId) ?? 0);
    storageByProduct.set(productId, current);
  });

  const storageSummary = Array.from(storageByProduct.values()).sort((a, b) => a.productName.localeCompare(b.productName));
  const lowStorage = storageSummary.filter((row) => row.quantity <= LOW_STORAGE_QTY);
  const totalInventoryValue = storageSummary.reduce((sum, row) => sum + row.value, 0);
  const productsInOperatorBags = operatorBagRows.reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
  const productsInMachines = machineRows.reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);

  const reservedByProduct = new Map<string, { productName: string; quantity: number }>();
  reservedLines.forEach((line) => {
    const productId = String(line.product_id);
    const current = reservedByProduct.get(productId) ?? { productName: line.product?.name ?? "Unknown product", quantity: 0 };
    current.quantity += Number(line.final_qty_to_take ?? line.picked_qty ?? 0);
    reservedByProduct.set(productId, current);
  });

  const suggestedPurchase = recommendations
    .map((row) => {
      const productId = String(row.product_id);
      const storageQty = storageByProduct.get(productId)?.quantity ?? Number(row.available_storage_qty ?? 0);
      const suggestedQty = Number(row.suggested_qty ?? row.final_qty_to_take ?? 0);
      const buyQty = Math.max(suggestedQty - storageQty, storageQty <= LOW_STORAGE_QTY ? LOW_STORAGE_QTY - storageQty : 0);

      return {
        productId,
        productName: row.product_name,
        storageQty,
        suggestedQty,
        priority: row.priority,
        buyQty,
      };
    })
    .filter((row) => row.buyQty > 0)
    .sort((a, b) => b.buyQty - a.buyQty)
    .slice(0, 20);

  return (
    <>
      <PageHeader title="Inventory Dashboard" subtitle="Ledger-based storage, operator bag, machine inventory, reservations, and suggested purchases." />

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate inventory KPIs" body="Add environment variables and restart the app." />
      ) : (
        <div className="space-y-6">
          <KpiLoadWarning message={inventoryResult.error} />
          <KpiLoadWarning message={productsResult.error} />
          <KpiLoadWarning message={reservedResult.error} />
          <KpiLoadWarning message={recommendationsResult.error} />

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiSection title="Storage SKUs"><div className="text-3xl font-semibold">{formatInteger(storageSummary.length)}</div></KpiSection>
            <KpiSection title="Low storage products"><div className="text-3xl font-semibold">{formatInteger(lowStorage.length)}</div></KpiSection>
            <KpiSection title="Inventory value"><div className="text-3xl font-semibold">{lyd(totalInventoryValue)}</div></KpiSection>
            <KpiSection title="Operator bags"><div className="text-3xl font-semibold">{formatInteger(productsInOperatorBags)}</div></KpiSection>
          </div>

          {!inventory.length ? <EmptyState title="No inventory movement yet" body="Receive purchases and execute routes to populate ledger-based inventory dashboards." /> : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Low storage products" subtitle={`Products at or below ${LOW_STORAGE_QTY} units in storage.`}>
              {lowStorage.length ? (
                <BarList rows={lowStorage.slice(0, 12).map((row) => ({ label: row.productName, value: row.quantity, detail: `Value ${lyd(row.value)}` }))} valueFormatter={formatInteger} />
              ) : (
                <p className="text-sm text-slate-500">No low storage products right now.</p>
              )}
            </KpiSection>
            <KpiSection title="Products reserved for routes">
              {reservedByProduct.size ? (
                <DataTable headers={["Product", "Reserved qty"]}>
                  {Array.from(reservedByProduct.entries()).map(([productId, row]) => (
                    <tr key={productId}>
                      <td className="font-medium">{row.productName}</td>
                      <td>{formatInteger(row.quantity)}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <p className="text-sm text-slate-500">No assigned or picked route reservations.</p>
              )}
            </KpiSection>
          </div>

          <KpiSection title="Current storage inventory">
            <DataTable headers={["Product", "Storage qty", "Inventory value"]}>
              {storageSummary.map((row) => (
                <tr key={row.productId}>
                  <td className="font-medium">{row.productName}</td>
                  <td>{formatInteger(row.quantity)}</td>
                  <td>{lyd(row.value)}</td>
                </tr>
              ))}
            </DataTable>
          </KpiSection>

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Products in operator bags">
              {operatorBagRows.length ? (
                <DataTable headers={["Product", "Operator", "Qty"]}>
                  {operatorBagRows.map((row, index) => (
                    <tr key={`${row.product_id}-${row.location_name}-${index}`}>
                      <td className="font-medium">{row.product_name}</td>
                      <td>{row.location_name}</td>
                      <td>{formatInteger(row.quantity_on_hand)}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <p className="text-sm text-slate-500">No products currently in operator bags.</p>
              )}
            </KpiSection>
            <KpiSection title="Machine inventory">
              {machineRows.length ? (
                <DataTable headers={["Product", "Machine", "Qty"]}>
                  {machineRows.map((row, index) => (
                    <tr key={`${row.product_id}-${row.location_name}-${index}`}>
                      <td className="font-medium">{row.product_name}</td>
                      <td>{row.location_name}</td>
                      <td>{formatInteger(row.quantity_on_hand)}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <p className="text-sm text-slate-500">No machine inventory ledger balance available yet.</p>
              )}
            </KpiSection>
          </div>

          <KpiSection title="Suggested purchase list" subtitle="Based on refill recommendations and storage availability.">
            {suggestedPurchase.length ? (
              <DataTable headers={["Product", "Storage qty", "Suggested refill need", "Suggested buy", "Priority"]}>
                {suggestedPurchase.map((row) => (
                  <tr key={row.productId}>
                    <td className="font-medium">{row.productName}</td>
                    <td>{formatInteger(row.storageQty)}</td>
                    <td>{formatInteger(row.suggestedQty)}</td>
                    <td className="font-semibold text-slate-900">{formatInteger(row.buyQty)}</td>
                    <td><StatusBadge status={row.priority} /></td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <p className="text-sm text-slate-500">No purchase suggestions from current refill recommendations.</p>
            )}
          </KpiSection>

          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
            Machine inventory total where available: <span className="font-semibold text-slate-900">{formatInteger(productsInMachines)}</span> units.
          </div>
        </div>
      )}
    </>
  );
}
