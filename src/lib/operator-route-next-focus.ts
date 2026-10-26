import {
  nextOperatorRouteHref,
  isRouteStopDoneStatus,
  type RouteStopLike,
} from "@/lib/route-workflow";

type RouteFocusStop = RouteStopLike & {machine_id?: string | null};

export type OperatorRouteNextFocus = {
  href: string;
  kind: "pickup" | "machine" | "leftovers";
  stopId: string | null;
  doneStops: number;
  unfinishedStops: number;
  totalStops: number;
};

/**
 * Presentation-only next-step selector. Delegate URL choice to the SAME
 * existing route-workflow implementation as operator navigation; do not
 * derive independent workflow state, claim a machine or bypass pickup.
 */
export function operatorRouteNextFocus({
  routeId,
  routeStatus,
  hasPickup,
  routeProductsPrepared,
  stops,
}: {
  routeId: string;
  routeStatus: string | null | undefined;
  hasPickup: boolean;
  routeProductsPrepared: boolean;
  stops: readonly RouteFocusStop[];
}): OperatorRouteNextFocus | null {
  const totalStops = stops.length;
  const doneStops = stops.filter(stop => isRouteStopDoneStatus(stop.status)).length;
  if (!routeProductsPrepared || totalStops === 0) return null;
  const href = nextOperatorRouteHref({
    routeId,
    status: routeStatus,
    hasPickup,
    stops: [...stops],
    start: true,
  });
  if (!href) return null;

  const matchingStop = stops.find(stop => href === `/operator/routes/${routeId}/stops/${stop.id}`) ?? null;
  const kind: OperatorRouteNextFocus["kind"] = matchingStop
    ? "machine"
    : href.startsWith(`/operator/routes/${routeId}/leftovers`)
      ? "leftovers"
      : "pickup";
  return {
    href,
    kind,
    stopId: matchingStop?.id ?? null,
    doneStops,
    unfinishedStops: totalStops - doneStops,
    totalStops,
  };
}
