export const ROUTE_STATUSES = {
  DRAFT: "draft",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  PICKUP_CONFIRMED: "pickup_confirmed",
  COMPLETED: "completed",
  VERIFIED: "verified",
  PAYROLL_PENDING: "payroll_pending",
  PAID: "paid",
  DISPUTED: "disputed",
  REVIEWED: "reviewed",
  CANCELLED: "cancelled",
} as const;

export const ROUTE_STATUS_VALUES = [
  ROUTE_STATUSES.DRAFT,
  ROUTE_STATUSES.ASSIGNED,
  ROUTE_STATUSES.IN_PROGRESS,
  ROUTE_STATUSES.PICKUP_CONFIRMED,
  ROUTE_STATUSES.COMPLETED,
  ROUTE_STATUSES.VERIFIED,
  ROUTE_STATUSES.PAYROLL_PENDING,
  ROUTE_STATUSES.PAID,
  ROUTE_STATUSES.DISPUTED,
  ROUTE_STATUSES.REVIEWED,
  ROUTE_STATUSES.CANCELLED,
] as const;

export type RouteStatus = (typeof ROUTE_STATUS_VALUES)[number];

export const ROUTE_DRAFT_STATUS = ROUTE_STATUSES.DRAFT;
export const ROUTE_ASSIGNED_STATUS = ROUTE_STATUSES.ASSIGNED;
export const ROUTE_IN_PROGRESS_STATUS = ROUTE_STATUSES.IN_PROGRESS;
export const ROUTE_PICKUP_CONFIRMED_STATUS = ROUTE_STATUSES.PICKUP_CONFIRMED;
export const ROUTE_COMPLETED_STATUS = ROUTE_STATUSES.COMPLETED;
export const ROUTE_VERIFIED_STATUS = ROUTE_STATUSES.VERIFIED;
export const ROUTE_PAYROLL_PENDING_STATUS = ROUTE_STATUSES.PAYROLL_PENDING;
export const ROUTE_PAID_STATUS = ROUTE_STATUSES.PAID;
export const ROUTE_DISPUTED_STATUS = ROUTE_STATUSES.DISPUTED;
export const ROUTE_REVIEWED_STATUS = ROUTE_STATUSES.REVIEWED;
export const ROUTE_CANCELED_STATUS = ROUTE_STATUSES.CANCELLED;

export const ROUTE_AVAILABLE_STATUS = "available";

const LEGACY_AVAILABLE_ROUTE_STATUSES = ["available", "ready"] as const;
const LEGACY_ACTIVE_ROUTE_STATUSES = ["started", "filling", "machine_filling", "partially_completed", "stop_completed"] as const;
const LEGACY_TERMINAL_ROUTE_STATUSES = ["canceled", "archived", "deleted"] as const;

export const ROUTE_DATABASE_WRITE_STATUSES = ROUTE_STATUS_VALUES;
export type RouteDatabaseWriteStatus = RouteStatus;

export const REQUIRED_ROUTE_DATABASE_STATUSES = ROUTE_STATUS_VALUES;

export const OPERATOR_VISIBLE_ROUTE_STATUSES = [
  ROUTE_DRAFT_STATUS,
] as const;

export const UNSTARTED_ROUTE_STATUSES = [
  ...OPERATOR_VISIBLE_ROUTE_STATUSES,
  ROUTE_ASSIGNED_STATUS,
] as const;

export const ACTIVE_ROUTE_STATUSES = [
  ROUTE_IN_PROGRESS_STATUS,
  ROUTE_PICKUP_CONFIRMED_STATUS,
] as const;

// Exact statuses accepted by the atomic terminal inventory RPC. Keep this
// narrower than the general legacy-active family: partially-completed legacy
// routes still need an explicit repair before they can be finalized safely.
export const ROUTE_INVENTORY_FINALIZABLE_STATUSES = [
  ROUTE_IN_PROGRESS_STATUS,
  ROUTE_PICKUP_CONFIRMED_STATUS,
  "started",
  "filling",
  "machine_filling",
] as const;

export const TERMINAL_ROUTE_STATUSES = [
  ROUTE_COMPLETED_STATUS,
  ROUTE_VERIFIED_STATUS,
  ROUTE_PAYROLL_PENDING_STATUS,
  ROUTE_PAID_STATUS,
  ROUTE_DISPUTED_STATUS,
  ROUTE_CANCELED_STATUS,
  ROUTE_REVIEWED_STATUS,
] as const;

export const ROUTE_RESERVATION_STATUSES = [
  ...UNSTARTED_ROUTE_STATUSES,
  ...ACTIVE_ROUTE_STATUSES,
] as const;

export const ROUTE_PICKUP_CONFIRMED_STATUSES = [
  ROUTE_PICKUP_CONFIRMED_STATUS,
  ROUTE_COMPLETED_STATUS,
  ROUTE_VERIFIED_STATUS,
  ROUTE_PAYROLL_PENDING_STATUS,
  ROUTE_PAID_STATUS,
  ROUTE_DISPUTED_STATUS,
  ROUTE_REVIEWED_STATUS,
] as const;

export const COMPLETED_ROUTE_STATUSES = [
  ROUTE_COMPLETED_STATUS,
  ROUTE_VERIFIED_STATUS,
  ROUTE_PAYROLL_PENDING_STATUS,
  ROUTE_PAID_STATUS,
  ROUTE_DISPUTED_STATUS,
  ROUTE_REVIEWED_STATUS,
] as const;

export const ROUTE_DATABASE_SAFE_TERMINAL_STATUSES = [
  ROUTE_COMPLETED_STATUS,
  ROUTE_REVIEWED_STATUS,
  ROUTE_CANCELED_STATUS,
] as const;

export const availableRouteStatuses = UNSTARTED_ROUTE_STATUSES;
export const activeRouteStatuses = ACTIVE_ROUTE_STATUSES;
export const terminalRouteStatuses = TERMINAL_ROUTE_STATUSES;

type RouteStopLike = {
  id: string;
  status?: string | null;
  stop_order?: number | null;
};

export const ROUTE_STOP_STATUSES = {
  PENDING: "pending",
  PICKED: "picked",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  CANCELED: "canceled",
  ARRIVED: "arrived",
  REFILLING: "refilling",
  CASH_COLLECTED: "cash_collected",
  ISSUE_REPORTED: "issue_reported",
} as const;

export const ROUTE_STOP_STATUS_VALUES = [
  ROUTE_STOP_STATUSES.PENDING,
  ROUTE_STOP_STATUSES.PICKED,
  ROUTE_STOP_STATUSES.IN_PROGRESS,
  ROUTE_STOP_STATUSES.COMPLETED,
  ROUTE_STOP_STATUSES.SKIPPED,
  ROUTE_STOP_STATUSES.CANCELED,
  ROUTE_STOP_STATUSES.ARRIVED,
  ROUTE_STOP_STATUSES.REFILLING,
  ROUTE_STOP_STATUSES.CASH_COLLECTED,
  ROUTE_STOP_STATUSES.ISSUE_REPORTED,
] as const;

export const REQUIRED_ROUTE_STOP_DATABASE_STATUSES = ROUTE_STOP_STATUS_VALUES;

export const ROUTE_STOP_PENDING_STATUS = ROUTE_STOP_STATUSES.PENDING;
export const ROUTE_STOP_PICKED_STATUS = ROUTE_STOP_STATUSES.PICKED;
export const ROUTE_STOP_IN_PROGRESS_STATUS = ROUTE_STOP_STATUSES.IN_PROGRESS;
export const ROUTE_STOP_COMPLETED_STATUS = ROUTE_STOP_STATUSES.COMPLETED;
export const ROUTE_STOP_SKIPPED_STATUS = ROUTE_STOP_STATUSES.SKIPPED;
export const ROUTE_STOP_CANCELED_STATUS = ROUTE_STOP_STATUSES.CANCELED;

export const COMPLETED_STOP_STATUSES = [
  ROUTE_STOP_COMPLETED_STATUS,
  ROUTE_STOP_SKIPPED_STATUS,
  ROUTE_STOP_CANCELED_STATUS,
] as const;

export const ACTIVE_STOP_STATUSES = [
  ROUTE_STOP_PICKED_STATUS,
  ROUTE_STOP_IN_PROGRESS_STATUS,
  ROUTE_STOP_STATUSES.ARRIVED,
  ROUTE_STOP_STATUSES.REFILLING,
  ROUTE_STOP_STATUSES.CASH_COLLECTED,
  ROUTE_STOP_STATUSES.ISSUE_REPORTED,
] as const;

export const ROUTE_STOP_DONE_STATUSES = COMPLETED_STOP_STATUSES;
export const ROUTE_STOP_ACTIVE_STATUSES = ACTIVE_STOP_STATUSES;

function includesStatus<const T extends readonly string[]>(statuses: T, status: string | null | undefined) {
  return statuses.includes(String(status ?? "") as T[number]);
}

export function isRouteStatus(status: string | null | undefined): status is RouteStatus {
  return includesStatus(ROUTE_STATUS_VALUES, status);
}

export function isRouteInventoryFinalizableStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_INVENTORY_FINALIZABLE_STATUSES, status);
}

export function routeStatusForNewRoute(operatorId: string | null | undefined): RouteDatabaseWriteStatus {
  return operatorId ? ROUTE_ASSIGNED_STATUS : ROUTE_DRAFT_STATUS;
}

export function fallbackRouteStatusForEnumMismatch(status: string | null | undefined): RouteStatus | null {
  if (status === ROUTE_PICKUP_CONFIRMED_STATUS) return ROUTE_IN_PROGRESS_STATUS;
  return null;
}

export function isRouteStatusEnumMismatch(error: unknown, status?: string | null) {
  if (!error || typeof error !== "object") return false;
  const text = ["message", "details", "hint", "code"]
    .map((key) => String((error as Record<string, unknown>)[key] ?? ""))
    .join(" ")
    .toLowerCase();
  return text.includes("invalid input value for enum route_status") && (!status || text.includes(String(status).toLowerCase()));
}

export function isAvailableRouteStatus(status: string | null | undefined) {
  return includesStatus(UNSTARTED_ROUTE_STATUSES, status) || includesStatus(LEGACY_AVAILABLE_ROUTE_STATUSES, status);
}

export function isOperatorVisibleRouteStatus(status: string | null | undefined) {
  return includesStatus(OPERATOR_VISIBLE_ROUTE_STATUSES, status) || includesStatus(LEGACY_AVAILABLE_ROUTE_STATUSES, status);
}

export function isActiveRouteStatus(status: string | null | undefined) {
  return includesStatus(ACTIVE_ROUTE_STATUSES, status) || includesStatus(LEGACY_ACTIVE_ROUTE_STATUSES, status);
}

export function isTerminalRouteStatus(status: string | null | undefined) {
  return includesStatus(TERMINAL_ROUTE_STATUSES, status) || includesStatus(LEGACY_TERMINAL_ROUTE_STATUSES, status);
}

export function isRouteItemsEditableStatus(status: string | null | undefined) {
  return Boolean(String(status ?? "").trim()) && !isTerminalRouteStatus(status);
}

export function isCompletedRouteStatus(status: string | null | undefined) {
  return includesStatus(COMPLETED_ROUTE_STATUSES, status);
}

export function isRouteReservationStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_RESERVATION_STATUSES, status) || includesStatus(LEGACY_AVAILABLE_ROUTE_STATUSES, status) || includesStatus(LEGACY_ACTIVE_ROUTE_STATUSES, status);
}

export function isPickupConfirmedStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_PICKUP_CONFIRMED_STATUSES, status);
}

export function routeDisplayStatus(status: string | null | undefined, operatorId?: string | null) {
  if (!operatorId && isOperatorVisibleRouteStatus(status)) return ROUTE_AVAILABLE_STATUS;
  return status ?? "unknown";
}

export function missingRouteWorkflowStatuses({
  routeStatuses,
  routeStopStatuses,
}: {
  routeStatuses: readonly string[];
  routeStopStatuses: readonly string[];
}) {
  const routeStatusSet = new Set(routeStatuses);
  const stopStatusSet = new Set(routeStopStatuses);
  return {
    routeStatuses: REQUIRED_ROUTE_DATABASE_STATUSES.filter((status) => !routeStatusSet.has(status)),
    routeStopStatuses: REQUIRED_ROUTE_STOP_DATABASE_STATUSES.filter((status) => !stopStatusSet.has(status)),
  };
}

export function isRouteStopDoneStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_STOP_DONE_STATUSES, status);
}

export function isRouteStopActiveStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_STOP_ACTIVE_STATUSES, status);
}

export function isRouteStopPendingStatus(status: string | null | undefined) {
  return String(status ?? "") === ROUTE_STOP_PENDING_STATUS;
}

export function nextOperatorRouteHref({
  routeId,
  status,
  hasPickup,
  stops,
  start = false,
}: {
  routeId: string;
  status?: string | null;
  hasPickup: boolean;
  stops: RouteStopLike[];
  start?: boolean;
}) {
  if (!routeId || isTerminalRouteStatus(status)) return null;

  if (isAvailableRouteStatus(status) || !hasPickup) {
    return `/operator/routes/${routeId}/pick-list${start ? "?start=1" : ""}`;
  }

  const activeStop = [...stops]
    .filter((stop) => isRouteStopActiveStatus(stop.status))
    .sort((a, b) => Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0))[0];

  if (activeStop) return `/operator/routes/${routeId}/stops/${activeStop.id}`;

  const hasPendingStops = stops.some((stop) => isRouteStopPendingStatus(stop.status));
  if (hasPendingStops) return `/operator/routes/${routeId}/pick-list${start ? "?start=1" : ""}`;

  const nextStop = [...stops]
    .filter((stop) => !isRouteStopDoneStatus(stop.status))
    .sort((a, b) => Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0))[0];

  return nextStop ? `/operator/routes/${routeId}/stops/${nextStop.id}` : `/operator/routes/${routeId}/leftovers`;
}
