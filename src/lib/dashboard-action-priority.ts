/**
 * Display priorities for the existing Snacky dashboard action queue.
 * This is presentation ordering only; it never creates a route, mutates cash,
 * reconciles inventory or changes the underlying source/status of an action.
 *
 * Cash custody, critical machines, and stock integrity are surfaced before
 * lower-urgency import and routine route-planning tasks. Unrecognized actions
 * remain visible at the end of the queue in their original order.
 */
const actionPriority: Readonly<Record<string, number>> = {
  "critical-issues": 100,
  "cash-waiting": 98,
  "route-inventory-review": 96,
  "machine-quantity-updates": 94,
  "critical-restock": 92,
  "finance-gaps": 90,
  "pending-routes": 85,
  "refill-routes": 80,
  "missing-stock-snapshot": 70,
  "failed-imports": 68,
  "missing-detailed-sales": 65,
};

export function prioritizeDashboardActions<T extends {key: string}>(
  items: readonly T[],
): T[] {
  // Non-mutating stable sort: original order is the tie-breaker.
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) =>
      (actionPriority[b.item.key] ?? 0) - (actionPriority[a.item.key] ?? 0)
      || a.index - b.index,
    )
    .map(({item}) => item);
}

export function splitDashboardActions<T extends {key: string}>(
  items: readonly T[],
  maxVisible = 3,
): { priority: T[]; remaining: T[] } {
  const sorted = prioritizeDashboardActions(items);
  const count = Math.max(0, Math.min(5, Math.floor(Number.isFinite(maxVisible) ? maxVisible : 3)));
  return { priority: sorted.slice(0, count), remaining: sorted.slice(count) };
}
