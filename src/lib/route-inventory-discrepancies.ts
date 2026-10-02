export const ROUTE_INVENTORY_OPEN_STATUSES = ["open", "investigating"] as const;
export const ROUTE_INVENTORY_CLOSED_STATUSES = ["resolved", "accepted_loss", "voided"] as const;

export type RouteInventoryDiscrepancyStatus =
  | (typeof ROUTE_INVENTORY_OPEN_STATUSES)[number]
  | (typeof ROUTE_INVENTORY_CLOSED_STATUSES)[number];

export type RouteInventoryDiscrepancyRow = {
  id: string;
  route_id: string;
  route_stop_id: string | null;
  machine_id: string | null;
  operator_id: string | null;
  product_id: string;
  discrepancy_type: string;
  recorded_quantity: number | string | null;
  actual_quantity: number | string | null;
  difference_quantity: number | string | null;
  absolute_quantity: number | string | null;
  status: RouteInventoryDiscrepancyStatus | string;
  source_type: string;
  source_id: string;
  details: Record<string, unknown> | null;
  detected_at: string;
  resolution_type: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  correcting_movement_id: string | null;
  updated_at: string;
};

export type RouteInventoryReconciliationLineEvidence = {
  discrepancy_id: string | null;
  adjustment_movement_id: string | null;
  return_movement_id: string | null;
  review_status: string;
};

export function routeInventoryErrorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" - ");
}

export function isMissingRouteInventoryReviewSchema(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return ["42P01", "PGRST202", "PGRST204", "PGRST205"].includes(code);
}

export function routeInventoryDiscrepancyIsOpen(status: unknown) {
  return ROUTE_INVENTORY_OPEN_STATUSES.includes(String(status ?? "") as (typeof ROUTE_INVENTORY_OPEN_STATUSES)[number]);
}

export function routeInventoryDiscrepancyStatusLabel(status: unknown, locale: "en" | "ar") {
  const value = String(status ?? "").toLowerCase();
  const labels: Record<string, { en: string; ar: string }> = {
    open: { en: "Open", ar: "مفتوحة" },
    investigating: { en: "Investigating", ar: "قيد التحقيق" },
    resolved: { en: "Resolved", ar: "تمت التسوية" },
    accepted_loss: { en: "Accepted loss", ar: "خسارة معتمدة" },
    voided: { en: "Voided", ar: "ملغاة" },
  };
  return labels[value]?.[locale] ?? value.replaceAll("_", " ");
}

export function routeInventoryDiscrepancyTypeLabel(type: unknown, locale: "en" | "ar") {
  const value = String(type ?? "").toLowerCase();
  const labels: Record<string, { en: string; ar: string }> = {
    stop_shortage: { en: "Unrecorded stock used at stop", ar: "مخزون مستخدم في الموقع وغير مسجل" },
    stop_overage: { en: "Stop stock overage", ar: "زيادة مخزون في الموقع" },
    terminal_shortage: { en: "End-of-route shortage", ar: "عجز عند إنهاء الجولة" },
    terminal_overage: { en: "End-of-route overage", ar: "زيادة عند إنهاء الجولة" },
    negative_bag_balance: { en: "Negative operator-bag balance", ar: "رصيد حقيبة المشغل سالب" },
    unreturned_stock: { en: "Stock not returned", ar: "مخزون لم تتم إعادته" },
    other: { en: "Inventory difference", ar: "فرق في المخزون" },
  };
  return labels[value]?.[locale] ?? value.replaceAll("_", " ");
}

export function routeInventoryDiscrepancyHasCorrection(
  discrepancy: Pick<RouteInventoryDiscrepancyRow, "correcting_movement_id">,
  evidence?: RouteInventoryReconciliationLineEvidence | null,
) {
  return Boolean(discrepancy.correcting_movement_id || evidence?.adjustment_movement_id);
}
