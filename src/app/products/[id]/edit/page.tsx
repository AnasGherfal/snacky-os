import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/AppShell";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { ProductSourceBadge } from "@/components/ProductSourceBadge";
import { DataTable, EmptyState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { resolveProductImageUrl } from "@/lib/product-images";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

async function updateProduct(fd: FormData) {
  "use server";
  const s = getSupabaseServerClient();
  if (!s) return;
  const profile = await getCurrentProfile();

  const id = String(fd.get("id"));
  const { data: beforeProduct } = await s.from("products").select("*").eq("id", id).maybeSingle();
  const currentImageUrl = String(fd.get("current_image_url") || "").trim();
  const { imageUrl, uploadUnavailable } = await resolveProductImageUrl(s, fd);
  const nextName = String(fd.get("name") || "").trim();
  const nextCost = Number(fd.get("current_cost_price_lyd") || 0);
  const nextSelling = Number(fd.get("current_selling_price_lyd") || 0);
  const previousCost = Number(beforeProduct?.current_cost_price_lyd ?? beforeProduct?.cost_price ?? 0);
  const previousSelling = Number(beforeProduct?.current_selling_price_lyd ?? beforeProduct?.selling_price ?? 0);
  const costChanged = nextCost !== previousCost;
  const sellingChanged = nextSelling !== previousSelling;
  const product: Record<string, unknown> = {
    sku: String(fd.get("sku") || "").trim(),
    barcode: String(fd.get("barcode") || "") || null,
    name: nextName,
    category: String(fd.get("category") || "snack"),
    brand: String(fd.get("brand") || "") || null,
    supplier_id: String(fd.get("supplier_id") || "") || null,
    case_quantity: Number(fd.get("case_quantity") || 1),
    image_url: (imageUrl ?? currentImageUrl) || null,
    active: String(fd.get("active") || "true") === "true",
  };
  if (costChanged) {
    Object.assign(product, {
      cost_price: nextCost,
      current_cost_price_lyd: nextCost,
      cost_price_source: "manual",
      price_updated_at: new Date().toISOString(),
    });
  }
  if (sellingChanged) {
    Object.assign(product, {
      selling_price: nextSelling,
      current_selling_price_lyd: nextSelling,
      selling_price_source: "manual",
      price_updated_at: new Date().toISOString(),
    });
  }

  const { data: afterProduct } = await s.from("products").update(product).eq("id", id).select("id, sku, name, category, brand, active, current_cost_price_lyd, current_selling_price_lyd, cost_price_source, selling_price_source").maybeSingle();
  await logActivity({
    profile,
    action: "update",
    entityType: "product",
    entityId: id,
    entityLabel: afterProduct?.name ?? nextName,
    beforeData: beforeProduct,
    afterData: afterProduct ?? product,
    summary: `Updated product ${afterProduct?.name ?? nextName}`,
  });
  revalidatePath("/products");
  revalidatePath(`/products/${id}/edit`);
  redirect(uploadUnavailable ? "/products?imageUpload=storage-unavailable" : "/products");
}

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = getSupabaseServerClient();
  if (!s) notFound();

  const [{ data: product }, { data: suppliers }, { data: inventory }, { data: movements }, { data: purchaseLines }, { data: sales }] = await Promise.all([
    s.from("products").select("*").eq("id", id).single(),
    s.from("suppliers").select("id,name").order("name"),
    s.from("current_inventory_by_location").select("location_type, location_name, quantity_on_hand").eq("product_id", id).order("location_type"),
    s
      .from("inventory_movements")
      .select("id, quantity, from_entity_type, to_entity_type, reason, related_route_id, related_purchase_id, related_machine_id, notes, created_at, created_by_member:team_members(full_name)")
      .eq("product_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    s
      .from("purchase_order_lines")
      .select("id, total_units, unit_cost_lyd, line_total_lyd, purchase:purchase_orders(id, receipt_number, order_date, status, supplier:suppliers(name))")
      .eq("product_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    s
      .from("vms_sales_snapshots")
      .select("id, sold_qty, sales_amount, cash_sales_amount, card_sales_amount, period_end, machine:machines(name)")
      .eq("product_id", id)
      .order("period_end", { ascending: false })
      .limit(100),
  ]);
  if (!product) notFound();
  const inventoryRows = (inventory ?? []) as any[];
  const quantityFor = (type: string) => inventoryRows.filter((row) => row.location_type === type).reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader title={product.name} subtitle="Product profile, pricing, inventory, movement history, sales, and purchases." action={<SecondaryButton href={`/products/${id}/history`}>Movement History</SecondaryButton>} />

        <nav className="flex flex-wrap gap-2">
          {["Overview", "Pricing", "Inventory", "Movement History", "Sales", "Purchases"].map((label) => (
            <a key={label} href={`#${label.toLowerCase().replaceAll(" ", "-")}`} className="btn-secondary">{label}</a>
          ))}
        </nav>

        <section id="overview" className="grid gap-4 md:grid-cols-3">
          <div className="surface-card">
            <div className="text-sm text-slate-500">Storage quantity</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{quantityFor("storage")}</div>
          </div>
          <div className="surface-card">
            <div className="text-sm text-slate-500">Machine quantity</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{quantityFor("machine")}</div>
          </div>
          <div className="surface-card">
            <div className="text-sm text-slate-500">Operator bag quantity</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{quantityFor("operator_bag")}</div>
          </div>
        </section>

        <section id="pricing" className="grid gap-4 md:grid-cols-3">
          <div className="surface-card"><div className="text-sm text-slate-500">Last purchase cost</div><div className="mt-1 text-2xl font-semibold">{lyd(Number(product.last_purchase_cost_lyd ?? product.current_cost_price_lyd ?? 0))}</div><div className="mt-2"><ProductSourceBadge source={product.cost_price_source} /></div></div>
          <div className="surface-card"><div className="text-sm text-slate-500">Average cost</div><div className="mt-1 text-2xl font-semibold">{product.average_cost_lyd === null ? "-" : lyd(Number(product.average_cost_lyd))}</div><div className="mt-2"><ProductSourceBadge source={product.cost_price_source} /></div></div>
          <div className="surface-card"><div className="text-sm text-slate-500">Current selling price</div><div className="mt-1 text-2xl font-semibold">{lyd(Number(product.current_selling_price_lyd ?? product.selling_price ?? 0))}</div><div className="mt-2"><ProductSourceBadge source={product.selling_price_source} /></div></div>
        </section>

        <section className="surface-card">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Source badges</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Product names/codes</div><ProductSourceBadge source={product.import_source} /></div>
            <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Machine selling price</div><ProductSourceBadge source={product.selling_price_source} /></div>
            <div><div className="mb-1 text-xs font-medium uppercase text-slate-500">Snacky cost</div><ProductSourceBadge source={product.cost_price_source} /></div>
          </div>
        </section>

        <FormPageLayout>
        <form action={updateProduct} className="space-y-5">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="current_image_url" value={product.image_url || ""} />
          <FormSection title="Product details">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="SKU" required><input required name="sku" defaultValue={product.sku} className="field-input" /></FormField>
              <FormField label="Barcode"><input name="barcode" defaultValue={product.barcode || ""} className="field-input" /></FormField>
              <FormField label="Product Name" required><input required name="name" defaultValue={product.name} className="field-input" /></FormField>
              <FormField label="Category" required><select name="category" defaultValue={product.category} className="field-input"><option>drink</option><option>snack</option><option>chocolate</option><option>biscuit</option><option>coffee</option><option>other</option></select></FormField>
              <FormField label="Brand"><input name="brand" defaultValue={product.brand || ""} className="field-input" /></FormField>
              <FormField label="Supplier"><select name="supplier_id" defaultValue={product.supplier_id || ""} className="field-input"><option value="">Select supplier</option>{suppliers?.map((supplier: any) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></FormField>
              <FormField label="Current Cost Price LYD" hint="Manual changes relabel cost source as Manual. Purchase receiving remains the preferred cost source."><input type="number" step="0.0001" name="current_cost_price_lyd" defaultValue={product.current_cost_price_lyd ?? product.cost_price ?? 0} className="field-input" /></FormField>
              <FormField label="Current Selling Price LYD" hint="Manual changes relabel selling source as Manual. VMS Product List remains the preferred machine selling source."><input type="number" step="0.01" name="current_selling_price_lyd" defaultValue={product.current_selling_price_lyd ?? product.selling_price ?? 0} className="field-input" /></FormField>
              <FormField label="VMS Selling Price LYD" hint="Updated by VMS imports when the file provides a selling price."><input value={formatMoney(product.vms_selling_price_lyd)} readOnly className="field-input bg-slate-50" /></FormField>
              <FormField label="Last Purchase Cost LYD" hint="Updated when a purchase is received."><input value={formatMoney(product.last_purchase_cost_lyd, 4)} readOnly className="field-input bg-slate-50" /></FormField>
              <FormField label="Average Cost LYD" hint="Reserved for weighted average cost once enabled."><input value={formatMoney(product.average_cost_lyd, 4)} readOnly className="field-input bg-slate-50" /></FormField>
              <FormField label="Case Quantity"><input type="number" name="case_quantity" defaultValue={product.case_quantity ?? 1} className="field-input" /></FormField>
              <FormField label="Active"><select name="active" defaultValue={String(product.active)} className="field-input"><option value="true">Active</option><option value="false">Inactive</option></select></FormField>
            </div>
          </FormSection>

          <FormSection title="Product image">
            <div className="grid gap-4 md:grid-cols-[auto_1fr_1fr]">
              <div>
                <span className="mb-1 block text-sm font-medium text-slate-800">Current</span>
                <ProductThumbnail imageUrl={product.image_url} name={product.name} size="md" />
              </div>
              <FormField label="Upload replacement" hint="Stored in the local product image bucket. PNG, JPG, and WEBP are supported. Maximum 5MB.">
                <input name="image_file" type="file" accept="image/png,image/jpeg,image/webp" className="field-input" />
              </FormField>
              <FormField label="Image URL fallback" hint="Optional public URL if you do not upload a file.">
                <input name="image_url" type="url" defaultValue={product.image_url || ""} placeholder="https://example.com/product.jpg" className="field-input" />
              </FormField>
            </div>
          </FormSection>

          <div className="flex gap-3"><PrimaryButton>Save changes</PrimaryButton><SecondaryButton href="/products">Cancel</SecondaryButton></div>
        </form>
        </FormPageLayout>

        <section id="inventory" className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Inventory by location</h2>
          {!inventoryRows.length ? <EmptyState title="No inventory yet" body="This product has no ledger balance in storage, machine, or operator bag locations." /> : (
            <DataTable headers={["Location type", "Location", "Quantity"]}>
              {inventoryRows.map((row: any, index) => <tr key={`${row.location_type}-${row.location_name}-${index}`}><td><StatusBadge status={row.location_type} /></td><td>{row.location_name}</td><td>{row.quantity_on_hand}</td></tr>)}
            </DataTable>
          )}
        </section>

        <section id="movement-history" className="surface-card">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Movement History</h2>
            <SecondaryButton href={`/inventory/movements?product_id=${id}`}>Open full log</SecondaryButton>
          </div>
          {!movements?.length ? <EmptyState title="No movement history" body="Purchase receiving, route picks, fills, returns, waste, and corrections will appear here." /> : (
            <DataTable headers={["Date", "Qty", "From", "To", "Reason", "Related", "User", "Notes"]}>
              {movements.map((movement: any) => (
                <tr key={movement.id}>
                  <td>{new Date(movement.created_at).toLocaleString("en-US")}</td>
                  <td>{movement.quantity}</td>
                  <td><StatusBadge status={movement.from_entity_type} /></td>
                  <td><StatusBadge status={movement.to_entity_type} /></td>
                  <td><StatusBadge status={movement.reason} /></td>
                  <td>{movement.related_route_id ? `Route ${movement.related_route_id.slice(0, 8)}` : movement.related_purchase_id ? `Purchase ${movement.related_purchase_id.slice(0, 8)}` : movement.related_machine_id ? `Machine ${movement.related_machine_id.slice(0, 8)}` : "-"}</td>
                  <td>{movement.created_by_member?.full_name ?? "-"}</td>
                  <td>{movement.notes ?? "-"}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>

        <section id="sales" className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Sales</h2>
          {!sales?.length ? <EmptyState title="No VMS sales snapshots" body="Sales history appears after VMS sales CSV imports for this product." /> : (
            <DataTable headers={["Period", "Machine", "Units sold", "Sales", "Cash", "Card"]}>
              {sales.map((row: any) => <tr key={row.id}><td>{new Date(row.period_end).toLocaleDateString("en-US")}</td><td>{row.machine?.name ?? "-"}</td><td>{row.sold_qty}</td><td>{lyd(Number(row.sales_amount ?? 0))}</td><td>{lyd(Number(row.cash_sales_amount ?? 0))}</td><td>{lyd(Number(row.card_sales_amount ?? 0))}</td></tr>)}
            </DataTable>
          )}
        </section>

        <section id="purchases" className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Purchases</h2>
          {!purchaseLines?.length ? <EmptyState title="No purchase lines" body="Supplier purchase lines for this product will appear here." /> : (
            <DataTable headers={["Date", "Receipt", "Supplier", "Status", "Units", "Unit cost", "Line total"]}>
              {purchaseLines.map((line: any) => (
                <tr key={line.id}>
                  <td>{line.purchase?.order_date ?? "-"}</td>
                  <td>{line.purchase?.id ? <a className="link-secondary" href={`/purchases/${line.purchase.id}`}>{line.purchase.receipt_number ?? line.purchase.id.slice(0, 8)}</a> : "-"}</td>
                  <td>{line.purchase?.supplier?.name ?? "-"}</td>
                  <td><StatusBadge status={line.purchase?.status ?? "-"} /></td>
                  <td>{line.total_units}</td>
                  <td>{lyd(Number(line.unit_cost_lyd ?? 0))}</td>
                  <td>{lyd(Number(line.line_total_lyd ?? 0))}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
      </div>
    </AppShell>
  );
}
