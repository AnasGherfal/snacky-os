import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProductSourceBadge } from "@/components/ProductSourceBadge";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { canViewFinancials, hasPermission } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { activateProduct, archiveProduct, deleteProduct, getProductHistoryCounts, productHasBusinessHistory } from "@/lib/product-actions";
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

function entityLabel(type: string | null | undefined, id: string | null | undefined) {
  if (!type) return "-";
  return id ? `${type.replaceAll("_", " ")} ${shortId(id)}` : type.replaceAll("_", " ");
}

function relatedLabel(movement: any) {
  if (movement.related_route_id) return `Route ${shortId(movement.related_route_id)}`;
  if (movement.related_purchase_id) return `Purchase ${shortId(movement.related_purchase_id)}`;
  if (movement.related_machine_id) return `Machine ${shortId(movement.related_machine_id)}`;
  return "-";
}

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return `${Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} LYD`;
}

function priceValue(data: any, key: string) {
  if (!data || typeof data !== "object") return null;
  const value = data[key];
  return value === undefined || value === null || value === "" ? null : Number(value);
}

export default async function ProductHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reason?: string; user_id?: string; date_from?: string; date_to?: string; q?: string; error?: string }>;
}) {
  const { id } = await params;
  const profile = await requireCurrentProfileForPath(`/products/${id}/history`);
  const userContext = { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status };
  const canSeeCost = canViewFinancials(userContext);
  const canEditProduct = hasPermission(profile, "products.edit");
  const canDeleteProduct = hasPermission(profile, "products.delete");
  const filters = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: product }, { data: users }, { data: inventory }, { data: purchaseLines }, { data: salesRows }, { data: priceLogs }, historyCounts] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, name, category, case_quantity, active, import_source, last_vms_seen_at, current_selling_price_lyd, selling_price, selling_price_source, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd, last_purchase_date, last_supplier_id, last_supplier:suppliers!products_last_supplier_id_fkey(name), cost_price_source, price_updated_at")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("team_members").select("id, full_name").order("full_name"),
    supabase.from("current_inventory_by_location").select("location_type, location_name, quantity_on_hand").eq("product_id", id).order("location_type"),
    supabase
      .from("purchase_order_lines")
      .select("id, purchase_order_id, boxes_qty, units_per_box, loose_units_qty, total_units, received_qty, unit_cost_lyd, line_total_lyd, created_at, purchase:purchase_orders(id, receipt_number, order_date, status, supplier:suppliers(name))")
      .eq("product_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("vms_sales_snapshots")
      .select("id, machine_id, sold_qty, sales_amount, cash_sales_amount, card_sales_amount, period_start, period_end, machine:machines(name, machine_code)")
      .eq("product_id", id)
      .eq("import_row_status", "imported")
      .order("period_end", { ascending: false })
      .limit(200),
    supabase
      .from("system_activity_logs")
      .select("id, action, before_data, after_data, actor_name, created_at")
      .eq("entity_type", "product")
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    getProductHistoryCounts(supabase, id),
  ]);
  if (!product) notFound();
  const lastSupplierName = Array.isArray((product as any).last_supplier) ? (product as any).last_supplier[0]?.name : (product as any).last_supplier?.name;
  const hasBusinessHistory = await productHasBusinessHistory(historyCounts);

  let query = supabase
    .from("inventory_movements")
    .select(
      "id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, related_route_stop_id, related_purchase_id, related_purchase_line_id, related_machine_id, notes, created_at, created_by_member:team_members(id, full_name)",
    )
    .eq("product_id", id);

  if (filters.reason && movementReasons.includes(filters.reason as any)) query = query.eq("reason", filters.reason);
  if (filters.user_id) query = query.eq("created_by", filters.user_id);
  if (filters.date_from) query = query.gte("created_at", `${filters.date_from}T00:00:00`);
  if (filters.date_to) query = query.lte("created_at", `${filters.date_to}T23:59:59`);

  const { data } = await query.order("created_at", { ascending: false }).limit(500);
  const search = String(filters.q ?? "").trim().toLowerCase();
  const movements = (data ?? []).filter((movement: any) => {
    if (!search) return true;
    return [movement.reason, movement.notes, movement.created_by_member?.full_name, movement.related_route_id, movement.related_purchase_id, movement.related_machine_id]
      .join(" ")
      .toLowerCase()
      .includes(search);
  });

  const inventoryRows = (inventory ?? []) as any[];
  const storageQty = inventoryRows.filter((row) => row.location_type === "storage").reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
  const machineQty = inventoryRows.filter((row) => row.location_type === "machine").reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
  const bagQty = inventoryRows.filter((row) => row.location_type === "operator_bag").reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
  const sales = (salesRows ?? []) as any[];
  const purchases = (purchaseLines ?? []) as any[];
  const totalUnitsSold = sales.reduce((sum, row) => sum + Number(row.sold_qty ?? 0), 0);
  const totalSales = sales.reduce((sum, row) => sum + Number(row.sales_amount ?? 0), 0);
  const priceHistory = (priceLogs ?? [])
    .map((log: any) => ({
      ...log,
      beforeSelling: priceValue(log.before_data, "current_selling_price_lyd") ?? priceValue(log.before_data, "selling_price"),
      afterSelling: priceValue(log.after_data, "current_selling_price_lyd") ?? priceValue(log.after_data, "selling_price"),
      beforeCost: priceValue(log.before_data, "current_cost_price_lyd") ?? priceValue(log.before_data, "cost_price"),
      afterCost: priceValue(log.after_data, "current_cost_price_lyd") ?? priceValue(log.after_data, "cost_price"),
    }))
    .filter((log) => log.beforeSelling !== log.afterSelling || (canSeeCost && log.beforeCost !== log.afterCost));

  return (
    <>
      <PageHeader
        title={`${product.name} Movement History`}
        subtitle={`${product.sku ?? "No SKU"} - append-only inventory ledger for this product.`}
        breadcrumbs={[
          { label: "Inventory", href: "/inventory" },
          { label: "Products", href: "/products" },
          { label: product.name },
        ]}
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/products">Back to products</SecondaryButton>
            {canEditProduct ? <SecondaryButton href={`/products/${id}/edit`}>Edit product</SecondaryButton> : null}
            {canEditProduct && product.active && hasBusinessHistory ? (
              <ConfirmDialog
                action={archiveProduct}
                triggerLabel="Archive Product"
                title="Archive product?"
                description="Archived products stay visible in history but are hidden from new purchases, routes, and manual movements."
                confirmLabel="Archive product"
                buttonClassName="btn-secondary"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
            {canEditProduct && !product.active ? (
              <form action={activateProduct}>
                <input type="hidden" name="id" value={id} />
                <button className="btn-secondary">Activate Product</button>
              </form>
            ) : null}
            {canDeleteProduct && !hasBusinessHistory ? (
              <ConfirmDialog
                action={deleteProduct}
                triggerLabel="Delete Product"
                title="Delete product permanently?"
                description="This product has no purchases, movements, route usage, VMS mappings, sales snapshots, or stock snapshots."
                confirmLabel="Delete product"
                buttonClassName="btn-danger"
                confirmButtonClassName="btn-danger"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
          </div>
        }
      />

      {filters.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{filters.error}</div> : null}

      <nav className="mb-6 flex flex-wrap gap-2">
        <Link href="#inventory-movements" className="btn-secondary">Inventory Movements</Link>
        <Link href="#purchases" className="btn-secondary">Purchases</Link>
        <Link href="#sales" className="btn-secondary">Sales</Link>
        <Link href="#price-history" className="btn-secondary">Price History</Link>
      </nav>

      <section className="mb-6 grid gap-4 md:grid-cols-5">
        <div className="surface-card"><div className="text-sm text-slate-500">Current storage quantity</div><div className="mt-1 text-3xl font-semibold">{storageQty}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Units per box</div><div className="mt-1 text-3xl font-semibold">{product.case_quantity ?? 1}</div></div>
        {canSeeCost ? <div className="surface-card"><div className="text-sm text-slate-500">Last purchase cost</div><div className="mt-1 text-2xl font-semibold">{product.last_purchase_cost_lyd === null ? "-" : formatMoney(product.last_purchase_cost_lyd, 4)}</div><div className="mt-2"><ProductSourceBadge source={product.cost_price_source} /></div></div> : null}
        <div className="surface-card"><div className="text-sm text-slate-500">Current selling price</div><div className="mt-1 text-2xl font-semibold">{formatMoney(product.current_selling_price_lyd ?? product.selling_price)}</div><div className="mt-2"><ProductSourceBadge source={product.selling_price_source} /></div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Status</div><div className="mt-2"><StatusBadge status={product.active ? "active" : "inactive"} /></div></div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card"><div className="text-sm text-slate-500">Machines quantity</div><div className="mt-1 text-3xl font-semibold">{machineQty}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Operator bag quantity</div><div className="mt-1 text-3xl font-semibold">{bagQty}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Purchase lines</div><div className="mt-1 text-3xl font-semibold">{purchases.length}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">VMS sales</div><div className="mt-1 text-3xl font-semibold">{sales.length ? lyd(totalSales) : "-"}</div></div>
      </section>

      {canSeeCost ? (
        <section className="mb-6 grid gap-4 md:grid-cols-2">
          <div className="surface-card"><div className="text-sm text-slate-500">Last purchase date</div><div className="mt-1 text-lg font-semibold">{product.last_purchase_date ?? "-"}</div></div>
          <div className="surface-card"><div className="text-sm text-slate-500">Last purchase supplier</div><div className="mt-1 text-lg font-semibold">{lastSupplierName ?? "-"}</div></div>
        </section>
      ) : null}

      <section className="surface-card mb-6">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Source badges</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Product names/codes</div><ProductSourceBadge source={product.import_source} /></div>
          <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Machine selling price</div><ProductSourceBadge source={product.selling_price_source} /></div>
          {canSeeCost ? <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Snacky cost</div><ProductSourceBadge source={product.cost_price_source} /></div> : null}
          <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Last VMS seen</div><div className="text-sm font-medium">{product.last_vms_seen_at ? formatDate(product.last_vms_seen_at) : "-"}</div></div>
        </div>
      </section>

      <section id="inventory-movements" className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Inventory Movements</h2>
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <input name="q" defaultValue={filters.q ?? ""} placeholder="Search notes, user, related IDs..." className="field-input xl:col-span-2" />
          <select name="reason" defaultValue={filters.reason ?? ""} className="field-input">
            <option value="">All reasons</option>
            {movementReasons.map((reason) => <option key={reason} value={reason}>{reason.replaceAll("_", " ")}</option>)}
          </select>
          <select name="user_id" defaultValue={filters.user_id ?? ""} className="field-input">
            <option value="">All users</option>
            {users?.map((user: any) => <option key={user.id} value={user.id}>{user.full_name}</option>)}
          </select>
          <input name="date_from" type="date" defaultValue={filters.date_from ?? ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={filters.date_to ?? ""} className="field-input" />
          <div className="flex gap-2">
            <button className="btn-primary">Filter</button>
            <Link href={`/products/${id}/history`} className="btn-secondary">Reset</Link>
          </div>
        </form>

        {!movements.length ? (
          <EmptyState title="No product movements found" body="Movements appear here only when real inventory_movements rows exist for this product." />
        ) : (
          <DataTable headers={["Date / Time", "Qty", "From", "To", "Reason", "Related", "User", "Notes"]}>
            {movements.map((movement: any) => (
              <tr key={movement.id}>
                <td>{formatDate(movement.created_at)}</td>
                <td className="font-semibold">{movement.quantity}</td>
                <td>{entityLabel(movement.from_entity_type, movement.from_entity_id)}</td>
                <td>{entityLabel(movement.to_entity_type, movement.to_entity_id)}</td>
                <td><StatusBadge status={String(movement.reason).replaceAll("_", " ")} /></td>
                <td>{relatedLabel(movement)}</td>
                <td>{movement.created_by_member?.full_name ?? "-"}</td>
                <td>{movement.notes ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section id="purchases" className="surface-card mb-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Purchases</h2>
        {!purchases.length ? (
          <EmptyState title="No purchase lines" body="Purchase lines appear here when this product exists on real purchase orders." />
        ) : (
          <DataTable headers={["Date", "Receipt", "Supplier", "Status", "Units", "Received", ...(canSeeCost ? ["Unit cost", "Line total"] : [])]}>
            {purchases.map((line: any) => (
              <tr key={line.id}>
                <td>{line.purchase?.order_date ?? new Date(line.created_at).toLocaleDateString("en-US")}</td>
                <td>{line.purchase?.id ? <Link href={`/purchases/${line.purchase.id}`} className="link-secondary">{line.purchase.receipt_number ?? shortId(line.purchase.id)}</Link> : "-"}</td>
                <td>{line.purchase?.supplier?.name ?? "-"}</td>
                <td><StatusBadge status={line.purchase?.status ?? "-"} /></td>
                <td>{line.total_units}</td>
                <td>{line.received_qty}</td>
                {canSeeCost ? <td>{formatMoney(line.unit_cost_lyd, 4)}</td> : null}
                {canSeeCost ? <td>{formatMoney(line.line_total_lyd)}</td> : null}
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section id="sales" className="surface-card mb-6">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Sales</h2>
            <p className="text-sm text-slate-500">Shown only from VMS sales snapshots for this product.</p>
          </div>
          {sales.length ? <div className="text-sm text-slate-600">{totalUnitsSold} units sold</div> : null}
        </div>
        {!sales.length ? (
          <EmptyState title="No VMS sales data" body="Sales history appears here after VMS sales snapshots exist for this product." />
        ) : (
          <DataTable headers={["Period end", "Machine", "Units sold", "Sales", "Cash", "Card"]}>
            {sales.map((sale: any) => (
              <tr key={sale.id}>
                <td>{formatDate(sale.period_end)}</td>
                <td>{sale.machine?.name ?? "-"}{sale.machine?.machine_code ? <div className="text-xs text-slate-500">{sale.machine.machine_code}</div> : null}</td>
                <td>{sale.sold_qty}</td>
                <td>{formatMoney(sale.sales_amount)}</td>
                <td>{formatMoney(sale.cash_sales_amount)}</td>
                <td>{formatMoney(sale.card_sales_amount)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section id="price-history" className="surface-card">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Price History</h2>
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase text-slate-500">Selling source</div>
            <div className="mt-1"><ProductSourceBadge source={product.selling_price_source} /></div>
          </div>
          {canSeeCost ? <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase text-slate-500">Cost source</div>
            <div className="mt-1"><ProductSourceBadge source={product.cost_price_source} /></div>
          </div> : null}
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium uppercase text-slate-500">Last price update</div>
            <div className="mt-1 text-sm font-medium">{product.price_updated_at ? formatDate(product.price_updated_at) : "-"}</div>
          </div>
        </div>
        {!priceHistory.length ? (
          <EmptyState title="No price change history" body="Price changes will appear here when product activity logs include before and after pricing data." />
        ) : (
          <DataTable headers={["Date / Time", "User", "Action", "Selling before", "Selling after", ...(canSeeCost ? ["Cost before", "Cost after"] : [])]}>
            {priceHistory.map((log: any) => (
              <tr key={log.id}>
                <td>{formatDate(log.created_at)}</td>
                <td>{log.actor_name ?? "-"}</td>
                <td><StatusBadge status={String(log.action).replaceAll("_", " ")} /></td>
                <td>{log.beforeSelling === null ? "-" : formatMoney(log.beforeSelling)}</td>
                <td>{log.afterSelling === null ? "-" : formatMoney(log.afterSelling)}</td>
                {canSeeCost ? <td>{log.beforeCost === null ? "-" : formatMoney(log.beforeCost, 4)}</td> : null}
                {canSeeCost ? <td>{log.afterCost === null ? "-" : formatMoney(log.afterCost, 4)}</td> : null}
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
