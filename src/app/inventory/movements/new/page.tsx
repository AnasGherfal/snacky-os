import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { StockMovementForm } from "@/components/StockMovementForm";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAddProducts, canViewFinancials, isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewStockMovementPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  const userContext = profile
    ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }
    : null;
  if (!profile || !isOwnerAdminRole(profile)) {
    redirect("/unauthorized");
  }

  const { error } = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  // Access is already enforced above. Keep expensive inventory aggregates on
  // the protected server client and never turn a failed stock read into zeros.
  const inventoryReadClient = getSupabaseAdminClient() ?? supabase;
  if (!inventoryReadClient) {
    return (
      <FormPageLayout>
        <PageHeader title="New Storage Adjustment" subtitle="Owner/admin physical stock-count correction." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />
        <ErrorState
          title="Could not load stock quantities"
          body="Snacky OS could not connect to inventory. No product has been shown as zero. Refresh this page before recording a movement."
          action={<SecondaryButton href="/inventory/movements/new">Retry</SecondaryButton>}
        />
      </FormPageLayout>
    );
  }

  const [productsResult, storageResult, storagesResult, recentMovementsResult] = await Promise.all([
    inventoryReadClient.from("products").select("id, sku, barcode, name, category, brand, image_url, selling_price, current_selling_price_lyd").eq("active", true).order("name"),
    inventoryReadClient.from("current_inventory_by_location").select("product_id, location_id, quantity_on_hand").eq("location_type", "storage"),
    inventoryReadClient.from("storage_locations").select("id, name").eq("active", true).in("location_type", ["main_storage", "vehicle", "temporary", "other"]).order("name"),
    inventoryReadClient.from("inventory_movements").select("product_id, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  const stockError = productsResult.error ?? storageResult.error ?? storagesResult.error;
  if (stockError) {
    console.error("[inventory:movements:new] Failed to load verified product stock", stockError);
    return (
      <FormPageLayout>
        <PageHeader title="New Storage Adjustment" subtitle="Owner/admin physical stock-count correction." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />
        <ErrorState
          title="Could not load stock quantities"
          body="Snacky OS could not verify the current storage balance. No product has been shown as zero. Refresh this page before recording a movement."
          action={<SecondaryButton href="/inventory/movements/new">Retry</SecondaryButton>}
        />
      </FormPageLayout>
    );
  }

  const supportingErrors = [recentMovementsResult.error].filter(Boolean);
  if (supportingErrors.length) {
    console.warn("[inventory:movements:new] Optional movement context was unavailable", supportingErrors);
  }

  const products = productsResult.data ?? [];
  const storageRows = storageResult.data ?? [];
  const storages = storagesResult.data ?? [];
  const recentMovements = recentMovementsResult.data ?? [];

  const storageByProductLocation = new Map<string, number>();
  storageRows.forEach((row) => {
    const productId = String(row.product_id);
    const locationId = String(row.location_id ?? "");
    if (!productId || !locationId) return;
    const key = `${productId}:${locationId}`;
    storageByProductLocation.set(key, (storageByProductLocation.get(key) ?? 0) + Number(row.quantity_on_hand ?? 0));
  });
  const productOptions = products.map((product) => ({
    id: product.id,
    sku: product.sku,
    barcode: product.barcode,
    name: product.name,
    category: product.category,
    brand: product.brand,
    imageUrl: product.image_url,
    sellingPrice: Number(product.current_selling_price_lyd ?? product.selling_price ?? 0),
    storageQtyByLocationId: Object.fromEntries(storages.map((storage) => [
      String(storage.id),
      storageByProductLocation.get(`${String(product.id)}:${String(storage.id)}`) ?? 0,
    ])),
  }));
  const recentProductIds = Array.from(new Set(recentMovements.map((row) => row.product_id).filter(Boolean))).slice(0, 12);
  const canQuickAddProduct = canAddProducts(profile);

  return (
    <>
      <FormPageLayout>
        <PageHeader title="New Storage Adjustment" subtitle="Owner/admin physical stock-count correction. Route custody changes belong in the related route or stop." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />

        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">{error}</div> : null}

        <StockMovementForm
          initialClientSubmissionId={randomUUID()}
          products={productOptions}
          recentProductIds={recentProductIds}
          storages={storages}
          canSeeSellingPrice={canViewFinancials(userContext)}
          canQuickAddProduct={canQuickAddProduct}
        />
      </FormPageLayout>
    </>
  );
}
