export const ROUTE_MANUAL_SALE_PAYMENT_METHODS = ["cash", "card", "other"] as const;
export type RouteManualSalePaymentMethod = (typeof ROUTE_MANUAL_SALE_PAYMENT_METHODS)[number];

export const ROUTE_MANUAL_SALE_STATUSES = ["confirmed", "cancelled"] as const;
export type RouteManualSaleStatus = (typeof ROUTE_MANUAL_SALE_STATUSES)[number];

type RelationRow = Record<string, unknown> | null | undefined;

export type RouteManualSaleRow = {
  id: string;
  route_id?: string | null;
  route_stop_id?: string | null;
  machine_id?: string | null;
  location_id?: string | null;
  operator_id?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | string | null;
  unit_sale_price_lyd?: number | string | null;
  total_amount_lyd?: number | string | null;
  payment_method?: string | null;
  notes?: string | null;
  sale_time?: string | null;
  status?: string | null;
  client_submission_id?: string | null;
  inventory_movement_id?: string | null;
  cash_collection_id?: string | null;
  cancellation_reason?: string | null;
  cancelled_at?: string | null;
  cancelled_by_user_id?: string | null;
  product?: RelationRow | RelationRow[] | null;
};

export type NormalizedRouteManualSale = {
  id: string;
  routeId: string | null;
  routeStopId: string | null;
  machineId: string | null;
  locationId: string | null;
  operatorId: string | null;
  productId: string | null;
  productName: string;
  quantity: number;
  unitSalePriceLyd: number;
  totalAmountLyd: number;
  paymentMethod: RouteManualSalePaymentMethod;
  notes: string;
  saleTime: string | null;
  status: RouteManualSaleStatus | string;
  clientSubmissionId: string | null;
  inventoryMovementId: string | null;
  cashCollectionId: string | null;
  cancellationReason: string;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
};

export type ManualRouteSaleProductPriceSource =
  | "vms_price"
  | "current_product_price"
  | "last_known_sale_price"
  | "manual_input";

export type ManualRouteSalePriceCandidate = {
  currentSellingPriceLyd?: number | string | null;
  lastKnownSalePriceLyd?: number | string | null;
  sellingPrice?: number | string | null;
  vmsSellingPriceLyd?: number | string | null;
};

function relationValue(value: RelationRow | RelationRow[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function cleanRouteManualSaleText(value: unknown) {
  return String(value ?? "").trim();
}

export function parseRouteManualSalePaymentMethod(value: unknown): RouteManualSalePaymentMethod {
  const text = cleanRouteManualSaleText(value).toLowerCase();
  return ROUTE_MANUAL_SALE_PAYMENT_METHODS.includes(text as RouteManualSalePaymentMethod)
    ? (text as RouteManualSalePaymentMethod)
    : "cash";
}

export function parseRouteManualSaleQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function parseRouteManualSalePrice(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Number(parsed.toFixed(2)));
}

export function routeManualSaleTotal(quantity: unknown, unitSalePriceLyd: unknown) {
  const total = parseRouteManualSaleQuantity(quantity) * parseRouteManualSalePrice(unitSalePriceLyd);
  return Number(total.toFixed(2));
}

export function normalizeRouteManualSale(row: RouteManualSaleRow): NormalizedRouteManualSale {
  const product = relationValue(row.product);
  const quantity = parseRouteManualSaleQuantity(row.quantity);
  const unitSalePriceLyd = parseRouteManualSalePrice(row.unit_sale_price_lyd);
  return {
    id: row.id,
    routeId: row.route_id ?? null,
    routeStopId: row.route_stop_id ?? null,
    machineId: row.machine_id ?? null,
    locationId: row.location_id ?? null,
    operatorId: row.operator_id ?? null,
    productId: row.product_id ?? product?.id?.toString?.() ?? null,
    productName: row.product_name ?? String(product?.name ?? "Unknown product"),
    quantity,
    unitSalePriceLyd,
    totalAmountLyd: routeManualSaleTotal(quantity, unitSalePriceLyd),
    paymentMethod: parseRouteManualSalePaymentMethod(row.payment_method),
    notes: cleanRouteManualSaleText(row.notes),
    saleTime: row.sale_time ?? null,
    status: ROUTE_MANUAL_SALE_STATUSES.includes(cleanRouteManualSaleText(row.status) as RouteManualSaleStatus)
      ? (cleanRouteManualSaleText(row.status) as RouteManualSaleStatus)
      : cleanRouteManualSaleText(row.status) || "confirmed",
    clientSubmissionId: row.client_submission_id ?? null,
    inventoryMovementId: row.inventory_movement_id ?? null,
    cashCollectionId: row.cash_collection_id ?? null,
    cancellationReason: cleanRouteManualSaleText(row.cancellation_reason),
    cancelledAt: row.cancelled_at ?? null,
    cancelledByUserId: row.cancelled_by_user_id ?? null,
  };
}

export function manualRouteSalePaymentMethodLabel(value: string | null | undefined) {
  switch (parseRouteManualSalePaymentMethod(value)) {
    case "cash":
      return "Cash";
    case "card":
      return "Card";
    case "other":
      return "Other";
  }
}

export function manualRouteSaleStatusLabel(value: string | null | undefined) {
  switch (cleanRouteManualSaleText(value).toLowerCase()) {
    case "confirmed":
      return "Confirmed";
    case "cancelled":
      return "Cancelled";
    default:
      return cleanRouteManualSaleText(value) || "confirmed";
  }
}

function numericCandidate(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveManualRouteSaleSuggestedPrice(product: ManualRouteSalePriceCandidate) {
  const candidates: Array<{ price: number; source: ManualRouteSaleProductPriceSource }> = [
    { price: numericCandidate(product.vmsSellingPriceLyd), source: "vms_price" },
    { price: numericCandidate(product.currentSellingPriceLyd), source: "current_product_price" },
    { price: numericCandidate(product.sellingPrice), source: "current_product_price" },
    { price: numericCandidate(product.lastKnownSalePriceLyd), source: "last_known_sale_price" },
  ];

  for (const candidate of candidates) {
    if (candidate.price > 0) {
      return candidate;
    }
  }

  return null;
}

export function manualRouteSalePriceSourceLabel(source: ManualRouteSaleProductPriceSource | null | undefined) {
  switch (source) {
    case "vms_price":
      return "VMS product price";
    case "current_product_price":
      return "Internal product price";
    case "last_known_sale_price":
      return "Last known sale price";
    case "manual_input":
    default:
      return "Manual input";
  }
}

