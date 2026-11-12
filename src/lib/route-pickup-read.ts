import type { SupabaseClient } from '@supabase/supabase-js';
import { readCompleteList } from './complete-list-read.ts';

/** Read-only helper. Call only after checking this user's access to routeId.
 * Keep the same route filter on every page; never return a partial pick list.
 */
export function readPickupRouteRows(
  db: SupabaseClient,
  table: 'route_stops' | 'route_stop_items' | 'route_pick_list_items',
  fields: string,
  routeId: string,
  signal: AbortSignal,
) {
  return readCompleteList<Record<string, any>>(({ from, to, signal }) => {
    let query = db.from(table).select(fields, { count: 'exact' }).eq('route_id', routeId);
    if (table === 'route_stops') query = query.order('stop_order', { ascending: true });
    return query.order('id').range(from, to).abortSignal(signal);
  }, { key: row => String(row.id ?? ''), signal, maxRows: 20000 });
}
