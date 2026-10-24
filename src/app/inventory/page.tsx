import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { formatProductQuantity } from "@/lib/product-quantity";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { loadPhysicalStorageData } from "@/lib/storage-inventory-data";
import { physicalStockStatus } from "@/lib/storage-inventory-model";
import { isRouteReservationStatus } from "@/lib/route-workflow";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type InventoryFilter = "all" | "out" | "reserved" | "review";

type InventoryQueryIssue = {
  key: string;
  label: string;
  table: string;
  message: string;
};

type InventoryRouteReservation = {
  routeId: string;
  routeDate: string | null;
  status: string;
  remainingQty: number;
};

type RouteReservationSourceRow = {
  route_id?: string | null;
  product_id?: string | null;
  planned_qty?: unknown;
  picked_qty?: unknown;
  routes?: { id?: string | null; route_date?: string | null; status?: string | null } | { id?: string | null; route_date?: string | null; status?: string | null }[] | null;
};

type InventoryRow = {
  productId: string;
  productName: string;
  sku: string | null;
  category: string | null;
  brand: string | null;
  caseQuantity: number;
  active: boolean;
  unmapped: boolean;
  currentQty: number;
  reservedQty: number | null;
  availableQty: number | null;
  reservations: InventoryRouteReservation[];
  status: string;
};

const inventoryFilterNamesAr: Record<InventoryFilter, string> = {
  all: "كل المنتجات", out: "نافد", reserved: "محجوز",
  review: "تحتاج متابعة",
};

const inventoryFilters: { key: InventoryFilter; label: string }[] = [
  { key: "all", label: "All products" },
  { key: "out", label: "Out of stock" },
  { key: "reserved", label: "Reserved for routes" },
  { key: "review", label: "Needs attention" },
];

function formatEntity(type: string | null | undefined, name: string | null | undefined) {
  return name ? `${type}: ${name}` : type ?? "-";
}

function supabaseErrorPayload(error: any) {
  return {
    code: error?.code ?? null,
    message: error?.message ?? String(error ?? "Unknown Supabase error"),
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  };
}

function logInventoryQueryError({
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
  console.error(`[inventory] ${label}`, {
    data_source: key,
    table_or_view: table,
    supabase_error: errorPayload,
    current_user_id: profile?.id ?? null,
    user_roles: profile?.roles ?? [],
    organization_id: null,
    query_parameters: params,
  });
  return {
    key,
    label,
    table,
    message: `${label}: ${errorPayload.message}`,
  };
}

function inventoryFilterHref(filter: InventoryFilter, q: string) {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (q.trim()) params.set("q", q.trim());
  const query = params.toString();
  return query ? `/inventory?${query}` : "/inventory";
}

function packagedQuantity(quantity: unknown, row: { productName?: string | null; product_name?: string | null; category?: string | null; caseQuantity?: number | null; case_quantity?: number | null }) {
  return formatProductQuantity(quantity, {
    caseQuantity: row.caseQuantity ?? row.case_quantity ?? 1,
    productName: row.productName ?? row.product_name ?? null,
    category: row.category ?? null,
  }, { compact: true });
}

function matchesText(values: Array<string | null | undefined>, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
}

function filterInventoryRows(rows: InventoryRow[], filter: InventoryFilter, query: string) {
  return rows.filter((row) => {
    const matchesQuery = matchesText([row.productName, row.sku, row.category, row.brand, ...row.reservations.flatMap((reservation) => [reservation.routeId, reservation.routeDate, reservation.status])], query);
    if (!matchesQuery) return false;
    if (filter === "out") return row.status === "out_of_stock";
    if (filter === "reserved") return row.reservedQty !== null && row.reservedQty > 0;
    if (filter === "review") return row.status === "review" || row.status === "unverified" || row.status === "low_stock";
    return true;
  });
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const { locale, direction } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize } = getPagination(params);
  const q = String(params.q ?? "");
  const rawFilter = String(params.filter ?? "");
  const filter = inventoryFilters.some((item) => item.key === rawFilter) ? (rawFilter as InventoryFilter) : "all";
  const profile = await getCurrentProfile();
  const userContext = profile
    ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }
    : null;

  if (!profile || !canAccessPath(userContext, "/inventory")) {
    redirect("/unauthorized");
  }

  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  if (!supabase) {
    return (
      <>
        <ErrorState title="Inventory unavailable" body="Supabase is not configured, so Snacky OS cannot load ledger-based inventory." />
      </>
    );
  }
  // This page has already enforced inventory access. Use the protected server
  // client for the operational ledger reads so large security-invoker views do
  // not evaluate the same profile policy once per movement row.
  const inventoryReadClient = getSupabaseAdminClient() ?? supabase;

  const storageResult = await loadPhysicalStorageData(inventoryReadClient);
  if (!storageResult.ok) {
    console.error("[inventory] Physical Storage could not be verified", { error: storageResult.error });
    return (
      <ErrorState
        title={tr("Storage inventory could not be verified", "تعذر التحقق من مخزون المخزن")}
        body={tr(
          "Physical stock could not be verified from the ledger. No quantities have been changed or treated as zero. Retry or check Data Health.",
          "تعذر التحقق من كميات المخزن من سجل المخزون. لم تتغير أي كميات ولم نعتبر البيانات المفقودة صفراً. أعد المحاولة أو راجع سلامة البيانات."
        )}
        action={<SecondaryButton href="/inventory">{tr("Retry", "إعادة المحاولة")}</SecondaryButton>}
      />
    );
  }

  const [
    { data: operatorBagRowsData, error: operatorBagError },
    { data: movementsData, error: movementsError },
    { data: routeReservationsData, error: routeReservationsError, count: routeReservationsCount },
  ] = await Promise.all([
    inventoryReadClient.from("current_inventory_by_location")
      .select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand")
      .eq("location_type", "operator_bag").order("location_name").order("product_name").limit(2000),
    inventoryReadClient.from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")
      .order("created_at", { ascending: false }).limit(250),
    inventoryReadClient.from("route_stock_lines")
      .select("route_id, product_id, planned_qty, picked_qty, routes!inner(id, route_date, status)", { count: "exact" })
      .limit(10001),
  ]);
  let reservationsKnown = !routeReservationsError && routeReservationsCount !== null
    && routeReservationsCount <= (routeReservationsData?.length ?? 0)
    && (routeReservationsData?.length ?? 0) < 10001;

  const queryIssues: InventoryQueryIssue[] = [
    operatorBagError
      ? logInventoryQueryError({
          key: "operator_bags",
          label: "Could not load operator bag stock",
          table: "current_inventory_by_location",
          error: operatorBagError,
          profile,
          params: { location_type: "operator_bag", limit: 2000 },
        })
      : null,
    !reservationsKnown
      ? {
          key: "route_reservations",
          label: "Route reservations unavailable",
          table: "route_stock_lines",
          message: "Route reservations could not be verified. Reserved and Available quantities are hidden; physical stock is still shown.",
        }
      : null,
    movementsError
      ? logInventoryQueryError({
          key: "inventory_movements",
          label: "Could not load inventory movements",
          table: "inventory_movements",
          error: movementsError,
          profile,
          params: { order: "created_at desc", limit: 250 },
        })
      : null,
    !storageResult.minimumThresholdsVerified
      ? {
          key: "minimum_thresholds",
          label: "Minimum stock thresholds unavailable",
          table: "products.min_storage_qty",
          message: "Minimum stock thresholds are unavailable; low-stock labels are disabled, but physical quantities are verified.",
        }
      : null,
  ].filter((issue): issue is InventoryQueryIssue => Boolean(issue));

  const productById = new Map(storageResult.items.map((product) => [product.productId, product]));
  const reservationsByProductId = new Map<string, InventoryRouteReservation[]>();
  ((routeReservationsData ?? []) as RouteReservationSourceRow[]).forEach((row) => {
    const route = Array.isArray(row.routes) ? row.routes[0] : row.routes;
    const routeId = String(route?.id ?? row.route_id ?? "").trim();
    const productId = String(row.product_id ?? "").trim();
    const status = String(route?.status ?? "").trim();
    if (!isRouteReservationStatus(status)) return;
    const planned = Number(row.planned_qty), picked = Number(row.picked_qty ?? 0);
    if (!routeId || !productId || !Number.isSafeInteger(planned) || !Number.isSafeInteger(picked)
        || planned < 0 || picked < 0) {
      reservationsKnown = false;
      return;
    }
    const remainingQty = Math.max(0, planned - picked);
    if (remainingQty <= 0) return;
    reservationsByProductId.set(productId, [
      ...(reservationsByProductId.get(productId) ?? []),
      { routeId, routeDate: route?.route_date ?? null, status, remainingQty },
    ]);
  });
  if (!reservationsKnown && !queryIssues.some((issue) => issue.key === "route_reservations")) {
    queryIssues.push({ key: "route_reservations", label: "Reservation data unverified", table: "route_stock_lines", message: "Reservation quantities are incomplete. Available stock is hidden until verified." });
  }
  reservationsByProductId.forEach((reservations) => reservations.sort((left, right) =>
    String(left.routeDate ?? "").localeCompare(String(right.routeDate ?? "")) || left.routeId.localeCompare(right.routeId)
  ));

  const allInventoryRows = storageResult.items
    .map<InventoryRow>((item) => {
      const currentQty = item.currentQty; // signed verified ledger quantity; never clamp a negative balance
      const reservations = reservationsByProductId.get(item.productId) ?? [];
      const reservedQty = reservationsKnown
        ? reservations.reduce((sum, reservation) => sum + reservation.remainingQty, 0)
        : null;
      const availableQty = reservedQty === null ? null : Math.max(0, currentQty - reservedQty);
      return {
        productId: item.productId,
        productName: item.productName,
        sku: item.sku,
        category: item.category,
        brand: item.brand,
        caseQuantity: item.caseQuantity,
        active: item.active,
        unmapped: item.unmapped,
        currentQty,
        reservedQty,
        availableQty,
        reservations,
        status: physicalStockStatus(currentQty, reservedQty, item.minStorageQty, item.unmapped || !item.active),
      };
    })
    .sort((left, right) => {
      const rank: Record<string, number> = { review: 0, unverified: 1, out_of_stock: 2, low_stock: 3, reserved: 4, available: 5 };
      return (rank[left.status] ?? 6) - (rank[right.status] ?? 6) || left.productName.localeCompare(right.productName);
    });

  const filteredInventoryRows = filterInventoryRows(allInventoryRows, filter, q);
  const totalInventoryPages = Math.max(1, Math.ceil(filteredInventoryRows.length / pageSize));
  const visibleInventoryPage = Math.min(page, totalInventoryPages);
  const inventoryRows = filteredInventoryRows.slice((visibleInventoryPage - 1) * pageSize, visibleInventoryPage * pageSize);

  const filterCounts: Record<InventoryFilter, number> = {
    all: allInventoryRows.length,
    out: allInventoryRows.filter((row) => row.status === "out_of_stock").length,
    reserved: allInventoryRows.filter((row) => row.reservedQty !== null && row.reservedQty > 0).length,
    review: allInventoryRows.filter((row) => row.status === "review" || row.status === "unverified" || row.status === "low_stock").length,
  };

  const operatorBagRows = (operatorBagRowsData ?? [])
    .filter((row: any) => row.location_type === "operator_bag" && Number(row.quantity_on_hand ?? 0) > 0)
    .map((row: any) => {
      const product = productById.get(String(row.product_id ?? ""));
      return {
        ...row,
        product_name: row.product_name ?? product?.productName ?? "Unknown product",
        sku: product?.sku ?? null,
        category: product?.category ?? null,
        case_quantity: product?.caseQuantity ?? 1,
      };
    })
    .sort((a: any, b: any) => String(a.location_name ?? "").localeCompare(String(b.location_name ?? "")) || String(a.product_name ?? "").localeCompare(String(b.product_name ?? "")));
  const filteredOperatorBagRows = operatorBagRows.filter((row: any) => matchesText([row.product_name, row.location_name, row.sku], q));

  const movements = (movementsData ?? []).map((movement: any) => ({
    ...movement,
    product_name: movement.product?.name ?? productById.get(String(movement.product_id ?? ""))?.productName ?? "Unknown product",
    category: productById.get(String(movement.product_id ?? ""))?.category ?? null,
    case_quantity: productById.get(String(movement.product_id ?? ""))?.caseQuantity ?? 1,
    from_label: formatEntity(movement.from_entity_type, movement.from_entity_id),
    to_label: formatEntity(movement.to_entity_type, movement.to_entity_id),
  }));
  const filteredMovements = movements.filter((movement: any) => matchesText([
    movement.product_name,
    movement.reason,
    movement.from_label,
    movement.to_label,
    movement.related_route_id,
  ], q));

  const movementReasonLabelsAr: Record<string, string> = { purchase_received: "استلام مشتريات", storage_to_operator_bag: "سحب من المخزن", operator_bag_to_machine: "تعبئة ماكينة", operator_bag_to_storage: "إرجاع للمخزن", stock_count_adjustment: "تسوية جرد", opening_balance: "رصيد افتتاحي", manual_sale: "بيع يدوي", returned_from_machine: "إرجاع من ماكينة", manual_correction: "تصحيح يدوي", damaged: "تالف", operator_personal_purchase: "شراء شخصي" };
  const statusLabelsAr: Record<string, string> = { out_of_stock: "نافد", reserved: "محجوز", low_stock: "منخفض", available: "متاح", review: "يحتاج مراجعة", unverified: "غير مؤكد" };
  const inventoryHeaders = [
    tr("Product", "المنتج"),
    tr("In storage", "في المخزن"),
    tr("Reserved in storage", "محجوز للجولات"),
    tr("Available — no route", "متاح بدون حجز"),
    tr("Status", "الحالة"),
  ];

  return (
    <div dir={direction}>
      <PageHeader
        title={tr("Storage", "المخزون")}
        subtitle={tr("See what is on the shelves, what is reserved for routes, and what is available to use.", "اعرف الكميات الموجودة في المخزن والمحجوزة للجولات والمتاحة للاستخدام.")}
        action={
          <div className="flex flex-wrap gap-2">
            <PrimaryButton href="/restock-priority/purchase-list">{tr("What to buy", "شن نشتري؟")}</PrimaryButton>
            {isOwnerAdminRole(profile) ? <SecondaryButton href="/inventory/stocktake">{tr("Count storage", "جرد المخزن")}</SecondaryButton> : null}
          </div>
        }
      />


      {queryIssues.length ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-semibold">{tr("Inventory partially loaded", "تعذر تحميل بعض بيانات المخزون")}</div>
          <div className="mt-1">{tr("Some supporting signals could not load. The working sections remain visible below.", "تعذر تحميل بعض مؤشرات المخزون، وستبقى البيانات المتاحة ظاهرة أدناه.")}</div>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            {queryIssues.map((issue) => (
              <li key={issue.key}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <form action="/inventory" className="flex flex-wrap items-center gap-2">
            {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
            <input type="hidden" name="pageSize" value={pageSize} />
            <div className="min-w-0 flex-1"><SearchInput defaultValue={q} placeholder={tr("Search product or SKU...", "ابحث باسم المنتج أو رمزه...")} /></div>
            <button className="btn-secondary" type="submit">{tr("Search", "بحث")}</button>
            {q ? <Link href={inventoryFilterHref(filter, "")} className="btn-secondary">{tr("Clear", "مسح")}</Link> : null}
          </form>
          <div className="text-sm text-slate-500">
            {filteredInventoryRows.length} {tr("products match this view.", "منتج ضمن هذه النتائج.")}
          </div>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1 whitespace-nowrap overscroll-x-contain" aria-label={tr("Stock filters", "تصفية المخزون")}>
          {inventoryFilters.map((item) => (
            <Link
              key={item.key}
              href={inventoryFilterHref(item.key, q)}
              aria-current={filter === item.key ? "page" : undefined}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition ${
                filter === item.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-slate-100"
              }`}
            >
              <span>{locale === "ar" ? inventoryFilterNamesAr[item.key] : item.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${filter === item.key ? "bg-white/15 text-white" : "bg-white text-slate-600"}`}>
                {filterCounts[item.key]}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={tr("Storage summary for selected products", "ملخص مخزون المنتجات المعروضة")}>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("In storage", "في المخزن")}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredInventoryRows.reduce((sum, row) => sum + row.currentQty, 0)}</div>
          <p className="mt-1 hidden text-sm text-slate-500 sm:block">{tr("Physical units currently on the storage shelves", "وحدات موجودة فعلياً على رفوف المخزن")}</p>
        </div>
        <div className="surface-card border-amber-200 bg-amber-50">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">{tr("Reserved in storage", "محجوز للجولات")}</div>
          <div className="mt-2 text-2xl font-semibold text-amber-950">{reservationsKnown ? filteredInventoryRows.reduce((sum, row) => sum + (row.reservedQty ?? 0), 0) : tr("Unavailable", "غير متاح")}</div>
          <p className="mt-1 hidden text-sm text-amber-800 sm:block">{tr("Still in storage, but attached to active routes", "موجودة في المخزن ومخصصة لجولات")}</p>
        </div>
        <div className="surface-card border-emerald-200 bg-emerald-50">
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{tr("Available — no route", "متاح بدون حجز")}</div>
          <div className="mt-2 text-2xl font-semibold text-emerald-950">{reservationsKnown ? filteredInventoryRows.reduce((sum, row) => sum + (row.availableQty ?? 0), 0) : tr("Unavailable", "غير متاح")}</div>
          <p className="mt-1 hidden text-sm text-emerald-800 sm:block">{tr("Free units that can be assigned to a new route", "وحدات يمكن تخصيصها لجولة جديدة")}</p>
        </div>
      </div>
      <p className="mb-4 text-xs text-slate-600">{reservationsKnown
        ? tr("Reserved units remain physically in storage. Available quantities exclude those route reservations.", "الكميات المحجوزة موجودة في المخزن فعلياً، والمتاح يستثني ما خُصص للجولات.")
        : tr("Route reservations are unverified. Physical stock is shown, but reservable stock is hidden until verification.", "تعذر التحقق من حجوزات الجولات. نعرض المخزون الفعلي، لكن المتاح غير ظاهر حتى التحقق.")}</p>
      {filterCounts.review > 0 && filter !== "review" ? (
        <Link href={inventoryFilterHref("review", q)} className="mb-4 block rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
          {tr("Stock needs review", "مخزون يحتاج مراجعة")} ({filterCounts.review}) — {tr("Open exceptions", "عرض الحالات")}
        </Link>
      ) : null}

      {!inventoryRows.length ? (
        <EmptyState
          title={q || filter !== "all" ? tr("No products match this inventory view", "لا توجد منتجات مطابقة") : tr("No storage inventory yet", "لا توجد بيانات مخزون بعد")}
          body={q || filter !== "all" ? tr("Try a broader search or switch filters.", "جرّب بحثاً أوسع أو غيّر الفلتر.") : tr("Create inventory movements into storage to populate calculated balances.", "تظهر الكميات بعد تسجيل حركات المخزون الفعلية.")}
          action={q || filter !== "all" ? <SecondaryButton href="/inventory">{tr("Reset filters", "إعادة تعيين الفلاتر")}</SecondaryButton> : undefined}
        />
      ) : (
        <>
          <MobileCardList>
            {inventoryRows.map((row) => (
              <MobileRecordCard key={row.productId}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words text-base font-semibold text-slate-900">{row.unmapped ? tr("Unmapped product", "منتج غير مطابق") + " · " + row.productId.slice(0, 8) : row.productName}</h2>
                    {!row.active && row.currentQty !== 0 ? <p className="mt-1 text-xs font-semibold text-amber-900">{tr("Inactive product still has stock", "منتج غير مفعّل وما زال فيه مخزون")}</p> : null}
                    <p className="mt-1 break-words text-xs text-slate-500">{row.sku ?? tr("No SKU", "بدون رمز")} - {row.category ?? tr("Uncategorized", "غير مصنّف")}</p>
                  </div>
                  <StatusBadge status={row.status} label={locale === "ar" ? statusLabelsAr[row.status] : undefined} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MobileField label={tr("In storage", "في المخزن")}>{packagedQuantity(row.currentQty, row)}</MobileField>
                  <MobileField label={tr("Reserved in storage", "محجوز للجولات")}>{row.reservedQty === null ? tr("Unverified", "غير مؤكد") : packagedQuantity(row.reservedQty, row)}</MobileField>
                  <MobileField label={tr("Available — no route", "متاح بدون حجز")}><span className="font-semibold text-emerald-800">{row.availableQty === null ? tr("Unverified", "غير مؤكد") : packagedQuantity(row.availableQty, row)}</span></MobileField>
                </div>
                {reservationsKnown && row.reservations.length ? (
                  <details className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-amber-800">{tr("Route reservations", "حجوزات الجولات")} ({row.reservations.length})</summary>
                    <div className="mt-2 space-y-2">
                      {row.reservations.map((reservation) => (
                        <Link key={reservation.routeId} href={`/routes/${reservation.routeId}`} className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm hover:border-amber-300">
                          <span className="font-medium text-slate-900">{tr("Route", "جولة")} {reservation.routeDate ?? reservation.routeId.slice(0, 8)}</span>
                          <span className="shrink-0 text-amber-900">{packagedQuantity(reservation.remainingQty, row)} · {reservation.status.replaceAll("_", " ")}</span>
                        </Link>
                      ))}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-amber-800">{tr("Open a route to change or release its reservation.", "افتح الجولة لتغيير الحجز أو إلغائه.")}</p>
                  </details>
                ) : null}
              </MobileRecordCard>
            ))}
          </MobileCardList>
          <DataTable className="hidden md:block" headers={inventoryHeaders}>
            {inventoryRows.map((row) => (
              <tr key={row.productId}>
                <td>
                  <div className="font-medium text-slate-900">{row.unmapped ? tr("Unmapped product", "منتج غير مطابق") + " · " + row.productId.slice(0, 8) : row.productName}</div>
                  {!row.active && row.currentQty !== 0 ? <p className="mt-1 text-xs font-semibold text-amber-900">{tr("Inactive product still has stock", "منتج غير مفعّل وما زال فيه مخزون")}</p> : null}
                  <div className="text-xs text-slate-500">{row.sku ?? tr("No SKU", "بدون رمز")} - {row.category ?? tr("Uncategorized", "غير مصنّف")}</div>
                </td>
                <td>{packagedQuantity(row.currentQty, row)}</td>
                <td>
                  <div className={row.reservedQty !== null && row.reservedQty > 0 ? "font-semibold text-amber-900" : "text-slate-700"}>{row.reservedQty === null ? tr("Unverified", "غير مؤكد") : row.reservedQty > 0 ? packagedQuantity(row.reservedQty, row) : tr("None", "لا يوجد")}</div>
                  {row.reservations.length ? (
                    <div className="mt-2 space-y-1">
                      {row.reservations.map((reservation) => (
                        <Link key={reservation.routeId} href={`/routes/${reservation.routeId}`} className="block text-xs font-medium text-amber-800 underline decoration-amber-300 underline-offset-2 hover:text-amber-950">
                          {tr("Route", "جولة")} {reservation.routeDate ?? reservation.routeId.slice(0, 8)} · {packagedQuantity(reservation.remainingQty, row)}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </td>
                <td className="font-semibold text-emerald-800">
                  {row.availableQty === null ? tr("Unverified", "غير مؤكد") : packagedQuantity(row.availableQty, row)}
                  <div className="mt-1 text-xs font-normal text-slate-500">{row.availableQty === null ? tr("Reservation data unavailable", "حجوزات الجولات غير متاحة") : row.availableQty > 0 ? tr("No route attached", "غير محجوز لجولة") : row.reservedQty !== null && row.reservedQty > 0 ? tr("All in-storage units reserved", "كل المخزون محجوز") : tr("No stock", "لا يوجد مخزون")}</div>
                </td>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    <StatusBadge status={row.status} label={locale === "ar" ? statusLabelsAr[row.status] : undefined} />
                    {row.reservedQty !== null && row.reservedQty > 0 && row.status !== "reserved" ? <StatusBadge status="reserved" label={tr("Reserved in storage", "محجوز للجولات")} /> : null}
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/inventory" searchParams={params} page={visibleInventoryPage} pageSize={pageSize} totalCount={filteredInventoryRows.length} itemLabel={tr("products", "منتج")} />
        </>
      )}

      <details className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-base font-semibold text-slate-900">
          <span>{tr("Operator bag stock", "مخزون حقائب المشغلين")} <span className="text-sm font-normal text-slate-500">({filteredOperatorBagRows.length} {tr("rows", "صف")})</span></span>
          <span className="text-xs text-slate-500">{tr("Show details ↓", "عرض التفاصيل ↓")}</span>
        </summary>
        <div className="mt-4">
        {!filteredOperatorBagRows.length ? (
          <EmptyState
            title={q ? tr("No operator bag rows match this search", "لا توجد حقائب مطابقة للبحث") : tr("No operator bag stock", "لا يوجد مخزون في حقائب المشغلين")}
            body={q ? tr("Try a broader search or clear the search box.", "جرّب بحثاً أوسع أو امسح البحث.") : tr("Operator bag balances appear after route picking and disappear as machines are filled or leftovers are returned.", "تظهر الكميات بعد سحب البضاعة للجولات، وتقل عند التعبئة أو إرجاع المتبقي.")}
          />
        ) : (
          <>
            <MobileCardList>
              {filteredOperatorBagRows.map((row: any) => (
                <MobileRecordCard key={`${row.location_id}-${row.product_id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-base font-semibold text-slate-900">{row.product_name}</h3>
                      <p className="mt-1 text-xs text-slate-500">{row.sku ?? tr("No SKU", "بدون رمز")}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <MobileField label={tr("Operator", "المشغّل")}>{row.location_name ?? tr("Unknown operator", "مشغّل غير معروف")}</MobileField>
                    <MobileField label={tr("Quantity", "الكمية")}><span className="font-semibold text-slate-950">{packagedQuantity(row.quantity_on_hand, row)}</span></MobileField>
                  </div>
                </MobileRecordCard>
              ))}
            </MobileCardList>
            <DataTable className="hidden md:block" headers={[tr("Operator", "المشغّل"), tr("Product", "المنتج"), tr("SKU", "رمز المنتج"), tr("Quantity", "الكمية")]}>
              {filteredOperatorBagRows.map((row: any) => (
                <tr key={`${row.location_id}-${row.product_id}`}>
                  <td className="font-medium text-slate-900">{row.location_name ?? tr("Unknown operator", "مشغّل غير معروف")}</td>
                  <td>{row.product_name}</td>
                  <td>{row.sku ?? tr("No SKU", "بدون رمز")}</td>
                  <td className="font-semibold">{packagedQuantity(row.quantity_on_hand, row)}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
        </div>
      </details>

      <details className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-base font-semibold text-slate-900">
          <span>{tr("Recent stock movements", "حركات المخزون الأخيرة")} <span className="text-sm font-normal text-slate-500">({filteredMovements.length} {tr("records", "سجل")})</span></span>
          <span className="text-xs text-slate-500">{tr("Show details ↓", "عرض التفاصيل ↓")}</span>
        </summary>
        <div className="mt-4">
        {!filteredMovements.length ? (
          <EmptyState
            title={q ? tr("No movement rows match this search", "لا توجد حركات مطابقة للبحث") : tr("No movements recorded", "لا توجد حركات مسجلة")}
            body={q ? tr("Try a broader search or clear the search box.", "جرّب بحثاً أوسع أو امسح البحث.") : tr("New purchase receipts, route picks, returns, adjustments, and waste movements will appear here.", "تظهر هنا حركات استلام المشتريات، وسحب الجولات، والإرجاع، والجرد، والتالف.")}
          />
        ) : (
          <>
            <MobileCardList>
              {filteredMovements.map((movement: any) => (
                <MobileRecordCard key={movement.id}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-base font-semibold text-slate-900">{movement.product_name}</h3>
                      <p className="mt-1 text-xs text-slate-500">{new Date(movement.created_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}</p>
                    </div>
                    <StatusBadge status={movement.reason} label={locale === "ar" ? movementReasonLabelsAr[String(movement.reason)] : undefined} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label={tr("Qty", "كمية")}>{packagedQuantity(movement.quantity, movement)}</MobileField>
                    <MobileField label={tr("Route", "الجولة")}>{movement.related_route_id ? movement.related_route_id.slice(0, 8) : "-"}</MobileField>
                    <MobileField label={tr("From", "من")}>{movement.from_label}</MobileField>
                    <MobileField label={tr("To", "إلى")}>{movement.to_label}</MobileField>
                  </div>
                </MobileRecordCard>
              ))}
            </MobileCardList>
            <DataTable className="hidden md:block" headers={[tr("Created", "التاريخ"), tr("Product", "المنتج"), tr("Qty", "الكمية"), tr("From", "من"), tr("To", "إلى"), tr("Reason", "السبب"), tr("Route", "الجولة")]}>
              {filteredMovements.map((movement: any) => (
                <tr key={movement.id}>
                  <td>{new Date(movement.created_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}</td>
                  <td className="font-medium">{movement.product_name}</td>
                  <td>{packagedQuantity(movement.quantity, movement)}</td>
                  <td>{movement.from_label}</td>
                  <td>{movement.to_label}</td>
                  <td><StatusBadge status={movement.reason} label={locale === "ar" ? movementReasonLabelsAr[String(movement.reason)] : undefined} /></td>
                  <td>{movement.related_route_id ? movement.related_route_id.slice(0, 8) : "-"}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
        </div>
      </details>
    </div>
  );
}
