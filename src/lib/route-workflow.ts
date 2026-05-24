export const availableRouteStatuses = ["available", "ready", "assigned", "draft"] as const;
export const activeRouteStatuses = ["started", "in_progress", "pickup_confirmed", "machine_filling"] as const;
export const terminalRouteStatuses = ["completed", "reviewed", "cancelled", "canceled"] as const;

type RouteStopLike = {
  id: string;
  status?: string | null;
  stop_order?: number | null;
};

export function isAvailableRouteStatus(status: string | null | undefined) {
  return availableRouteStatuses.includes(String(status ?? "") as (typeof availableRouteStatuses)[number]);
}

export function isActiveRouteStatus(status: string | null | undefined) {
  return activeRouteStatuses.includes(String(status ?? "") as (typeof activeRouteStatuses)[number]);
}

export function isTerminalRouteStatus(status: string | null | undefined) {
  return terminalRouteStatuses.includes(String(status ?? "") as (typeof terminalRouteStatuses)[number]);
}

export function isPickupConfirmedStatus(status: string | null | undefined) {
  return ["pickup_confirmed", "machine_filling", "completed", "reviewed"].includes(String(status ?? ""));
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

  const nextStop = [...stops]
    .filter((stop) => stop.status !== "completed")
    .sort((a, b) => Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0))[0];

  return nextStop ? `/operator/routes/${routeId}/stops/${nextStop.id}` : `/operator/routes/${routeId}/leftovers`;
}
