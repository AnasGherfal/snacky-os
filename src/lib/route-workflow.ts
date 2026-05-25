export const ROUTE_STATUSES = [
  "draft",
  "available",
  "ready",
  "assigned",
  "started",
  "in_progress",
  "pickup_confirmed",
  "filling",
  "machine_filling",
  "completed",
  "reviewed",
  "cancelled",
  "canceled",
] as const;

export type RouteStatus = (typeof ROUTE_STATUSES)[number];

export const ROUTE_DATABASE_WRITE_STATUSES = [
  "draft",
  "assigned",
  "in_progress",
  "completed",
  "reviewed",
  "cancelled",
] as const;

export type RouteDatabaseWriteStatus = (typeof ROUTE_DATABASE_WRITE_STATUSES)[number];

export const ROUTE_DRAFT_STATUS = "draft" satisfies RouteStatus;
export const ROUTE_AVAILABLE_STATUS = "available" satisfies RouteStatus;
export const ROUTE_ASSIGNED_STATUS = "assigned" satisfies RouteStatus;
export const ROUTE_IN_PROGRESS_STATUS = "in_progress" satisfies RouteStatus;
export const ROUTE_PICKUP_CONFIRMED_STATUS = "pickup_confirmed" satisfies RouteStatus;
export const ROUTE_FILLING_STATUS = "filling" satisfies RouteStatus;
export const ROUTE_COMPLETED_STATUS = "completed" satisfies RouteStatus;
export const ROUTE_CANCELED_STATUS = "cancelled" satisfies RouteStatus;

export const ROUTE_LEGACY_AVAILABLE_STATUSES = ["ready", "draft"] as const;
export const ROUTE_LEGACY_ACTIVE_STATUSES = ["started", "machine_filling"] as const;
export const ROUTE_LEGACY_TERMINAL_STATUSES = ["reviewed", "canceled"] as const;

export const OPERATOR_VISIBLE_ROUTE_STATUSES = [
  ROUTE_AVAILABLE_STATUS,
  ...ROUTE_LEGACY_AVAILABLE_STATUSES,
] as const;

export const UNSTARTED_ROUTE_STATUSES = [
  ...OPERATOR_VISIBLE_ROUTE_STATUSES,
  ROUTE_ASSIGNED_STATUS,
] as const;

export const ACTIVE_ROUTE_STATUSES = [
  ROUTE_IN_PROGRESS_STATUS,
  ROUTE_PICKUP_CONFIRMED_STATUS,
  ROUTE_FILLING_STATUS,
  ...ROUTE_LEGACY_ACTIVE_STATUSES,
] as const;

export const TERMINAL_ROUTE_STATUSES = [
  ROUTE_COMPLETED_STATUS,
  ROUTE_CANCELED_STATUS,
  ...ROUTE_LEGACY_TERMINAL_STATUSES,
] as const;

export const ROUTE_RESERVATION_STATUSES = [
  ...UNSTARTED_ROUTE_STATUSES,
  ...ACTIVE_ROUTE_STATUSES,
] as const;

export const ROUTE_PICKUP_CONFIRMED_STATUSES = [
  ROUTE_PICKUP_CONFIRMED_STATUS,
  ROUTE_FILLING_STATUS,
  "machine_filling",
  ROUTE_COMPLETED_STATUS,
  "reviewed",
] as const;

export const COMPLETED_ROUTE_STATUSES = [
  ROUTE_COMPLETED_STATUS,
  "reviewed",
] as const;

export const ROUTE_DATABASE_SAFE_TERMINAL_STATUSES = [
  ROUTE_COMPLETED_STATUS,
  "reviewed",
  "cancelled",
] as const;

export const availableRouteStatuses = UNSTARTED_ROUTE_STATUSES;
export const activeRouteStatuses = ACTIVE_ROUTE_STATUSES;
export const terminalRouteStatuses = TERMINAL_ROUTE_STATUSES;

type RouteStopLike = {
  id: string;
  status?: string | null;
  stop_order?: number | null;
};

export const ROUTE_STOP_PENDING_STATUS = "pending";
export const ROUTE_STOP_PICKED_STATUS = "picked";
export const ROUTE_STOP_IN_PROGRESS_STATUS = "in_progress";
export const ROUTE_STOP_COMPLETED_STATUS = "completed";
export const ROUTE_STOP_SKIPPED_STATUS = "skipped";
export const ROUTE_STOP_CANCELED_STATUS = "canceled";

export const ROUTE_STOP_STATUSES = [
  ROUTE_STOP_PENDING_STATUS,
  ROUTE_STOP_PICKED_STATUS,
  ROUTE_STOP_IN_PROGRESS_STATUS,
  ROUTE_STOP_COMPLETED_STATUS,
  ROUTE_STOP_SKIPPED_STATUS,
  ROUTE_STOP_CANCELED_STATUS,
  "arrived",
  "refilling",
  "cash_collected",
  "issue_reported",
] as const;

export const COMPLETED_STOP_STATUSES = [
  ROUTE_STOP_COMPLETED_STATUS,
  ROUTE_STOP_SKIPPED_STATUS,
  ROUTE_STOP_CANCELED_STATUS,
] as const;

export const ACTIVE_STOP_STATUSES = [
  ROUTE_STOP_PICKED_STATUS,
  ROUTE_STOP_IN_PROGRESS_STATUS,
  "arrived",
  "refilling",
  "cash_collected",
  "issue_reported",
] as const;

export const ROUTE_STOP_DONE_STATUSES = COMPLETED_STOP_STATUSES;
export const ROUTE_STOP_ACTIVE_STATUSES = ACTIVE_STOP_STATUSES;

function includesStatus<const T extends readonly string[]>(statuses: T, status: string | null | undefined) {
  return statuses.includes(String(status ?? "") as T[number]);
}

export function isRouteStatus(status: string | null | undefined): status is RouteStatus {
  return includesStatus(ROUTE_STATUSES, status);
}

export function routeStatusForNewRoute(operatorId: string | null | undefined): RouteDatabaseWriteStatus {
  return operatorId ? ROUTE_ASSIGNED_STATUS : ROUTE_DRAFT_STATUS;
}

export function fallbackRouteStatusForEnumMismatch(status: RouteStatus): RouteStatus | null {
  if (status === ROUTE_AVAILABLE_STATUS) return ROUTE_DRAFT_STATUS;
  if (status === ROUTE_PICKUP_CONFIRMED_STATUS || status === ROUTE_FILLING_STATUS) return ROUTE_IN_PROGRESS_STATUS;
  if (status === "canceled") return ROUTE_CANCELED_STATUS;
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
  return includesStatus(UNSTARTED_ROUTE_STATUSES, status);
}

export function isOperatorVisibleRouteStatus(status: string | null | undefined) {
  return includesStatus(OPERATOR_VISIBLE_ROUTE_STATUSES, status);
}

export function isActiveRouteStatus(status: string | null | undefined) {
  return includesStatus(ACTIVE_ROUTE_STATUSES, status);
}

export function isTerminalRouteStatus(status: string | null | undefined) {
  return includesStatus(TERMINAL_ROUTE_STATUSES, status);
}

export function isCompletedRouteStatus(status: string | null | undefined) {
  return includesStatus(COMPLETED_ROUTE_STATUSES, status);
}

export function isRouteReservationStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_RESERVATION_STATUSES, status);
}

export function isPickupConfirmedStatus(status: string | null | undefined) {
  return includesStatus(ROUTE_PICKUP_CONFIRMED_STATUSES, status);
}

export function routeDisplayStatus(status: string | null | undefined, operatorId?: string | null) {
  if (!operatorId && isOperatorVisibleRouteStatus(status)) return ROUTE_AVAILABLE_STATUS;
  return status ?? "unknown";
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
