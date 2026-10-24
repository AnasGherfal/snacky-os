import { isRouteReservationStatus } from "./route-workflow.ts";

export type StorageProduct = {
  id: string; name: string; sku?: string | null; category?: string | null; brand?: string | null;
  active?: boolean | null; case_quantity?: number | null; min_storage_qty?: number | null;
};
export type StorageLocation = { id: string; name: string; active: boolean };
export type StorageBalance = { product_id: string | null; location_id: string | null; quantity_on_hand: number | string | null };
type RouteRelation = { id: string; route_date?: string | null; status?: string | null };
export type StorageReservationLine = {
  route_id: string; product_id: string | null; planned_qty?: number | string | null;
  picked_qty?: number | string | null; routes?: RouteRelation | RouteRelation[] | null;
};
export type StorageStopNeed = {
  route_id: string; product_id: string | null; planned_quantity?: number | string | null;
  routes?: RouteRelation | RouteRelation[] | null;
};
export type StorageReservation = { routeId: string; date: string | null; status: string; units: number };
export type StorageOverviewRow = {
  productId: string; name: string; sku: string | null; category: string | null; caseQuantity: number;
  active: boolean; physical: number; reserved: number | null; available: number | null;
  status: "negative" | "overbooked" | "unverified" | "empty" | "low" | "stocked";
  reservations: StorageReservation[];
};
export type StorageOverview = {
  rows: StorageOverviewRow[]; physicalUnits: number; stockedProducts: number;
  attentionProducts: number; availableUnits: number | null; reservationsVerified: boolean;
};

const qty = (value: unknown) => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error("Invalid stock quantity. Do not display an estimated ledger balance.");
  return n;
};
const routeInfo = (value: RouteRelation | RouteRelation[] | null | undefined, fallback: string) => {
  const row = Array.isArray(value) ? value[0] : value;
  return { id: row?.id ?? fallback, status: String(row?.status ?? ""), date: row?.route_date ?? null };
};

/** No VMS forecasts or purchase recommendations live here. This is physical ledger stock only. */
export function computeStorageOverview(input: {
  products: StorageProduct[];
  balances: StorageBalance[];
  locations: StorageLocation[];
  routeLines: StorageReservationLine[];
  stopNeeds: StorageStopNeed[];
  reservationsVerified: boolean;
}): StorageOverview {
  const activeLocations = new Set(input.locations
    .filter(loc => loc.active && !/^\[TEST ONLY\]/i.test(loc.name))
    .map(loc => loc.id));
  if (!activeLocations.size) throw new Error("No active physical storage location can be verified.");
  const physical = new Map<string, number>();
  for (const balance of input.balances) {
    if (!balance.product_id || !balance.location_id || !activeLocations.has(balance.location_id)) continue;
    physical.set(balance.product_id, (physical.get(balance.product_id) ?? 0) + qty(balance.quantity_on_hand));
  }
  const grouped = new Map<string, Map<string, StorageReservation>>();
  const authoritative = new Set<string>();
  for (const line of input.routeLines) {
    if (!line.product_id) continue;
    const route = routeInfo(line.routes, line.route_id);
    if (!route.id || !isRouteReservationStatus(route.status)) continue;
    const key = `${route.id}:${line.product_id}`;
    authoritative.add(key);
    const outstanding = Math.max(0, qty(line.planned_qty) - qty(line.picked_qty));
    if (!outstanding) continue;
    const slots = grouped.get(line.product_id) ?? new Map<string, StorageReservation>();
    slots.set(route.id, { routeId: route.id, date: route.date, status: route.status, units: outstanding });
    grouped.set(line.product_id, slots);
  }
  // Older routes may have stop-level quantities without a route-stock summary.
  // Account for the entire route/product once, but never add it over an existing summary.
  for (const need of input.stopNeeds) {
    if (!need.product_id) continue;
    const route = routeInfo(need.routes, need.route_id);
    if (!route.id || !isRouteReservationStatus(route.status)) continue;
    if (authoritative.has(`${route.id}:${need.product_id}`)) continue;
    const outstanding = Math.max(0, qty(need.planned_quantity));
    if (!outstanding) continue;
    const slots = grouped.get(need.product_id) ?? new Map<string, StorageReservation>();
    const previous = slots.get(route.id);
    slots.set(route.id, { routeId: route.id, date: route.date, status: route.status, units: (previous?.units ?? 0) + outstanding });
    grouped.set(need.product_id, slots);
  }
  const rows = input.products.filter(p => p.active || physical.has(p.id)).map<StorageOverviewRow>(product => {
    const onHand = physical.get(product.id) ?? 0; // Zero is known only because the storage ledger loaded successfully.
    const reservations = [...(grouped.get(product.id)?.values() ?? [])]
      .sort((a,b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || a.routeId.localeCompare(b.routeId));
    const reserved = input.reservationsVerified ? reservations.reduce((sum,r) => sum+r.units, 0) : null;
    const available = reserved === null ? null : Math.max(0, onHand-reserved);
    const min = Math.max(0, qty(product.min_storage_qty));
    const lowThreshold = min > 0 ? min : 10; // Only an on-hand hint; use the sales-based Buy page for purchasing.
    const status = onHand < 0 ? "negative"
      : reserved !== null && reserved > onHand ? "overbooked"
      : reserved === null ? "unverified"
      : onHand === 0 ? "empty"
      : available !== null && available <= lowThreshold ? "low"
      : "stocked";
    return {
      productId: product.id, name: product.name, sku: product.sku ?? null, category: product.category ?? null,
      caseQuantity: Math.max(1, qty(product.case_quantity ?? 1)),
      active: Boolean(product.active), physical: onHand, reserved, available, status, reservations,
    };
  }).sort((a,b) => a.name.localeCompare(b.name));
  return {
    rows,
    physicalUnits: rows.reduce((n,row) => n+row.physical,0),
    stockedProducts: rows.filter(r=>r.physical>0).length,
    attentionProducts: rows.filter(r=>["negative","overbooked","low","unverified"].includes(r.status)).length,
    availableUnits: input.reservationsVerified ? rows.reduce((n,row)=>n+(row.available??0),0) : null,
    reservationsVerified: input.reservationsVerified,
  };
}
