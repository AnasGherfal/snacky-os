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
  const [{ data: suppliers, error: suppliersError }, { data: products, error: productsError }] = await Promise.all([
    supabase.from("suppliers").select("id, name").order("name"),
    supabase.from("products").select("id, sku, barcode, name, category, brand, case_quantity").eq("active", true).order("name"),
  ]);
  const loadError = suppliersError ?? productsError;
  if (loadError) console.error("[purchases] Failed to load new purchase form lists", loadError);

  const productOptions = (products ?? []).map((product: any) => ({
    id: product.id,
    sku: product.sku,
    barcode: product.barcode,
    name: product.name,
    category: product.category,
    brand: product.brand,
    caseQuantity: Number(product.case_quantity ?? 1) || 1,
    costPrice: 0,
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
