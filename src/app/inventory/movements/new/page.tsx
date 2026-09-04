import { redirect } from "next/navigation";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { StockMovementForm } from "@/components/StockMovementForm";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canAddProducts, canViewFinancials, isOwnerAdminRole } from "@/lib/authz";
import { isRouteReservationStatus } from "@/lib/route-workflow";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewStockMovementPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  const userContext = profile
    ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }
    : null;
  if (!profile || !canAccessPath(userContext, "/inventory/movements/new")) {
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
        <PageHeader title="New Stock Movement" subtitle="Fast ledger movement with searchable product selection." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />
        <ErrorState
          title="Could not load stock quantities"
          body="Snacky OS could not connect to inventory. No product has been shown as zero. Refresh this page before recording a movement."
          action={<SecondaryButton href="/inventory/movements/new">Retry</SecondaryButton>}
        />
      </FormPageLayout>
    );
  }

  const [productsResult, storageResult, storagesResult, operatorsResult, routesResult, recentMovementsResult] = await Promise.all([
    inventoryReadClient.from("products").select("id, sku, barcode, name, category, brand, image_url, selling_price, current_selling_price_lyd").eq("active", true).order("name"),
    inventoryReadClient.from("current_inventory_by_location").select("product_id, quantity_on_hand").eq("location_type", "storage"),
    inventoryReadClient.from("storage_locations").select("id, name").eq("active", true).in("location_type", ["main_storage", "vehicle", "temporary", "other"]).order("name"),
    inventoryReadClient.from("team_members").select("id, full_name").or("role.eq.operator,roles.cs.{operator}").eq("active", true).order("full_name"),
    inventoryReadClient.from("routes").select("id, route_date, operator_id, status").order("route_date", { ascending: false }),
    inventoryReadClient.from("inventory_movements").select("product_id, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  const stockError = productsResult.error ?? storageResult.error;
  if (stockError) {
    console.error("[inventory:movements:new] Failed to load verified product stock", stockError);
    return (
      <FormPageLayout>
        <PageHeader title="New Stock Movement" subtitle="Fast ledger movement with searchable product selection." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />
        <ErrorState
          title="Could not load stock quantities"
          body="Snacky OS could not verify the current storage balance. No product has been shown as zero. Refresh this page before recording a movement."
          action={<SecondaryButton href="/inventory/movements/new">Retry</SecondaryButton>}
        />
      </FormPageLayout>
    );
  }

  const supportingErrors = [storagesResult.error, operatorsResult.error, routesResult.error, recentMovementsResult.error].filter(Boolean);
  if (supportingErrors.length) {
    console.warn("[inventory:movements:new] Optional movement context was unavailable", supportingErrors);
  }

  const products = productsResult.data ?? [];
  const storageRows = storageResult.data ?? [];
  const storages = storagesResult.data ?? [];
  const operators = operatorsResult.data ?? [];
  const routes = routesResult.data ?? [];
  const recentMovements = recentMovementsResult.data ?? [];

  const storageByProduct = new Map<string, number>();
  storageRows.forEach((row: any) => {
    const productId = String(row.product_id);
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
  });
  const productOptions = products.map((product: any) => ({
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
  const operatorById = Object.fromEntries(operators.map((operator: any) => [operator.id, operator.full_name]));
  const recentProductIds = Array.from(new Set(recentMovements.map((row: any) => row.product_id).filter(Boolean))).slice(0, 12);
  const canQuickAddProduct = canAddProducts(profile);

  return (
    <>
      <FormPageLayout>
        <PageHeader title="New Stock Movement" subtitle="Fast ledger movement with searchable product selection." action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>} />

        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">{error}</div> : null}

        <StockMovementForm
          products={productOptions}
          recentProductIds={recentProductIds}
          storages={storages}
          operators={operators}
          routes={routes.filter((route: any) => isRouteReservationStatus(route.status))}
          operatorById={operatorById}
          canSeeSellingPrice={canViewFinancials(userContext)}
          canAdminOverride={isOwnerAdminRole(profile)}
          canQuickAddProduct={canQuickAddProduct}
        />
      </FormPageLayout>
    </>
  );
}
