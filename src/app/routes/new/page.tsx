import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { ROUTE_RESERVATION_STATUSES, isRouteReservationStatus } from "@/lib/route-workflow";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import { activeStockBatches, queryVmsDashboardBatches, sourceFileName, type VmsDashboardBatch } from "@/lib/vms-dashboard-source";
import { RouteCreateForm } from "@/app/routes/new/RouteCreateForm";
import { formatSiteLabel, formatMachineDisplayName } from "@/lib/machine-site-display";
import { getServerI18n } from "@/lib/i18n/server";
import type {
  RouteRecommendationDiagnosticReasonCode,
  RouteRecommendationDiagnostics,
  RouteRecommendationMachineDiagnostic,
} from "@/app/routes/new/types";
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

const ROUTE_RECOMMENDATION_BASE_SELECT = "recommendation_key, machine_slot_id, machine_id, machine_name, machine_code, slot_code, product_id, product_name, current_qty, capacity, par_qty, suggested_qty, available_storage_qty, final_qty_to_take, priority";
const ROUTE_RECOMMENDATION_SELECT = `${ROUTE_RECOMMENDATION_BASE_SELECT}, import_batch_id`;

type ProductRow = {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  image_url: string | null;
};

type MachineRow = {
  id: string;
  name: string;
  machine_code: string;
  machine_display_name?: string | null;
  vms_machine_id?: string | null;
  location?: Record<string, unknown> | Record<string, unknown>[] | null;
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
  import_batch_id?: string | null;
  source_file_name?: string | null;
  source_uploaded_at?: string | null;
};

type MachineSlotRow = {
  id: string;
  machine_id: string;
  slot_code: string | null;
  product_id: string | null;
  par_qty: number | null;
  min_qty: number | null;
};

type LatestStockRow = {
  id: string;
  import_batch_id: string | null;
  imported_at: string | null;
  source_file_name: string | null;
  machine_id: string | null;
  slot_code: string | null;
  product_id: string | null;
  current_qty: number | null;
  capacity: number | null;
};

type MachineStockAuditRow = {
  machine_id: string | null;
  product_id: string | null;
};



type SupabaseLikeError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };

function isMissingRecommendationMetadataError(error: SupabaseLikeError | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

function reasonLabel(code: RouteRecommendationDiagnosticReasonCode) {
  switch (code) {
    case "healthy":
      return "Recommendations healthy";
    case "no_active_stock_snapshot":
      return "No active stock snapshot";
    case "stale_stock_snapshot":
      return "Stock snapshot is stale";
    case "no_latest_stock_rows":
      return "No latest stock rows";
    case "machine_mapping_missing":
      return "Machine mapping missing";
    case "machine_has_no_planogram":
      return "No planogram";
    case "all_products_unmapped":
      return "All products unmapped";
    case "all_products_inactive":
      return "All products inactive";
    case "current_stock_full":
      return "Current stock already full";
    case "no_positive_recommendations":
      return "No positive recommendations";
    default:
      return "Diagnostics incomplete";
  }
}

function batchTimestamp(batch: VmsDashboardBatch | null) {
  return batch?.detected_max_datetime ?? batch?.detected_min_datetime ?? batch?.imported_at ?? batch?.uploaded_at ?? null;
}

const STOCK_SNAPSHOT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

function isStaleStockSnapshot(value: string | null | undefined, now = Date.now()) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && now - timestamp > STOCK_SNAPSHOT_MAX_AGE_MS;
}

type VmsImportBatchSourceRow = {
  id: string;
  file_name: string | null;
  original_file_name: string | null;
  uploaded_at: string | null;
};

async function loadRouteRecommendations(supabase: Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>) {
  if (!supabase) return { data: [], error: null };

  const enrichedRecommendationResult = await supabase
    .from("refill_recommendations")
    .select(ROUTE_RECOMMENDATION_SELECT)
    .order("machine_name");
  const recommendationResult = enrichedRecommendationResult.error && isMissingRecommendationMetadataError(enrichedRecommendationResult.error)
    ? await supabase
        .from("refill_recommendations")
        .select(ROUTE_RECOMMENDATION_BASE_SELECT)
        .order("machine_name")
    : enrichedRecommendationResult;
  if (recommendationResult.error || !recommendationResult.data?.length) return recommendationResult;

  const recommendationRows = recommendationResult.data as RecommendationRow[];
  const batchIds = Array.from(new Set(recommendationRows.map((row) => row.import_batch_id).filter((id): id is string => Boolean(id))));
  if (!batchIds.length) return recommendationResult;

  const { data: batches, error: batchError } = await supabase
    .from("vms_import_batches")
    .select("id, file_name, original_file_name, uploaded_at")
    .in("id", batchIds);
  if (batchError) {
    console.warn("[routes:new] Could not load VMS import source metadata; route recommendations will use Unknown source fallback.", batchError);
    return recommendationResult;
  }

  const batchById = new Map(((batches ?? []) as VmsImportBatchSourceRow[]).map((batch) => [batch.id, batch]));
  return {
    ...recommendationResult,
    data: recommendationRows.map((row) => {
      const batch = row.import_batch_id ? batchById.get(row.import_batch_id) : null;
      return {
        ...row,
        source_file_name: batch?.original_file_name ?? batch?.file_name ?? null,
        source_uploaded_at: batch?.uploaded_at ?? null,
      };
    }),
  };
}

type StorageInventoryRow = {
  product_id: string;
  product_name: string;
  quantity_on_hand: unknown;
};

type ReservedStockRow = {
  route_id?: string | null;
  product_id: string;
  planned_qty: unknown;
  picked_qty: unknown;
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

function supabaseErrorPayload(error: unknown) {
  const payload = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  return {
    code: typeof payload?.code === "string" ? payload.code : null,
    message: typeof payload?.message === "string" ? payload.message : String(error ?? "Unknown Supabase error"),
    details: typeof payload?.details === "string" ? payload.details : null,
    hint: typeof payload?.hint === "string" ? payload.hint : null,
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
  error: unknown;
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
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes/new")) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title={locale === "ar" ? "إنشاء الجولة غير متاح" : "Route creation unavailable"} body={locale === "ar" ? "لم يتم إعداد Supabase، لذلك لا يمكن لـ Snacky OS إنشاء الجولات." : "Supabase is not configured, so Snacky OS cannot create routes."} action={<SecondaryButton href="/routes">{locale === "ar" ? "العودة إلى الجولات" : "Back to routes"}</SecondaryButton>} />
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
    batchResult,
    latestStockResult,
    machineSlotsResult,
  ] = await Promise.all([
    supabase.from("team_members").select("id, full_name, role, roles").or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}").eq("active", true).order("full_name"),
    supabase.from("machines").select("*, location:locations(*)").eq("status", "active").order("machine_code"),
    loadRouteRecommendations(supabase),
    supabase
      .from("current_inventory_by_location")
      .select("product_id, product_name, quantity_on_hand")
      .eq("location_type", "storage")
      .order("product_name"),
    supabase
      .from("route_stock_lines")
      .select("route_id, product_id, planned_qty, picked_qty"),
    supabase.from("products").select("id, sku, barcode, name, category, brand, image_url, active").eq("active", true).order("name"),
    supabase.from("inventory_movements").select("product_id, created_at").order("created_at", { ascending: false }).limit(80),
    safeSupabaseQuery<VmsDashboardBatch>({
      label: "routes.new.vms_import_batches",
      promise: queryVmsDashboardBatches(supabase, {
        reportTypes: ["stock", "machine_stock_snapshot", "planogram"],
        orderBy: "uploaded_at",
        ascending: false,
      }),
    }),
    safeSupabaseQuery<LatestStockRow>({
      label: "routes.new.latest_vms_stock_by_slot",
      promise: supabase
        .from("latest_vms_stock_by_slot")
        .select("id, import_batch_id, imported_at, source_file_name, machine_id, slot_code, product_id, current_qty, capacity"),
    }),
    safeSupabaseQuery<MachineSlotRow>({
      label: "routes.new.machine_slots",
      promise: supabase
        .from("machine_slots")
        .select("id, machine_id, slot_code, product_id, par_qty, min_qty"),
    }),
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
          params: { order: "machine_name", optional_source_metadata: "vms_import_batches" },
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
      ? (console.warn("[routes:new] Could not load route reservations; route builder will continue and creation API will revalidate stock.", {
          supabase_error: supabaseErrorPayload(reservedError),
          route_statuses: [...ROUTE_RESERVATION_STATUSES],
        }), null)
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

  const stockBatches = ((batchResult.data ?? []) as VmsDashboardBatch[])
    .filter((batch) => ["stock", "machine_stock_snapshot"].includes(String(batch.report_type ?? "")));
  const latestStockRows = (latestStockResult.data ?? []) as LatestStockRow[];
  const machineSlotRows = (machineSlotsResult.data ?? []) as MachineSlotRow[];
  const latestActiveStockBatch = activeStockBatches(stockBatches)[0] ?? null;
  const diagnosticBatch = latestActiveStockBatch ?? stockBatches[0] ?? null;
  const batchStockRowsResult = diagnosticBatch?.id
    ? await safeSupabaseQuery<{ id: string }>({
        label: "routes.new.vms_stock_snapshots",
        promise: supabase
          .from("vms_stock_snapshots")
          .select("id", { count: "exact", head: true })
          .eq("import_batch_id", diagnosticBatch.id),
      })
    : { data: [] as { id: string }[], count: 0, error: null as string | null };
  const batchAuditResult = diagnosticBatch?.id
    ? await safeSupabaseQuery<MachineStockAuditRow>({
        label: "routes.new.vms_machine_stock_snapshots",
        promise: supabase
          .from("vms_machine_stock_snapshots")
          .select("machine_id, product_id")
          .eq("import_batch_id", diagnosticBatch.id),
      })
    : { data: [] as MachineStockAuditRow[], count: 0, error: null as string | null };
  const batchAuditRows = (batchAuditResult.data ?? []) as MachineStockAuditRow[];
  const stockSnapshotIsStale = isStaleStockSnapshot(batchTimestamp(latestActiveStockBatch));
  const today = new Date().toISOString().slice(0, 10);
  const productRows = (products ?? []) as ProductRow[];
  const activeProductIds = new Set(productRows.map((product) => product.id));
  const loadedRecommendations = (recommendations ?? []) as RecommendationRow[];
  const activeRecommendations = loadedRecommendations.filter((recommendation) => activeProductIds.has(recommendation.product_id));
  const storageByProduct = new Map<string, { product_id: string; product_name: string; quantity_on_hand: number }>();
  ((storageInventory ?? []) as StorageInventoryRow[]).forEach((row) => {
    const current = storageByProduct.get(row.product_id);
    storageByProduct.set(row.product_id, {
      product_id: row.product_id,
      product_name: row.product_name,
      quantity_on_hand: (current?.quantity_on_hand ?? 0) + signedQuantity(row.quantity_on_hand),
    });
  });
  const reservedRows = reservedError ? [] : (reservedStock ?? []) as ReservedStockRow[];
  const reservedRouteIds = Array.from(new Set(reservedRows.map((row) => String(row.route_id ?? "")).filter(Boolean)));
  const routeStatusById = new Map<string, string | null>();
  if (reservedRouteIds.length) {
    const { data: reservationRoutes, error: reservationRoutesError } = await supabase
      .from("routes")
      .select("id, status")
      .in("id", reservedRouteIds);
    if (reservationRoutesError) {
      console.warn("[routes:new] Could not load route statuses for reservation filtering; treating route stock rows as reserved.", {
        route_ids: reservedRouteIds,
        supabase_error: supabaseErrorPayload(reservationRoutesError),
      });
    } else {
      (reservationRoutes ?? []).forEach((route: { id?: unknown; status?: unknown }) => routeStatusById.set(String(route.id), String(route.status ?? "")));
    }
  }
  const reservedByProduct = new Map<string, number>();
  reservedRows.filter((row) => {
    const routeId = String(row.route_id ?? "");
    if (!routeId) return true;
    if (!routeStatusById.size) return true;
    return isRouteReservationStatus(routeStatusById.get(routeId));
  }).forEach((row) => {
    const reserved = Math.max(0, unitQuantity(row.planned_qty) - unitQuantity(row.picked_qty));
    reservedByProduct.set(row.product_id, (reservedByProduct.get(row.product_id) ?? 0) + reserved);
  });
  const availableStorage = Array.from(storageByProduct.values())
    .map((row) => ({ ...row, quantity_on_hand: Math.max(0, unitQuantity(row.quantity_on_hand) - unitQuantity(reservedByProduct.get(row.product_id))) }))
    .filter((row) => row.quantity_on_hand > 0);
  const availableByProduct = new Map(availableStorage.map((row) => [row.product_id, row.quantity_on_hand]));
  const machineRows = (machines ?? []) as MachineRow[];
  const machineCatalog = machineRows.map((machine) => {
    const location = Array.isArray(machine.location) ? machine.location[0] : machine.location;
    return {
      id: machine.id,
      name: machine.name,
      machine_display_name: machine.machine_display_name ?? null,
      machine_code: machine.machine_code,
      location_name: formatSiteLabel(location ?? null, { includeArea: true }),
    };
  });
  const latestStockByMachine = new Map<string, LatestStockRow[]>();
  latestStockRows.forEach((row) => {
    const machineId = String(row.machine_id ?? "").trim();
    if (!machineId) return;
    latestStockByMachine.set(machineId, [...(latestStockByMachine.get(machineId) ?? []), row]);
  });
  const machineSlotsByMachine = new Map<string, MachineSlotRow[]>();
  machineSlotRows.forEach((row) => {
    const machineId = String(row.machine_id ?? "").trim();
    if (!machineId) return;
    machineSlotsByMachine.set(machineId, [...(machineSlotsByMachine.get(machineId) ?? []), row]);
  });
  const auditRowsByMachine = new Map<string, MachineStockAuditRow[]>();
  batchAuditRows.forEach((row) => {
    const machineId = String(row.machine_id ?? "").trim();
    if (!machineId) return;
    auditRowsByMachine.set(machineId, [...(auditRowsByMachine.get(machineId) ?? []), row]);
  });
  const recommendationsByMachine = new Map<string, RecommendationRow[]>();
  loadedRecommendations.forEach((row) => {
    const machineId = String(row.machine_id ?? "").trim();
    if (!machineId) return;
    recommendationsByMachine.set(machineId, [...(recommendationsByMachine.get(machineId) ?? []), row]);
  });
  const activeRecommendationsByMachine = new Map<string, RecommendationRow[]>();
  activeRecommendations.forEach((row) => {
    const machineId = String(row.machine_id ?? "").trim();
    if (!machineId) return;
    activeRecommendationsByMachine.set(machineId, [...(activeRecommendationsByMachine.get(machineId) ?? []), row]);
  });
  const latestRowByExactSlot = new Map<string, LatestStockRow>();
  const latestRowBySlot = new Map<string, LatestStockRow>();
  latestStockRows.forEach((row) => {
    const machineId = String(row.machine_id ?? "").trim();
    const slotCode = String(row.slot_code ?? "").trim();
    const productId = String(row.product_id ?? "").trim();
    if (!machineId || !slotCode) return;
    if (productId) latestRowByExactSlot.set(`${machineId}:${slotCode}:${productId}`, row);
    if (!latestRowBySlot.has(`${machineId}:${slotCode}`)) latestRowBySlot.set(`${machineId}:${slotCode}`, row);
  });
  const machineDiagnostics: RouteRecommendationMachineDiagnostic[] = machineRows.map((machine) => {
    const location = Array.isArray(machine.location) ? machine.location[0] : machine.location;
    const latestRows = latestStockByMachine.get(machine.id) ?? [];
    const planogramRows = machineSlotsByMachine.get(machine.id) ?? [];
    const auditRows = auditRowsByMachine.get(machine.id) ?? [];
    const allRecommendationRows = recommendationsByMachine.get(machine.id) ?? [];
    const visibleRecommendationRows = activeRecommendationsByMachine.get(machine.id) ?? [];
    const positiveSuggestedRows = visibleRecommendationRows.filter((row) => Math.max(0, unitQuantity(row.capacity ?? row.par_qty) - unitQuantity(row.current_qty)) > 0).length;
    const storageShortages = visibleRecommendationRows.filter((row) => Math.max(0, unitQuantity(row.capacity ?? row.par_qty) - unitQuantity(row.current_qty)) > unitQuantity(row.available_storage_qty)).length;
    const unmappedProducts = auditRows.filter((row) => !row.product_id).length;
    const slotNeedsRefillCount = planogramRows.reduce((count, slot) => {
      const machineId = String(slot.machine_id ?? "").trim();
      const slotCode = String(slot.slot_code ?? "").trim();
      const productId = String(slot.product_id ?? "").trim();
      if (!machineId || !slotCode) return count;
      const currentRow = (productId ? latestRowByExactSlot.get(`${machineId}:${slotCode}:${productId}`) : null) ?? latestRowBySlot.get(`${machineId}:${slotCode}`);
      if (!currentRow) return count;
      const targetQty = unitQuantity(slot.par_qty ?? slot.min_qty ?? currentRow.capacity);
      if (!targetQty) return count;
      return unitQuantity(currentRow.current_qty) < targetQty ? count + 1 : count;
    }, 0);
    const latestRow = [...latestRows].sort((a, b) => String(b.imported_at ?? "").localeCompare(String(a.imported_at ?? "")))[0] ?? null;
    const snapshotTime = latestRow?.imported_at ?? batchTimestamp(diagnosticBatch);
    let reasonCode: RouteRecommendationDiagnosticReasonCode = "healthy";
    if (!latestActiveStockBatch) {
      reasonCode = "no_active_stock_snapshot";
    } else if (isStaleStockSnapshot(snapshotTime)) {
      reasonCode = "stale_stock_snapshot";
    } else if (!machine.vms_machine_id) {
      reasonCode = "machine_mapping_missing";
    } else if (!planogramRows.length) {
      reasonCode = "machine_has_no_planogram";
    } else if (!latestRows.length && unmappedProducts > 0) {
      reasonCode = "all_products_unmapped";
    } else if (!latestRows.length) {
      reasonCode = "no_latest_stock_rows";
    } else if (allRecommendationRows.length > 0 && !visibleRecommendationRows.length) {
      reasonCode = "all_products_inactive";
    } else if (!positiveSuggestedRows && slotNeedsRefillCount === 0) {
      reasonCode = "current_stock_full";
    } else if (!positiveSuggestedRows && unmappedProducts > 0) {
      reasonCode = "all_products_unmapped";
    } else if (!positiveSuggestedRows) {
      reasonCode = "no_positive_recommendations";
    }
    const reasonMessageByCode: Record<RouteRecommendationDiagnosticReasonCode, string> = {
      healthy: "Route creation can use this machine's latest stock and recommendation rows.",
      no_active_stock_snapshot: "No active stock snapshot is available yet.",
      stale_stock_snapshot: "The latest stock snapshot is more than 72 hours old. Import fresh VMS stock before using automatic quantities.",
      no_latest_stock_rows: "The latest stock snapshot did not produce refill recommendations for this machine.",
      machine_mapping_missing: "This machine still needs a VMS mapping.",
      machine_has_no_planogram: "This machine has not been configured yet.",
      all_products_unmapped: "The latest stock snapshot still needs product mapping.",
      all_products_inactive: "Recommendations exist, but all products are inactive.",
      current_stock_full: "Current stock is already at or above target quantities.",
      no_positive_recommendations: "The latest stock snapshot does not require a refill for this machine.",
      unknown: "Recommendation data is temporarily unavailable for this machine. Please contact admin.",
    };
    return {
      machineId: machine.id,
      machineName: formatMachineDisplayName(machine, { includeArea: true }),
      machineCode: machine.machine_code,
      locationName: formatSiteLabel(location ?? null, { includeArea: true }),
      machineMapped: Boolean(machine.vms_machine_id),
      latestStockRowsFound: latestRows.length,
      planogramRowsFound: planogramRows.length,
      recommendationRowsGenerated: allRecommendationRows.length,
      routeVisibleRecommendationRows: visibleRecommendationRows.length,
      positiveSuggestedRows,
      storageShortages,
      unmappedProducts,
      sourceFileName: latestRow?.source_file_name ?? (diagnosticBatch ? sourceFileName(diagnosticBatch) : null),
      snapshotTime,
      reasonCode,
      reasonLabel: reasonLabel(reasonCode),
      reasonMessage: reasonMessageByCode[reasonCode],
    };
  });
  const diagnosticBatchStockRows = Number(batchStockRowsResult.count ?? 0);
  const diagnosticBatchAuditRows = batchAuditRows.length;
  const diagnosticsWarnings = [latestStockResult.error, machineSlotsResult.error, batchStockRowsResult.error, batchAuditResult.error].filter(Boolean);
  const machineDiagnosticsWithIssues = machineDiagnostics.filter((machine) => machine.reasonCode !== "healthy");
  const summaryReasonCode: RouteRecommendationDiagnosticReasonCode =
    diagnosticsWarnings.length
      ? "unknown"
      : !latestActiveStockBatch
        ? "no_active_stock_snapshot"
        : stockSnapshotIsStale
          ? "stale_stock_snapshot"
        : latestStockRows.length === 0
          ? "no_latest_stock_rows"
          : loadedRecommendations.length > 0 && activeRecommendations.length === 0
            ? "all_products_inactive"
            : activeRecommendations.some((row) => Math.max(0, unitQuantity(row.capacity ?? row.par_qty) - unitQuantity(row.current_qty)) > 0)
              ? "healthy"
              : machineDiagnosticsWithIssues.some((machine) => machine.reasonCode === "machine_has_no_planogram")
                ? "machine_has_no_planogram"
                : machineDiagnosticsWithIssues.some((machine) => machine.reasonCode === "all_products_unmapped")
                  ? "all_products_unmapped"
                  : machineDiagnosticsWithIssues.some((machine) => machine.reasonCode === "machine_mapping_missing")
                    ? "machine_mapping_missing"
                    : "current_stock_full";
  const diagnostics: RouteRecommendationDiagnostics = {
    summaryReasonCode,
    summaryReasonLabel: reasonLabel(summaryReasonCode),
    summaryMessage: diagnosticsWarnings.length
      ? "Recommendation data is partially unavailable right now."
      : summaryReasonCode === "healthy"
        ? "Latest stock rows and refill recommendations are available for route creation."
        : summaryReasonCode === "stale_stock_snapshot"
          ? "The latest stock snapshot is more than 72 hours old. Import fresh VMS stock before using automatic quantities."
        : machineDiagnosticsWithIssues.find((machine) => machine.reasonCode === summaryReasonCode)?.reasonMessage
          ?? (summaryReasonCode === "no_active_stock_snapshot"
            ? "No active stock snapshot is available yet."
            : summaryReasonCode === "no_latest_stock_rows"
              ? "The latest stock snapshot did not produce refill recommendations."
              : summaryReasonCode === "all_products_inactive"
                ? "Recommendations were generated, but every product is inactive."
                : summaryReasonCode === "machine_has_no_planogram"
                  ? "This machine has not been configured yet."
                  : summaryReasonCode === "all_products_unmapped"
                    ? "The latest stock snapshot still needs product mapping."
                    : summaryReasonCode === "machine_mapping_missing"
                      ? "This machine still needs a VMS mapping."
                      : "Current stock is already at or above target quantities."),
    activeStockBatchId: latestActiveStockBatch?.id ?? null,
    activeStockBatchFileName: latestActiveStockBatch ? sourceFileName(latestActiveStockBatch) : null,
    activeStockBatchImportedAt: batchTimestamp(latestActiveStockBatch),
    diagnosticBatchId: diagnosticBatch?.id ?? null,
    diagnosticBatchFileName: diagnosticBatch ? sourceFileName(diagnosticBatch) : null,
    diagnosticBatchStatus: String(diagnosticBatch?.status ?? "") || null,
    diagnosticBatchIsActive: diagnosticBatch?.is_active ?? null,
    diagnosticBatchStockRows,
    diagnosticBatchAuditRows,
    latestStockRowsFound: latestStockRows.length,
    recommendationRowsFound: loadedRecommendations.length,
    recommendationsReturnedToFrontend: activeRecommendations.length,
    inactiveProductRowsFilteredOut: Math.max(0, loadedRecommendations.length - activeRecommendations.length),
    storageShortageRows: activeRecommendations.filter((row) => unitQuantity(row.suggested_qty) > unitQuantity(row.available_storage_qty)).length,
    unmappedProductRows: batchAuditRows.filter((row) => !row.product_id).length,
    planogramRowsFound: machineSlotRows.length,
    previewBatchRowsDetected: stockBatches.some((batch) => String(batch.status ?? "") === "previewed"),
    machineDiagnostics,
  };
  console.info("[routes:new] Recommendation diagnostics", {
    source_view: "refill_recommendations",
    active_stock_snapshot_batch_id: diagnostics.activeStockBatchId,
    diagnostic_batch_id: diagnostics.diagnosticBatchId,
    diagnostic_batch_status: diagnostics.diagnosticBatchStatus,
    diagnostic_batch_is_active: diagnostics.diagnosticBatchIsActive,
    diagnostic_batch_stock_rows: diagnostics.diagnosticBatchStockRows,
    diagnostic_batch_audit_rows: diagnostics.diagnosticBatchAuditRows,
    latest_vms_stock_rows_found: diagnostics.latestStockRowsFound,
    planogram_rows_found: diagnostics.planogramRowsFound,
    refill_recommendation_rows_found: diagnostics.recommendationRowsFound,
    recommendations_returned_to_frontend: diagnostics.recommendationsReturnedToFrontend,
    filtered_out_inactive_products: diagnostics.inactiveProductRowsFilteredOut,
    storage_shortage_rows: diagnostics.storageShortageRows,
    unmapped_product_rows: diagnostics.unmappedProductRows,
    summary_reason_code: diagnostics.summaryReasonCode,
    preview_batch_rows_detected: diagnostics.previewBatchRowsDetected,
  });
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
        <PageHeader title={locale === "ar" ? "إنشاء جولة" : "Create route"} subtitle={locale === "ar" ? "أنشئ جولة مع المواقع أو توصيات التعبئة أو قائمة تحميل يدوية سريعة من المخزن." : "Build a route with stops, refill recommendations, or a fast manual pick list from storage."} />
        <RouteCreateForm
          operators={operators ?? []}
          machines={machineCatalog}
          recommendations={activeRecommendations}
          diagnostics={diagnostics}
          machinePlanogramRows={machineSlotRows}
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
