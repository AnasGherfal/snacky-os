import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
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
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error = "" } = await searchParams;
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role) && !isSupervisorRole(profile?.role) && profile?.role !== "warehouse") redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: purchase }, { data: lines }, { data: suppliers }, { data: products }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, supplier_id, status, order_date, receipt_number, payment_method, receipt_url, notes, manual_total_lyd")
      .eq("id", id)
      .single(),
    supabase
      .from("purchase_order_lines")
      .select("id, line_position, product_id, boxes_qty, units_per_box, loose_units_qty, unit_cost, line_total, unit_cost_lyd, line_total_lyd")
      .eq("purchase_order_id", id)
      .order("line_position")
      .order("created_at"),
    supabase.from("suppliers").select("id, name").order("name"),
    supabase.from("products").select("id, sku, name, category, brand, case_quantity").eq("active", true).order("name"),
  ]);

  if (!purchase) notFound();
  if ((purchase as any).status !== "draft") redirect(`/purchases/${id}?error=Only%20draft%20purchases%20can%20be%20edited.`);

  const productOptions = (products ?? []).map((product: any) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    brand: product.brand,
    caseQuantity: Number(product.case_quantity ?? 1) || 1,
    costPrice: 0,
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
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Edit purchase" subtitle="Update draft receipt details, totals, and purchased items before receiving." action={<SecondaryButton href={`/purchases/${id}`}>Back to purchase</SecondaryButton>} />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <PurchaseForm
          action={updatePurchase}
          suppliers={suppliers ?? []}
          products={productOptions}
          initialPurchase={{
            id,
            supplierId: (purchase as any).supplier_id,
            purchaseDate: (purchase as any).order_date,
            receiptNumber: (purchase as any).receipt_number,
            paymentMethod: (purchase as any).payment_method,
            receiptUrl: (purchase as any).receipt_url,
            notes: (purchase as any).notes,
            manualTotalLyd: (purchase as any).manual_total_lyd === null ? null : Number((purchase as any).manual_total_lyd),
          }}
          initialLines={initialLines}
          submitLabel="Save changes"
        />
      </FormPageLayout>
    </AppShell>
  );
}
