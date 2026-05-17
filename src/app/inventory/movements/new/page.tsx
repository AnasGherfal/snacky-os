import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { StockMovementForm } from "@/components/StockMovementForm";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials, isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewStockMovementPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/inventory/movements/new")) {
    redirect("/unauthorized");
  }

  const { error } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: products }, { data: storageRows }, { data: storages }, { data: operators }, { data: routes }, { data: recentMovements }] = supabase
    ? await Promise.all([
        supabase.from("products").select("id, sku, barcode, name, category, brand, image_url, selling_price, current_selling_price_lyd").eq("active", true).order("name"),
        supabase.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
        supabase.from("storage_locations").select("id, name").eq("active", true).order("name"),
        supabase.from("team_members").select("id, full_name").eq("role", "operator").eq("active", true).order("full_name"),
        supabase.from("routes").select("id, route_date, operator_id, status").in("status", ["draft", "assigned", "in_progress"]).order("route_date", { ascending: false }),
        supabase.from("inventory_movements").select("product_id, created_at").order("created_at", { ascending: false }).limit(100),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const storageByProduct = new Map<string, number>();
  (storageRows ?? []).forEach((row: any) => {
    const productId = String(row.product_id);
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
  });
  const productOptions = (products ?? []).map((product: any) => ({
    id: product.id,
    sku: product.sku,
    barcode: product.barcode,
    name: product.name,
    category: product.category,
    brand: product.brand,
    imageUrl: product.image_url,
    sellingPrice: Number(product.current_selling_price_lyd ?? product.selling_price ?? 0),
    storageQty: storageByProduct.get(String(product.id)) ?? 0,
  }));
  const operatorById = Object.fromEntries((operators ?? []).map((operator: any) => [operator.id, operator.full_name]));
  const recentProductIds = Array.from(new Set((recentMovements ?? []).map((row: any) => row.product_id).filter(Boolean))).slice(0, 12);
  const canQuickAddProduct = ["owner", "admin", "supervisor"].includes(profile.role);

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="New Stock Movement" subtitle="Fast ledger movement with searchable product selection." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />

        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">{error}</div> : null}

        <StockMovementForm
          products={productOptions}
          recentProductIds={recentProductIds}
          storages={storages ?? []}
          operators={operators ?? []}
          routes={routes ?? []}
          operatorById={operatorById}
          canSeeSellingPrice={canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })}
          canAdminOverride={isOwnerAdminRole(profile.role)}
          canQuickAddProduct={canQuickAddProduct}
        />
      </FormPageLayout>
    </AppShell>
  );
}
