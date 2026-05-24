import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { ROUTE_RESERVATION_STATUSES, isRouteReservationStatus } from "@/lib/route-workflow";
import { RouteCreateForm } from "@/app/routes/new/RouteCreateForm";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function signedQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

type ProductRow = {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  image_url: string | null;
};

type RecommendationRow = {
  recommendation_key: string;
  machine_slot_id: string | null;
  machine_id: string;
  machine_name: string;
  machine_code: string;
  slot_code: string | null;
  product_id: string;
  product_name: string;
  current_qty: number;
  capacity: number | null;
  par_qty: number | null;
  suggested_qty: number | null;
  available_storage_qty: number;
  final_qty_to_take: number | null;
  priority?: string | null;
};

type StorageInventoryRow = {
  product_id: string;
  product_name: string;
  quantity_on_hand: unknown;
};

type ReservedStockRow = {
  product_id: string;
  planned_qty: unknown;
  picked_qty: unknown;
  routes?: { status?: string | null } | null;
};

type RecentMovementRow = {
  product_id: string | null;
};

type RouteBuilderQueryIssue = {
  key: string;
  label: string;
  table: string;
  message: string;
};

function supabaseErrorPayload(error: any) {
  return {
    code: error?.code ?? null,
    message: error?.message ?? String(error ?? "Unknown Supabase error"),
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  };
}

function logRouteBuilderQueryError({
  key,
  label,
  table,
  error,
  profile,
  params,
}: {
  key: string;
  label: string;
  table: string;
  error: any;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  params: Record<string, unknown>;
}) {
  const errorPayload = supabaseErrorPayload(error);
  console.error(`[routes:new] ${label}`, {
    data_source: key,
    table_or_view: table,
    supabase_error: errorPayload,
    current_user_id: profile?.id ?? null,
    user_roles: profile?.roles ?? [],
    organization_id: null,
    query_parameters: params,
    stack_trace: error instanceof Error ? error.stack : null,
  });
  return {
    key,
    label,
    table,
    message: `${label}: ${errorPayload.message}`,
  };
}

export default async function NewRoutePage() {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes/new")) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
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
      .order("product_name"),
    supabase
      .from("route_stock_lines")
      .select("product_id, planned_qty, picked_qty, routes!inner(status)"),
    supabase.from("products").select("id, sku, barcode, name, category, brand, image_url, active").eq("active", true).order("name"),
    supabase.from("inventory_movements").select("product_id, created_at").order("created_at", { ascending: false }).limit(80),
  ]);
  const queryIssues = [
    operatorsError
      ? logRouteBuilderQueryError({
          key: "operators",
          label: "Could not load route operators",
          table: "team_members",
          error: operatorsError,
          profile,
          params: { role_filter: ["owner", "admin", "supervisor", "operator"], active: true, order: "full_name" },
        })
      : null,
    machinesError
      ? logRouteBuilderQueryError({
          key: "machines",
          label: "Could not load active machines",
          table: "machines",
          error: machinesError,
          profile,
          params: { status: "active", order: "name" },
        })
      : null,
    recommendationsError
      ? logRouteBuilderQueryError({
          key: "recommendations",
          label: "Could not load refill recommendations",
          table: "refill_recommendations",
          error: recommendationsError,
          profile,
          params: { order: "machine_name" },
        })
      : null,
    storageError
      ? logRouteBuilderQueryError({
          key: "storage_inventory",
          label: "Could not load storage stock",
          table: "current_inventory_by_location",
          error: storageError,
          profile,
          params: { location_type: "storage", order: "product_name" },
        })
      : null,
    reservedError
      ? logRouteBuilderQueryError({
          key: "reservations",
          label: "Could not load route reservations",
          table: "route_stock_lines",
          error: reservedError,
          profile,
          params: { route_statuses: [...ROUTE_RESERVATION_STATUSES] },
        })
      : null,
    productsError
      ? logRouteBuilderQueryError({
          key: "products",
          label: "Could not load active products",
          table: "products",
          error: productsError,
          profile,
          params: { active: true, order: "name" },
        })
      : null,
    movementsError
      ? logRouteBuilderQueryError({
          key: "recent_movements",
          label: "Could not load recent inventory movements",
          table: "inventory_movements",
          error: movementsError,
          profile,
          params: { order: "created_at desc", limit: 80 },
        })
      : null,
  ].filter((issue): issue is RouteBuilderQueryIssue => Boolean(issue));

  if (queryIssues.length) {
    return (
      <>
        <ErrorState
          title={queryIssues[0].label}
          body={queryIssues.map((issue) => issue.message).join(" ")}
          action={<SecondaryButton href="/routes/new">Retry</SecondaryButton>}
        />
      </>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const productRows = (products ?? []) as ProductRow[];
  const activeProductIds = new Set(productRows.map((product) => product.id));
  const activeRecommendations = ((recommendations ?? []) as RecommendationRow[]).filter((recommendation) => activeProductIds.has(recommendation.product_id));
  const storageByProduct = new Map<string, { product_id: string; product_name: string; quantity_on_hand: number }>();
  ((storageInventory ?? []) as StorageInventoryRow[]).forEach((row) => {
    const current = storageByProduct.get(row.product_id);
    storageByProduct.set(row.product_id, {
      product_id: row.product_id,
      product_name: row.product_name,
      quantity_on_hand: (current?.quantity_on_hand ?? 0) + signedQuantity(row.quantity_on_hand),
    });
  });
  const reservedByProduct = new Map<string, number>();
  ((reservedStock ?? []) as ReservedStockRow[]).filter((row) => isRouteReservationStatus(row.routes?.status)).forEach((row) => {
    const reserved = Math.max(0, unitQuantity(row.planned_qty) - unitQuantity(row.picked_qty));
    reservedByProduct.set(row.product_id, (reservedByProduct.get(row.product_id) ?? 0) + reserved);
  });
  const availableStorage = Array.from(storageByProduct.values())
    .map((row) => ({ ...row, quantity_on_hand: Math.max(0, unitQuantity(row.quantity_on_hand) - unitQuantity(reservedByProduct.get(row.product_id))) }))
    .filter((row) => row.quantity_on_hand > 0);
  const availableByProduct = new Map(availableStorage.map((row) => [row.product_id, row.quantity_on_hand]));
  const productCatalog = productRows
    .map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      category: product.category,
      brand: product.brand,
      imageUrl: product.image_url,
      availableQty: unitQuantity(availableByProduct.get(product.id)),
      storageQty: unitQuantity(storageByProduct.get(product.id)?.quantity_on_hand),
    }));
  const recentProductIds = Array.from(new Set(((recentMovements ?? []) as RecentMovementRow[]).map((row) => row.product_id).filter((productId): productId is string => Boolean(productId)))).slice(0, 12);

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
