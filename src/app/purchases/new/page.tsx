import { redirect } from "next/navigation";
import { NewPurchaseWithReceiptScan } from "@/components/NewPurchaseWithReceiptScan";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { createPurchase } from "@/lib/purchase-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<{ error?: string; module?: string }> }) {
  const { error = "", module = "" } = await searchParams;
  const moduleQuery = module === "finance" ? "?module=finance" : "";
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role) && !isSupervisorRole(profile?.role) && profile?.role !== "warehouse") redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
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
      .select("id, sku, barcode, name, category, brand, case_quantity, cost_price, current_cost_price_lyd, last_purchase_cost_lyd, image_url")
      .eq("active", true)
      .order("name"),
    supabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
    supabase.from("vms_product_mappings").select("product_id, vms_product_name").not("product_id", "is", null),
  ]);
  const loadError = suppliersError ?? productsError;
  if (loadError) console.error("[purchases] Failed to load new purchase form lists", loadError);
  const enrichmentError = storageError ?? vmsError;
  if (enrichmentError) console.warn("[purchases] Purchase product enrichment could not fully load", enrichmentError);

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
    costPrice: Number(product.current_cost_price_lyd ?? product.cost_price ?? 0),
    lastPurchaseCost: product.last_purchase_cost_lyd === null ? null : Number(product.last_purchase_cost_lyd ?? 0),
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
        <NewPurchaseWithReceiptScan action={createPurchase} suppliers={suppliers ?? []} products={productOptions} canAddProducts={isOwnerAdminRole(profile?.role)} />
      </FormPageLayout>
    </>
  );
}
