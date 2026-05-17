import { AppShell } from "@/components/AppShell";
import { PurchaseForm } from "@/components/PurchaseForm";
import { FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { createPurchase } from "@/lib/purchase-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error = "" } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: suppliers }, { data: products }] = supabase
    ? await Promise.all([
        supabase.from("suppliers").select("id, name").order("name"),
        supabase.from("products").select("id, sku, name, category, brand, case_quantity").eq("active", true).order("name"),
      ])
    : [{ data: [] }, { data: [] }];

  const productOptions = (products ?? []).map((product: any) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    brand: product.brand,
    caseQuantity: Number(product.case_quantity ?? 1) || 1,
    costPrice: 0,
  }));

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="New purchase" subtitle="Record supplier stock and receive it into storage." action={<SecondaryButton href="/purchases">Back</SecondaryButton>} />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <PurchaseForm action={createPurchase} suppliers={suppliers ?? []} products={productOptions} />
      </FormPageLayout>
    </AppShell>
  );
}
