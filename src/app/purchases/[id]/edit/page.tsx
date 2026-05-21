import { notFound, redirect } from "next/navigation";
import { PurchaseForm } from "@/components/PurchaseForm";
import { FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { updatePurchase } from "@/lib/purchase-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function EditPurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; module?: string }>;
}) {
  const { id } = await params;
  const { error = "", module = "" } = await searchParams;
  const moduleQuery = module === "finance" ? "?module=finance" : "";
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role) && !isSupervisorRole(profile?.role) && profile?.role !== "warehouse") redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [
    { data: purchase, error: purchaseError },
    { data: lines, error: linesError },
    { data: suppliers, error: suppliersError },
    { data: products, error: productsError },
    { data: storageRows, error: storageError },
    { data: vmsRows, error: vmsError },
  ] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, supplier_id, status, order_date, receipt_number, payment_method, payment_status, receipt_url, notes, manual_total_lyd")
      .eq("id", id)
      .single(),
    supabase
      .from("purchase_order_lines")
      .select("id, line_position, product_id, boxes_qty, units_per_box, loose_units_qty, unit_cost, line_total, unit_cost_lyd, line_total_lyd")
      .eq("purchase_order_id", id)
      .order("line_position")
      .order("created_at"),
    supabase.from("suppliers").select("id, name").order("name"),
    supabase
      .from("products")
      .select("id, sku, barcode, name, category, brand, case_quantity, cost_price, current_cost_price_lyd, last_purchase_cost_lyd, image_url")
      .eq("active", true)
      .order("name"),
    supabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
    supabase.from("vms_product_mappings").select("product_id, vms_product_name").not("product_id", "is", null),
  ]);

  if (purchaseError) console.error("[purchases] Failed to load purchase for edit", purchaseError);
  if (linesError) console.error("[purchases] Failed to load purchase lines for edit", linesError);
  const listLoadError = suppliersError ?? productsError;
  if (listLoadError) console.error("[purchases] Failed to load purchase edit lists", listLoadError);
  const enrichmentError = storageError ?? vmsError;
  if (enrichmentError) console.warn("[purchases] Purchase product enrichment could not fully load", enrichmentError);

  if (!purchase) notFound();
  if ((purchase as any).status !== "draft") redirect(`/purchases/${id}${moduleQuery ? `${moduleQuery}&` : "?"}error=Only%20draft%20purchases%20can%20be%20edited.`);

  const storageQtyByProduct = new Map<string, number>();
  for (const row of storageRows ?? []) {
    const productId = String((row as any).product_id || "");
    if (!productId) continue;
    storageQtyByProduct.set(productId, (storageQtyByProduct.get(productId) ?? 0) + Number((row as any).quantity_on_hand ?? 0));
  }

  const vmsNamesByProduct = new Map<string, string[]>();
  for (const row of vmsRows ?? []) {
    const productId = String((row as any).product_id || "");
    const name = String((row as any).vms_product_name || "").trim();
    if (!productId || !name) continue;
    const names = vmsNamesByProduct.get(productId) ?? [];
    if (!names.includes(name)) names.push(name);
    vmsNamesByProduct.set(productId, names);
  }

  const productOptions = (products ?? []).map((product: any) => ({
    id: product.id,
    sku: product.sku,
    barcode: product.barcode,
    imageUrl: product.image_url,
    name: product.name,
    category: product.category,
    brand: product.brand,
    caseQuantity: Number(product.case_quantity ?? 1) || 1,
    case_quantity: Number(product.case_quantity ?? 1) || 1,
    unitsPerBox: product.units_per_box === undefined || product.units_per_box === null ? null : Number(product.units_per_box),
    units_per_box: product.units_per_box === undefined || product.units_per_box === null ? null : Number(product.units_per_box),
    costPrice: Number(product.current_cost_price_lyd ?? product.cost_price ?? 0),
    currentCostPrice: product.current_cost_price_lyd === null ? null : Number(product.current_cost_price_lyd ?? 0),
    current_cost_price_lyd: product.current_cost_price_lyd === null ? null : Number(product.current_cost_price_lyd ?? 0),
    lastPurchaseCost: product.last_purchase_cost_lyd === null ? null : Number(product.last_purchase_cost_lyd ?? 0),
    last_purchase_cost_lyd: product.last_purchase_cost_lyd === null ? null : Number(product.last_purchase_cost_lyd ?? 0),
    currentStorageQty: storageQtyByProduct.get(product.id) ?? 0,
    vmsNames: vmsNamesByProduct.get(product.id) ?? [],
  }));

  const initialLines = (lines ?? []).map((line: any) => ({
    productId: line.product_id,
    boxesQty: Number(line.boxes_qty ?? 0),
    unitsPerBox: Number(line.units_per_box ?? 1),
    looseUnitsQty: Number(line.loose_units_qty ?? 0),
    unitCost: Number(line.unit_cost_lyd ?? line.unit_cost ?? 0),
    lineTotal: Number(line.line_total_lyd ?? line.line_total ?? 0),
    pricingMode: "total" as const,
  }));

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Edit purchase"
          subtitle="Update draft receipt details, totals, and purchased items before receiving."
          breadcrumbs={[
            { label: module === "finance" ? "Finance" : "Inventory", href: module === "finance" ? "/finance" : "/inventory" },
            { label: "Purchases", href: `/purchases${moduleQuery}` },
            { label: (purchase as any).receipt_number ?? id.slice(0, 8), href: `/purchases/${id}${moduleQuery}` },
            { label: "Edit purchase" },
          ]}
          action={<SecondaryButton href={`/purchases/${id}${moduleQuery}`}>Back to purchase</SecondaryButton>}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        {listLoadError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Product or supplier lists could not fully load. The draft stayed on screen; retry the page before saving if a product is missing.
          </div>
        ) : null}
        <PurchaseForm
          action={updatePurchase}
          suppliers={suppliers ?? []}
          products={productOptions}
          canAddProducts={isOwnerAdminRole(profile?.role)}
          initialPurchase={{
            id,
            supplierId: (purchase as any).supplier_id,
            purchaseDate: (purchase as any).order_date,
            receiptNumber: (purchase as any).receipt_number,
            paymentMethod: (purchase as any).payment_method,
            paymentStatus: (purchase as any).payment_status,
            receiptUrl: (purchase as any).receipt_url,
            notes: (purchase as any).notes,
            manualTotalLyd: (purchase as any).manual_total_lyd === null ? null : Number((purchase as any).manual_total_lyd),
          }}
          initialLines={initialLines}
          submitLabel="Save changes"
        />
      </FormPageLayout>
    </>
  );
}
