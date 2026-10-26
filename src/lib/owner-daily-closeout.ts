import { isActiveRouteStatus, isRouteStopDoneStatus, isTerminalRouteStatus } from "@/lib/route-workflow";

export type DueRouteRow = {
  id: string;
  route_date: string | null;
  status: string | null;
  operator_id: string | null;
};
export type DueRouteStopRow = {
  id: string;
  route_id: string;
  status: string | null;
};
export type DueRouteAction = "return_bag_count" | "finish_machine_stops" | "review_route";
export type DueRouteReview = {
  routeId: string;
  routeDate: string;
  routeStatus: string;
  operatorAssigned: boolean;
  action: DueRouteAction;
  totalStops: number;
  completedOrSkippedStops: number;
  unfinishedStops: number;
};
export type DueRouteCloseout = {
  verified: true;
  asOfDate: string;
  totalDueOpenRoutes: number;
  routesNeedingBagCountReview: number;
  routesWithUnfinishedStops: number;
  routesNeedingWorkflowReview: number;
  routeQueue: DueRouteReview[];
};

const priority: Record<DueRouteAction, number> = {
  return_bag_count: 0,
  finish_machine_stops: 1,
  review_route: 2,
};

/**
 * Interpret only fully fetched due-date route + stop rows. The return category
 * means "check bag count / physical handoff", NEVER that stock is definitely
 * still in the bag or that completing the route is safe without server checks.
 */
export function buildDueRouteCloseout({
  routes, stops, todayTripoli, maxVisible = 8,
}: {
  routes: readonly DueRouteRow[];
  stops: readonly DueRouteStopRow[];
  todayTripoli: string;
  maxVisible?: number;
}): DueRouteCloseout {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayTripoli)) {
    throw new Error("Missing valid Tripoli business date.");
  }
  const routeIds = new Set(routes.map(route => route.id));
  const grouped = new Map<string, DueRouteStopRow[]>();
  for (const stop of stops) {
    if (!routeIds.has(stop.route_id)) {
      throw new Error("Stop belongs to a route outside the verified due set.");
    }
    grouped.set(stop.route_id, [...(grouped.get(stop.route_id) ?? []), stop]);
  }

  const open: DueRouteReview[] = routes
    .filter(route => !isTerminalRouteStatus(route.status))
    .map(route => {
      const relatedStops = grouped.get(route.id) ?? [];
      const totalStops = relatedStops.length;
      const completedOrSkippedStops = relatedStops.filter(stop => isRouteStopDoneStatus(stop.status)).length;
      const unfinishedStops = totalStops - completedOrSkippedStops;
      const action: DueRouteAction = totalStops === 0 || !route.operator_id
        ? "review_route"
        : unfinishedStops > 0
          ? "finish_machine_stops"
          : isActiveRouteStatus(route.status)
            ? "return_bag_count"
            : "review_route";
      return {
        routeId: route.id,
        routeDate: route.route_date ?? "",
        routeStatus: route.status ?? "unknown",
        operatorAssigned: Boolean(route.operator_id),
        action,
        totalStops,
        completedOrSkippedStops,
        unfinishedStops,
      };
    });

  const sorted = open.map((item,idx) => ({item,idx})).sort((a,b) =>
    priority[a.item.action] - priority[b.item.action]
    || a.item.routeDate.localeCompare(b.item.routeDate)
    || a.idx - b.idx,
  ).map(row => row.item);
  const limit = Number.isFinite(maxVisible) ? Math.max(0,Math.min(20,Math.trunc(maxVisible))) : 8;

  return {
    verified: true,
    asOfDate: todayTripoli,
    totalDueOpenRoutes: sorted.length,
    routesNeedingBagCountReview: sorted.filter(item => item.action === "return_bag_count").length,
    routesWithUnfinishedStops: sorted.filter(item => item.action === "finish_machine_stops").length,
    routesNeedingWorkflowReview: sorted.filter(item => item.action === "review_route").length,
    routeQueue: sorted.slice(0,limit),
  };
}
