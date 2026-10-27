import {
  isActiveRouteStatus,
  isRouteStopDoneStatus,
} from "@/lib/route-workflow";

/** Pure presentation ordering for existing assigned routes. No assignment,
 * pickup, stock, cash, route status or stop status mutations.
 */
export type OperatorListRoute = {
  id: string;
  route_date?: string | null;
  status?: string | null;
  route_stops?: readonly { id?: string; status?: string | null }[] | null;
};
export type RouteQueueUrgency = "in_progress" | "overdue" | "today" | "upcoming" | "date_unverified";
export type RouteQueueItem<T extends OperatorListRoute> = {
  route: T;
  urgency: RouteQueueUrgency;
  doneStops: number | null;
  totalStops: number | null;
  unfinishedStops: number | null;
  progressPercent: number | null;
};

const priority: Record<RouteQueueUrgency, number> = {
  in_progress: 0,
  overdue: 1,
  today: 2,
  upcoming: 3,
  date_unverified: 4,
};

function validYmd(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function routeQueueUrgency(route: OperatorListRoute, todayTripoli: string): RouteQueueUrgency {
  if (isActiveRouteStatus(route.status)) return "in_progress";
  if (!validYmd(route.route_date) || !validYmd(todayTripoli)) return "date_unverified";
  if (route.route_date < todayTripoli) return "overdue";
  if (route.route_date === todayTripoli) return "today";
  return "upcoming";
}

export function routeQueueItem<T extends OperatorListRoute>(
  route: T,
  todayTripoli: string,
  stopsVerified: boolean,
): RouteQueueItem<T> {
  const urgency = routeQueueUrgency(route, todayTripoli);
  if (!stopsVerified || !Array.isArray(route.route_stops)) {
    return {route,urgency,doneStops:null,totalStops:null,unfinishedStops:null,progressPercent:null};
  }
  const totalStops = route.route_stops.length;
  const doneStops = route.route_stops.filter(stop => isRouteStopDoneStatus(stop.status)).length;
  return {
    route,urgency,doneStops,totalStops,
    unfinishedStops:totalStops - doneStops,
    progressPercent:totalStops ? Math.round(doneStops / totalStops * 100) : null,
  };
}

/** Active routes, overdue assigned routes, today, then future. Stable and
 * non-mutating; route date ascending within groups helps surface stale work.
 */
export function prioritizeAssignedOperatorRoutes<T extends OperatorListRoute>(
  routes: readonly T[],
  todayTripoli: string,
  stopsVerified: boolean,
): RouteQueueItem<T>[] {
  return routes.map((route,index) => ({...routeQueueItem(route,todayTripoli,stopsVerified),index}))
    .sort((a,b) => {
      const diff = priority[a.urgency] - priority[b.urgency];
      if (diff) return diff;
      const left = validYmd(a.route.route_date) ? a.route.route_date : "9999-12-31";
      const right = validYmd(b.route.route_date) ? b.route.route_date : "9999-12-31";
      return left.localeCompare(right) || a.index - b.index;
    })
    .map(({index:_index,...item}) => item);
}
