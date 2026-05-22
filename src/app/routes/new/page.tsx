import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { RouteCreateForm } from "@/app/routes/new/RouteCreateForm";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewRoutePage() {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes/new")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Route creation unavailable" body="Supabase is not configured, so Snacky OS cannot create routes." action={<SecondaryButton href="/routes">Back to routes</SecondaryButton>} />
      </>
    );
  }
  const [
    { data: operators, error: operatorsError },
    { data: machines, error: machinesError },
    { data: recommendations, error: recommendationsError },
    { data: storageInventory, error: storageError },
    { data: reservedStock, error: reservedError },
    { data: products, error: productsError },
    { data: recentMovements, error: movementsError },
  ] = await Promise.all([
    supabase.from("team_members").select("id, full_name, role, roles").or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}").eq("active", true).order("full_name"),
    supabase.from("machines").select("id, name, machine_code").eq("status", "active").order("name"),
    supabase
      .from("refill_recommendations")
      .select("recommendation_key, machine_slot_id, machine_id, machine_name, machine_code, slot_code, product_id, product_name, current_qty, capacity, par_qty, suggested_qty, available_storage_qty, final_qty_to_take, priority")
      .order("machine_name"),
    supabase
      .from("current_inventory_by_location")
      .select("product_id, product_name, quantity_on_hand")
      .eq("location_type", "storage")
      .gt("quantity_on_hand", 0)
      .order("product_name"),
    supabase
      .from("route_stock_lines")
      .select("product_id, planned_qty, picked_qty, routes!inner(status)")
      .in("routes.status", ["draft", "assigned"]),
    supabase.from("products").select("id, sku, barcode, name, category, brand, image_url, active").eq("active", true).order("name"),
    supabase.from("inventory_movements").select("product_id, created_at").order("created_at", { ascending: false }).limit(80),
  ]);
  const loadError = operatorsError ?? machinesError ?? recommendationsError ?? storageError ?? reservedError ?? productsError ?? movementsError;
  if (loadError) {
    console.error("[routes:new] Failed to load route creation data", loadError);
    return (
      <>
        <ErrorState title="Could not load route builder" body="Snacky OS could not load operators, machines, recommendations, storage, or products for route creation." action={<SecondaryButton href="/routes/new">Retry</SecondaryButton>} />
      </>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const activeProductIds = new Set((products ?? []).map((product: any) => product.id));
  const activeRecommendations = (recommendations ?? []).filter((recommendation: any) => activeProductIds.has(recommendation.product_id));
  const storageByProduct = new Map<string, { product_id: string; product_name: string; quantity_on_hand: number }>();
  (storageInventory ?? []).forEach((row: any) => {
    const current = storageByProduct.get(row.product_id);
    storageByProduct.set(row.product_id, {
      product_id: row.product_id,
      product_name: row.product_name,
      quantity_on_hand: (current?.quantity_on_hand ?? 0) + Number(row.quantity_on_hand ?? 0),
    });
  });
  const reservedByProduct = new Map<string, number>();
  (reservedStock ?? []).forEach((row: any) => {
    const reserved = Math.max(0, Number(row.planned_qty ?? 0) - Number(row.picked_qty ?? 0));
    reservedByProduct.set(row.product_id, (reservedByProduct.get(row.product_id) ?? 0) + reserved);
  });
  const availableStorage = Array.from(storageByProduct.values())
    .map((row) => ({ ...row, quantity_on_hand: Math.max(0, row.quantity_on_hand - (reservedByProduct.get(row.product_id) ?? 0)) }))
    .filter((row) => row.quantity_on_hand > 0);
  const availableByProduct = new Map(availableStorage.map((row) => [row.product_id, row.quantity_on_hand]));
  const productCatalog = (products ?? [])
    .map((product: any) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      category: product.category,
      brand: product.brand,
      imageUrl: product.image_url,
      availableQty: availableByProduct.get(product.id) ?? 0,
      storageQty: storageByProduct.get(product.id)?.quantity_on_hand ?? 0,
    }));
  const recentProductIds = Array.from(new Set((recentMovements ?? []).map((row: any) => row.product_id).filter(Boolean))).slice(0, 12);

  return (
    <>
      <FormPageLayout>
        <PageHeader title="Create route" subtitle="Build a route with stops, refill recommendations, or a fast manual pick list from storage." />
        <RouteCreateForm
          operators={operators ?? []}
          machines={machines ?? []}
          recommendations={activeRecommendations}
          storageInventory={availableStorage}
          products={productCatalog}
          recentProductIds={recentProductIds}
          allowAdminOverride={isOwnerAdminRole(profile)}
          defaultRouteDate={today}
        />
      </FormPageLayout>
    </>
  );
}
