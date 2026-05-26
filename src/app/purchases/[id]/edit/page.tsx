import { notFound, redirect } from "next/navigation";
import { PurchaseForm } from "@/components/PurchaseForm";
import { FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAddProducts, canManagePurchases } from "@/lib/authz";
import { updatePurchase } from "@/lib/purchase-actions";
import { privateStorageObjectUrl, RECEIPT_IMAGE_BUCKET } from "@/lib/storage-buckets";
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
  if (!profile || !canManagePurchases(profile)) redirect("/unauthorized");

  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
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
      .select("id, supplier_id, status, order_date, receipt_number, payment_method, payment_status, receipt_url, receipt_storage_path, notes, manual_total_lyd")
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
      .select("id, sku, barcode, name, category, brand, case_quantity, cost_price, current_cost_price_lyd, last_purchase_cost_lyd, last_purchase_date, last_supplier_id, image_url, last_supplier:suppliers!products_last_supplier_id_fkey(name)")
      .eq("active", true)
      .order("name"),
    supabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
    supabase.from("vms_product_mappings").select("product_id, vms_product_name").not("product_id", "is", null),
  ]);

  if (purchaseError) console.error("[purchases:edit] Failed to load purchase for edit", { table_or_view: "purchase_orders", purchase_id: id, current_user_id: profile.id, user_roles: profile.roles, supabase_error: purchaseError });
  if (linesError) console.error("[purchases:edit] Failed to load purchase lines for edit", { table_or_view: "purchase_order_lines", purchase_id: id, current_user_id: profile.id, user_roles: profile.roles, supabase_error: linesError });
  const listLoadError = suppliersError ?? productsError;
  if (suppliersError) console.error("[purchases:edit] Failed to load suppliers", { table_or_view: "suppliers", current_user_id: profile.id, user_roles: profile.roles, supabase_error: suppliersError });
  if (productsError) console.error("[purchases:edit] Failed to load products", { table_or_view: "products", current_user_id: profile.id, user_roles: profile.roles, supabase_error: productsError });
  const enrichmentError = storageError ?? vmsError;
  if (storageError) console.warn("[purchases:edit] Purchase storage enrichment could not load", { table_or_view: "current_inventory_by_location", current_user_id: profile.id, user_roles: profile.roles, supabase_error: storageError });
  if (vmsError) console.warn("[purchases:edit] Purchase VMS enrichment could not load", { table_or_view: "vms_product_mappings", current_user_id: profile.id, user_roles: profile.roles, supabase_error: vmsError });

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
    lastPurchaseDate: product.last_purchase_date ?? null,
    last_purchase_date: product.last_purchase_date ?? null,
    lastSupplierId: product.last_supplier_id ?? null,
    last_supplier_id: product.last_supplier_id ?? null,
    lastSupplierName: product.last_supplier?.name ?? null,
    last_supplier_name: product.last_supplier?.name ?? null,
    currentStorageQty: storageQtyByProduct.get(product.id) ?? 0,
    vmsNames: vmsNamesByProduct.get(product.id) ?? [],
  }));

  const initialLines = (lines ?? []).map((line: any) => ({
    productId: line.product_id,
    boxesQty: Number(line.boxes_qty ?? 0),
    unitsPerBox: Number(line.units_per_box ?? 1),
    looseUnitsQty: Number(line.loose_units_qty ?? 0),
    unitCost: Number(line.unit_cost_lyd ?? line.unit_cost ?? 0),
    unitCostBlank: false,
    unitCostZeroConfirmed: Number(line.unit_cost_lyd ?? line.unit_cost ?? 0) === 0,
    unitCostSource: "manual" as const,
    lineTotal: Number(line.line_total_lyd ?? line.line_total ?? 0),
    pricingMode: "total" as const,
  }));
  const initialReceiptUrl = String((purchase as any).receipt_url ?? "").trim() || privateStorageObjectUrl(RECEIPT_IMAGE_BUCKET, (purchase as any).receipt_storage_path) || "";

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
          canAddProducts={canAddProducts(profile)}
          initialPurchase={{
            id,
            supplierId: (purchase as any).supplier_id,
            purchaseDate: (purchase as any).order_date,
            receiptNumber: (purchase as any).receipt_number,
            paymentMethod: (purchase as any).payment_method,
            paymentStatus: (purchase as any).payment_status,
            receiptUrl: initialReceiptUrl,
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
