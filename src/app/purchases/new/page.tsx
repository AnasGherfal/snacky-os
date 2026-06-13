import { redirect } from "next/navigation";
import { NewPurchaseWithReceiptScan } from "@/components/NewPurchaseWithReceiptScan";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAddProducts, canManagePurchases } from "@/lib/authz";
import { createPurchase } from "@/lib/purchase-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<{ error?: string; module?: string; source?: string }> }) {
  const { error = "", module = "", source = "" } = await searchParams;
  const moduleQuery = module === "finance" ? "?module=finance" : "";
  const profile = await getCurrentProfile();
  if (!profile || !canManagePurchases(profile)) redirect("/unauthorized");

  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  if (!supabase) {
    return (
      <>
        <ErrorState title="Purchase entry unavailable" body="Supabase is not configured, so Snacky OS cannot create purchases." />
      </>
    );
  }
  const [
    { data: suppliers, error: suppliersError },
    { data: products, error: productsError },
    { data: storageRows, error: storageError },
    { data: vmsRows, error: vmsError },
  ] = await Promise.all([
    supabase.from("suppliers").select("id, name").order("name"),
    supabase
      .from("products")
      .select("id, sku, barcode, name, category, brand, case_quantity, cost_price, current_cost_price_lyd, last_purchase_cost_lyd, last_purchase_date, last_supplier_id, image_url, last_supplier:suppliers!products_last_supplier_id_fkey(name)")
      .eq("active", true)
      .order("name"),
    supabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
    supabase.from("vms_product_mappings").select("product_id, vms_product_name").not("product_id", "is", null),
  ]);
  const loadError = suppliersError ?? productsError;
  if (suppliersError) {
    console.error("[purchases:new] Could not load suppliers", {
      table_or_view: "suppliers",
      supabase_error: suppliersError,
      current_user_id: profile.id,
      user_roles: profile.roles,
      organization_id: null,
      query_parameters: { select: "id, name", order: "name" },
    });
  }
  if (productsError) {
    console.error("[purchases:new] Could not load products", {
      table_or_view: "products",
      supabase_error: productsError,
      current_user_id: profile.id,
      user_roles: profile.roles,
      organization_id: null,
      query_parameters: { active: true, order: "name" },
    });
  }
  const enrichmentError = storageError ?? vmsError;
  if (storageError) {
    console.warn("[purchases:new] Purchase storage enrichment could not load", {
      table_or_view: "current_inventory_by_location",
      supabase_error: storageError,
      current_user_id: profile.id,
      user_roles: profile.roles,
      organization_id: null,
      query_parameters: { location_type: "storage" },
    });
  }
  if (vmsError) {
    console.warn("[purchases:new] Purchase VMS enrichment could not load", {
      table_or_view: "vms_product_mappings",
      supabase_error: vmsError,
      current_user_id: profile.id,
      user_roles: profile.roles,
      organization_id: null,
      query_parameters: { product_id: "not null" },
    });
  }

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

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="New purchase"
          subtitle="Record supplier stock and receive it into storage."
          breadcrumbs={[
            { label: module === "finance" ? "Finance" : "Inventory", href: module === "finance" ? "/finance" : "/inventory" },
            { label: "Purchases", href: `/purchases${moduleQuery}` },
            { label: "New purchase" },
          ]}
          action={<SecondaryButton href={`/purchases${moduleQuery}`}>Back</SecondaryButton>}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        {loadError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Product or supplier lists could not fully load. You can keep the draft on screen, retry the page, or continue once the lists appear.
          </div>
        ) : null}
        <NewPurchaseWithReceiptScan
          action={createPurchase}
          suppliers={suppliers ?? []}
          products={productOptions}
          canAddProducts={canAddProducts(profile)}
          prefillSource={source || null}
        />
      </FormPageLayout>
    </>
  );
}
