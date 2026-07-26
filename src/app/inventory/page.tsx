import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { formatProductQuantity } from "@/lib/product-quantity";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { type RestockPriorityItem } from "@/lib/restock-priority";
import { loadRestockPriorityData } from "@/lib/restock-priority-data";
import { isRouteReservationStatus } from "@/lib/route-workflow";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type InventoryFilter = "all" | "out" | "critical" | "low" | "reserved" | "fast";

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
  currentQty: number;
  reservedQty: number;
  availableQty: number;
  reservations: InventoryRouteReservation[];
  suggestedBuyQty: number;
  routeNeedQty: number;
  salesVelocity: number;
  isFastSeller: boolean;
  restockStatus: RestockPriorityItem["status"];
  restockSection: RestockPriorityItem["section"];
  lastPurchaseCost: number | null;
  reasons: string[];
  status: string;
};

const inventoryFilters: { key: InventoryFilter; label: string }[] = [
  { key: "all", label: "All products" },
  { key: "out", label: "Out of stock" },
  { key: "critical", label: "Critical" },
  { key: "low", label: "Low" },
  { key: "reserved", label: "Reserved for routes" },
  { key: "fast", label: "Fast sellers" },
];

function inventoryStatus(currentQty: number, reservedQty: number, availableQty: number, isCritical: boolean) {
  if (currentQty <= 0) return "out_of_stock";
  if (availableQty <= 0 && reservedQty > 0) return "reserved";
  if (isCritical) return "critical";
  if (availableQty <= 10) return "low_stock";
  return "available";
}

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
    if (filter === "out") return row.currentQty <= 0;
    if (filter === "critical") return row.restockSection === "critical" || row.status === "critical";
    if (filter === "low") return row.status === "low_stock" || row.restockStatus === "low";
    if (filter === "reserved") return row.reservedQty > 0;
    if (filter === "fast") return row.isFastSeller;
    return true;
  });
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
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

  const canSeeCost = canViewFinancials(userContext);
  const restockResult = await loadRestockPriorityData(supabase);
  const [
    { data: operatorBagRowsData, error: operatorBagError },
    { data: movementsData, error: movementsError },
    { data: packagingRowsData, error: packagingError },
    { data: routeReservationsData, error: routeReservationsError },
  ] = await Promise.all([
    supabase
      .from("current_inventory_by_location")
      .select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand")
      .eq("location_type", "operator_bag")
      .order("location_name")
      .order("product_name")
      .limit(2000),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")
      .order("created_at", { ascending: false })
      .limit(250),
    supabase
      .from("products")
      .select("id, name, category, case_quantity")
      .eq("active", true)
      .order("name")
      .limit(5000),
    supabase
      .from("route_stock_lines")
      .select("route_id, product_id, planned_qty, picked_qty, routes!inner(id, route_date, status)")
      .limit(10000),
  ]);

  const queryIssues: InventoryQueryIssue[] = [
    ...Object.entries(restockResult.errors).map(([key, message]) => ({
      key: `restock-${key}`,
      label: "Restock signal unavailable",
      table: key,
      message: `${key}: ${message}`,
    })),
    operatorBagError
      ? logInventoryQueryError({
          key: "ledger_inventory",
          label: "Could not load operator bag stock",
          table: "current_inventory_by_location",
          error: operatorBagError,
          profile,
          params: { location_type: "operator_bag", order: ["location_name", "product_name"], limit: 2000 },
        })
      : null,
    routeReservationsError
      ? logInventoryQueryError({
          key: "route_reservations",
          label: "Could not load route reservation details",
          table: "route_stock_lines + routes",
          error: routeReservationsError,
          profile,
          params: { active_status_rule: "isRouteReservationStatus", limit: 10000 },
        })
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
    packagingError
      ? logInventoryQueryError({
          key: "product_packaging",
          label: "Could not load product box quantities",
          table: "products",
          error: packagingError,
          profile,
          params: { select: "id,name,category,case_quantity", limit: 5000 },
        })
      : null,
  ].filter((issue): issue is InventoryQueryIssue => Boolean(issue));

  const priorityByProductId = new Map(restockResult.items.map((item) => [item.productId, item]));
  const packagingByProductId = new Map((packagingRowsData ?? []).map((row: any) => [String(row.id), {
    productName: row.name ?? null,
    category: row.category ?? null,
    caseQuantity: Math.max(1, Number(row.case_quantity ?? 1)),
  }]));
  const reservationsByProductId = new Map<string, InventoryRouteReservation[]>();
  ((routeReservationsData ?? []) as RouteReservationSourceRow[]).forEach((row) => {
    const route = Array.isArray(row.routes) ? row.routes[0] : row.routes;
    const routeId = String(route?.id ?? row.route_id ?? "").trim();
    const productId = String(row.product_id ?? "").trim();
    const status = String(route?.status ?? "").trim();
    const remainingQty = Math.max(0, Math.floor(Number(row.planned_qty ?? 0)) - Math.floor(Number(row.picked_qty ?? 0)));
    if (!routeId || !productId || remainingQty <= 0 || !isRouteReservationStatus(status)) return;
    reservationsByProductId.set(productId, [
      ...(reservationsByProductId.get(productId) ?? []),
      { routeId, routeDate: route?.route_date ?? null, status, remainingQty },
    ]);
  });
  reservationsByProductId.forEach((reservations) => reservations.sort((left, right) =>
    String(left.routeDate ?? "").localeCompare(String(right.routeDate ?? "")) || left.routeId.localeCompare(right.routeId)
  ));

  const allInventoryRows = restockResult.items
    .map<InventoryRow>((item) => {
      const currentQty = Math.max(0, Number(item.storageQty ?? 0));
      const reservations = reservationsByProductId.get(item.productId) ?? [];
      const reservedQty = routeReservationsError
        ? Math.max(0, Number(item.activeRouteNeedQty ?? 0))
        : reservations.reduce((sum, reservation) => sum + reservation.remainingQty, 0);
      const availableQty = Math.max(0, currentQty - reservedQty);
      const isCritical = item.section === "critical" || item.status === "critical";
      return {
        productId: item.productId,
        productName: item.name,
        sku: item.sku,
        category: item.category,
        brand: item.brand,
        caseQuantity: packagingByProductId.get(item.productId)?.caseQuantity ?? 1,
        currentQty,
        reservedQty,
        availableQty,
        reservations,
        suggestedBuyQty: Math.max(0, Number(item.suggestedBuyQty ?? 0)),
        routeNeedQty: Math.max(0, Number(item.activeRouteNeedQty ?? 0)),
        salesVelocity: Math.max(0, Number(item.salesVelocity ?? 0)),
        isFastSeller: Boolean(item.isFastSeller),
        restockStatus: item.status,
        restockSection: item.section,
        lastPurchaseCost: item.lastPurchaseCost,
        reasons: item.reasons.slice(0, 3),
        status: inventoryStatus(currentQty, reservedQty, availableQty, isCritical),
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));

  const filteredInventoryRows = filterInventoryRows(allInventoryRows, filter, q);
  const totalInventoryPages = Math.max(1, Math.ceil(filteredInventoryRows.length / pageSize));
  const visibleInventoryPage = Math.min(page, totalInventoryPages);
  const inventoryRows = filteredInventoryRows.slice((visibleInventoryPage - 1) * pageSize, visibleInventoryPage * pageSize);

  const filterCounts = {
    all: allInventoryRows.length,
    out: allInventoryRows.filter((row) => row.currentQty <= 0).length,
    critical: allInventoryRows.filter((row) => row.restockSection === "critical" || row.status === "critical").length,
    low: allInventoryRows.filter((row) => row.status === "low_stock" || row.restockStatus === "low").length,
    reserved: allInventoryRows.filter((row) => row.reservedQty > 0).length,
    fast: allInventoryRows.filter((row) => row.isFastSeller).length,
  };

  const operatorBagRows = (operatorBagRowsData ?? [])
    .filter((row: any) => row.location_type === "operator_bag" && Number(row.quantity_on_hand ?? 0) > 0)
    .map((row: any) => {
      const product = priorityByProductId.get(String(row.product_id ?? ""));
      return {
        ...row,
        product_name: row.product_name ?? product?.name ?? "Unknown product",
        sku: product?.sku ?? null,
        category: product?.category ?? packagingByProductId.get(String(row.product_id ?? ""))?.category ?? null,
        case_quantity: packagingByProductId.get(String(row.product_id ?? ""))?.caseQuantity ?? 1,
        isFastSeller: Boolean(product?.isFastSeller),
      };
    })
    .sort((a: any, b: any) => String(a.location_name ?? "").localeCompare(String(b.location_name ?? "")) || String(a.product_name ?? "").localeCompare(String(b.product_name ?? "")));
  const filteredOperatorBagRows = operatorBagRows.filter((row: any) => matchesText([row.product_name, row.location_name, row.sku], q));

  const movements = (movementsData ?? []).map((movement: any) => ({
    ...movement,
    product_name: movement.product?.name ?? priorityByProductId.get(String(movement.product_id ?? ""))?.name ?? "Unknown product",
    category: priorityByProductId.get(String(movement.product_id ?? ""))?.category ?? packagingByProductId.get(String(movement.product_id ?? ""))?.category ?? null,
    case_quantity: packagingByProductId.get(String(movement.product_id ?? ""))?.caseQuantity ?? 1,
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

  const inventoryHeaders = [
    "Product",
    "In storage",
    "Reserved in storage",
    "Available — no route",
    "Suggested buy",
    "Velocity",
    ...(canSeeCost ? ["Last cost"] : []),
    "Status",
  ];

  return (
    <>
      <PageHeader
        title="Storage Inventory"
        subtitle="Physical stock stays in storage until pickup. Reserved stock is already attached to an active route; Available means the units are not attached to any route and can be used for a new one."
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/product-planning">Product Planning</SecondaryButton>
            <SecondaryButton href="/restock-priority">Restock Priority</SecondaryButton>
            <SecondaryButton href="/inventory/machine-storage">Machine Storage</SecondaryButton>
            <SecondaryButton href="/inventory/movements">Movement Log</SecondaryButton>
            <PrimaryButton href="/inventory/movements/new">New Stock Movement</PrimaryButton>
          </div>
        }
      />

      <div className="mb-6 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
        <div className="font-semibold">How route reservations work</div>
        <p className="mt-1 leading-6">Reserved units are still physically in storage, but a route already claims them. Open the linked route to reduce or remove that reservation before assigning the same units to a more important route. Only the Available quantity has no route attached.</p>
      </div>

      {queryIssues.length ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-semibold">Inventory partially loaded</div>
          <div className="mt-1">Some supporting signals could not load. The working sections remain visible below.</div>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            {queryIssues.map((issue) => (
              <li key={issue.key}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <form action="/inventory" className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
            <input type="hidden" name="pageSize" value={pageSize} />
            <SearchInput defaultValue={q} placeholder="Search product, SKU, category, operator, or movement reason..." />
            <button className="btn-secondary" type="submit">Search</button>
            {q ? <Link href={inventoryFilterHref(filter, "")} className="btn-secondary">Clear search</Link> : null}
          </form>
          <div className="text-sm text-slate-500">
            {filteredInventoryRows.length} products match this view.
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {inventoryFilters.map((item) => (
            <Link
              key={item.key}
              href={inventoryFilterHref(item.key, q)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition ${
                filter === item.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-slate-100"
              }`}
            >
              <span>{item.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${filter === item.key ? "bg-white/15 text-white" : "bg-white text-slate-600"}`}>
                {filterCounts[item.key]}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className="mb-6 grid gap-3 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visible storage units</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredInventoryRows.reduce((sum, row) => sum + row.currentQty, 0)}</div>
          <p className="mt-1 text-sm text-slate-500">Units in the current product view</p>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Out or critical</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredInventoryRows.filter((row) => row.currentQty <= 0 || row.status === "critical").length}</div>
          <p className="mt-1 text-sm text-slate-500">Needs attention before routes go out</p>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fast sellers</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredInventoryRows.filter((row) => row.isFastSeller).length}</div>
          <p className="mt-1 text-sm text-slate-500">Products moving quickly in recent sales</p>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reserved for routes</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredInventoryRows.reduce((sum, row) => sum + row.reservedQty, 0)}</div>
          <p className="mt-1 text-sm text-slate-500">Still needed for draft or active routes</p>
        </div>
      </div>

      {!inventoryRows.length ? (
        <EmptyState
          title={q || filter !== "all" ? "No products match this inventory view" : "No storage inventory yet"}
          body={q || filter !== "all" ? "Try a broader search or switch filters." : "Create inventory movements into storage to populate calculated balances."}
          action={q || filter !== "all" ? <SecondaryButton href="/inventory">Reset filters</SecondaryButton> : undefined}
        />
      ) : (
        <>
          <MobileCardList>
            {inventoryRows.map((row) => (
              <MobileRecordCard key={row.productId}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words text-base font-semibold text-slate-900">{row.productName}</h2>
                    <p className="mt-1 break-words text-xs text-slate-500">{row.sku ?? "No SKU"} - {row.category ?? "Uncategorized"}</p>
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <div className="mb-3 flex flex-wrap gap-2">
                  {row.isFastSeller ? <span className="rounded-full bg-sky-100 px-2 py-1 text-xs font-semibold text-sky-800">Fast seller</span> : null}
                  {row.routeNeedQty > 0 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">Needed for routes</span> : null}
                  {row.suggestedBuyQty > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">Buy {packagedQuantity(row.suggestedBuyQty, row)}</span> : null}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MobileField label="Current">{packagedQuantity(row.currentQty, row)}</MobileField>
                  <MobileField label="Reserved">{packagedQuantity(row.reservedQty, row)}</MobileField>
                  <MobileField label="Available"><span className="font-semibold text-slate-950">{packagedQuantity(row.availableQty, row)}</span></MobileField>
                  <MobileField label="Suggested buy">{packagedQuantity(row.suggestedBuyQty, row)}</MobileField>
                  <MobileField label="Route need">{packagedQuantity(row.routeNeedQty, row)}</MobileField>
                  <MobileField label="Velocity">{row.salesVelocity > 0 ? `${row.salesVelocity.toFixed(1)}/day` : "-"}</MobileField>
                </div>
                {canSeeCost ? <div className="mt-3"><MobileField label="Last cost">{row.lastPurchaseCost === null ? "-" : lyd(row.lastPurchaseCost)}</MobileField></div> : null}
                {row.reasons.length ? (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why it matters</div>
                    <ul className="mt-2 space-y-1 text-sm text-slate-700">
                      {row.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </MobileRecordCard>
            ))}
          </MobileCardList>
          <DataTable className="hidden md:block" headers={inventoryHeaders}>
            {inventoryRows.map((row) => (
              <tr key={row.productId}>
                <td>
                  <div className="font-medium text-slate-900">{row.productName}</div>
                  <div className="text-xs text-slate-500">{row.sku ?? "No SKU"} - {row.category ?? "Uncategorized"}</div>
                  <div className="mt-2 text-xs text-slate-500">{row.reasons.join(" - ") || "No extra restock signals"}</div>
                </td>
                <td>{packagedQuantity(row.currentQty, row)}</td>
                <td>{packagedQuantity(row.reservedQty, row)}</td>
                <td className="font-semibold">{packagedQuantity(row.availableQty, row)}</td>
                <td>{packagedQuantity(row.suggestedBuyQty, row)}</td>
                <td>{packagedQuantity(row.routeNeedQty, row)}</td>
                <td>{row.salesVelocity > 0 ? `${row.salesVelocity.toFixed(1)}/day` : "-"}</td>
                {canSeeCost ? <td>{row.lastPurchaseCost === null ? "-" : lyd(row.lastPurchaseCost)}</td> : null}
                <td><StatusBadge status={row.status} /></td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/inventory" searchParams={params} page={visibleInventoryPage} pageSize={pageSize} totalCount={filteredInventoryRows.length} itemLabel="products" />
        </>
      )}

      <section className="mt-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Operator Bag Inventory</h2>
            <p className="text-sm text-slate-500">Stock currently outside storage and assigned to operators.</p>
          </div>
          {q ? <div className="text-sm text-slate-500">{filteredOperatorBagRows.length} rows match the current search</div> : null}
        </div>
        {!filteredOperatorBagRows.length ? (
          <EmptyState
            title={q ? "No operator bag rows match this search" : "No operator bag stock"}
            body={q ? "Try a broader search or clear the search box." : "Operator bag balances appear after route picking and disappear as machines are filled or leftovers are returned."}
          />
        ) : (
          <>
            <MobileCardList>
              {filteredOperatorBagRows.map((row: any) => (
                <MobileRecordCard key={`${row.location_id}-${row.product_id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-base font-semibold text-slate-900">{row.product_name}</h3>
                      <p className="mt-1 text-xs text-slate-500">{row.sku ?? "No SKU"}</p>
                    </div>
                    {row.isFastSeller ? <span className="rounded-full bg-sky-100 px-2 py-1 text-xs font-semibold text-sky-800">Fast seller</span> : null}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <MobileField label="Operator">{row.location_name ?? "Unknown operator"}</MobileField>
                    <MobileField label="Quantity"><span className="font-semibold text-slate-950">{packagedQuantity(row.quantity_on_hand, row)}</span></MobileField>
                  </div>
                </MobileRecordCard>
              ))}
            </MobileCardList>
            <DataTable className="hidden md:block" headers={["Operator", "Product", "SKU", "Quantity"]}>
              {filteredOperatorBagRows.map((row: any) => (
                <tr key={`${row.location_id}-${row.product_id}`}>
                  <td className="font-medium text-slate-900">{row.location_name ?? "Unknown operator"}</td>
                  <td>{row.product_name}</td>
                  <td>{row.sku ?? "No SKU"}</td>
                  <td className="font-semibold">{packagedQuantity(row.quantity_on_hand, row)}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Stock Movement History</h2>
            <p className="text-sm text-slate-500">Recent ledger entries. Stock balances are never edited directly.</p>
          </div>
          {q ? <div className="text-sm text-slate-500">{filteredMovements.length} movements match the current search</div> : null}
        </div>
        {!filteredMovements.length ? (
          <EmptyState
            title={q ? "No movement rows match this search" : "No movements recorded"}
            body={q ? "Try a broader search or clear the search box." : "New purchase receipts, route picks, returns, adjustments, and waste movements will appear here."}
          />
        ) : (
          <>
            <MobileCardList>
              {filteredMovements.map((movement: any) => (
                <MobileRecordCard key={movement.id}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-base font-semibold text-slate-900">{movement.product_name}</h3>
                      <p className="mt-1 text-xs text-slate-500">{new Date(movement.created_at).toLocaleString("en-US")}</p>
                    </div>
                    <StatusBadge status={movement.reason} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label="Qty">{packagedQuantity(movement.quantity, movement)}</MobileField>
                    <MobileField label="Route">{movement.related_route_id ? movement.related_route_id.slice(0, 8) : "-"}</MobileField>
                    <MobileField label="From">{movement.from_label}</MobileField>
                    <MobileField label="To">{movement.to_label}</MobileField>
                  </div>
                </MobileRecordCard>
              ))}
            </MobileCardList>
            <DataTable className="hidden md:block" headers={["Created", "Product", "Qty", "From", "To", "Reason", "Route"]}>
              {filteredMovements.map((movement: any) => (
                <tr key={movement.id}>
                  <td>{new Date(movement.created_at).toLocaleString("en-US")}</td>
                  <td className="font-medium">{movement.product_name}</td>
                  <td>{packagedQuantity(movement.quantity, movement)}</td>
                  <td>{movement.from_label}</td>
                  <td>{movement.to_label}</td>
                  <td><StatusBadge status={movement.reason} /></td>
                  <td>{movement.related_route_id ? movement.related_route_id.slice(0, 8) : "-"}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </section>
    </>
  );
}
