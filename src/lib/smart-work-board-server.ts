import 'server-only';
import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes, canManageOperations } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { loadAccessibleOperatorIds } from '@/lib/operator-route-access';
import { ROUTE_RESERVATION_STATUSES, isRouteStopDoneStatus } from '@/lib/route-workflow';
import { summarizeWorkMachine, physicalWorkLane, WORK_PRIORITY_ORDER, workDayInTripoli } from '@/lib/smart-work-board';

type ReadResult = { data: unknown[] | null; error: { message: string } | null };
async function allRows<T>(page: (from: number, to: number) => PromiseLike<ReadResult>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < 50_000; start += 500) {
    const result = await page(start, start + 499);
    if (result.error || !Array.isArray(result.data)) throw new Error('Work board data could not be verified.');
    rows.push(...result.data as T[]);
    if (result.data.length < 500) return rows;
  }
  throw new Error('Work board read exceeded its safe limit.');
}
type MachineRow = { id: string; name: string | null; machine_code: string | null; refill_open_days: number[] | null };
type StockRow = { machine_id: string; slot_code: string; product_id: string | null; current_qty: unknown; capacity: unknown; captured_at: string | null };
type SlotRow = { id: string; machine_id: string; slot_code: string; active: boolean };
type RouteRow = { id: string; operator_id: string | null; route_date: string; status: string };
type StopRow = { id: string; route_id: string; machine_id: string; status: string };
type OperatorRow = { id: string; full_name: string; active: boolean; active_status: string };

/** All authorization precedes privileged reads. No sync, RPC, writes or client-supplied scope. */
export async function loadSmartWorkBoard(now = new Date()) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || profile.must_change_password || !canExecuteRoutes(profile)) throw new Error('Work board access denied.');
  const db = getSupabaseAdminClient();
  if (!db) throw new Error('Work board connection unavailable.');
  const [machines, stock, slots, routes, accessibleIds] = await Promise.all([
    allRows<MachineRow>((a,b) => db.from('machines').select('id,name,machine_code,refill_open_days').eq('status','active').order('id').range(a,b)),
    allRows<StockRow>((a,b) => db.from('latest_vms_stock_by_slot').select('machine_id,slot_code,product_id,current_qty,capacity,captured_at').eq('source_provider','xy').order('machine_id').order('slot_code').range(a,b)),
    allRows<SlotRow>((a,b) => db.from('machine_slots').select('id,machine_id,slot_code,active').order('id').range(a,b)),
    allRows<RouteRow>((a,b) => db.from('routes').select('id,operator_id,route_date,status').in('status',[...ROUTE_RESERVATION_STATUSES]).order('id').range(a,b)),
    loadAccessibleOperatorIds(db, profile),
  ]);
  const stops: StopRow[] = [], people: OperatorRow[] = [];
  for (let offset = 0; offset < routes.length; offset += 100) {
    const ids = routes.slice(offset,offset+100).map(r=>r.id);
    stops.push(...await allRows<StopRow>((a,b)=>db.from('route_stops').select('id,route_id,machine_id,status').in('route_id',ids).order('id').range(a,b)));
  }
  const peopleIds = [...new Set(routes.map(r=>r.operator_id).filter((id): id is string=>Boolean(id)))];
  for (let offset = 0; offset < peopleIds.length; offset += 100) {
    people.push(...await allRows<OperatorRow>((a,b)=>db.from('team_members').select('id,full_name,active,active_status').in('id',peopleIds.slice(offset,offset+100)).order('id').range(a,b)));
  }
  const routeById = new Map(routes.map(r=>[r.id,r])), peopleById = new Map(people.map(p=>[p.id,p]));
  const activeStops = stops.filter(s=>!isRouteStopDoneStatus(s.status) && !['cancelled','canceled'].includes(s.status));
  const day = workDayInTripoli(now);
  const board = machines.map(machine=>{
    const machineSlots = slots.filter(s=>s.machine_id===machine.id);
    const disabled = new Set(machineSlots.filter(s=>!s.active).map(s=>physicalWorkLane(s.slot_code)));
    const lanes = stock.filter(s=>s.machine_id===machine.id && !disabled.has(physicalWorkLane(s.slot_code))).map(s=>({code:s.slot_code,quantity:s.current_qty,capacity:s.capacity,capturedAt:s.captured_at,productId:s.product_id}));
    const summary = summarizeWorkMachine({id:machine.id,name:machine.name || machine.machine_code || 'Machine',expectedCodes:machineSlots.filter(s=>s.active).map(s=>s.slot_code),openDays:machine.refill_open_days},lanes,now);
    const assignments = activeStops.filter(s=>s.machine_id===machine.id).map(stop=>{
      const route = routeById.get(stop.route_id)!;
      const person = route.operator_id ? peopleById.get(route.operator_id) : null;
      const covered = Boolean(person?.active && person.active_status==='active');
      const mine = Boolean(route.operator_id && accessibleIds.includes(route.operator_id));
      return {operatorName:person?.full_name ?? null, covered, mine, routeDate:route.route_date, previousDate:route.route_date < day,
        href:mine ? `/operator/routes/${route.id}` : canManageOperations(profile) ? `/routes/${route.id}` : null};
    });
    return {...summary,assignments,uncovered:summary.needsService && !assignments.some(a=>a.covered),assignmentConflict:assignments.length>1};
  }).sort((a,b)=>WORK_PRIORITY_ORDER[a.priority]-WORK_PRIORITY_ORDER[b.priority] || a.name.localeCompare(b.name));
  return {board,generatedAt:now.toISOString(),businessDate:day,mode:'read_only' as const,
    totals:{due:board.filter(m=>m.needsService).length,uncovered:board.filter(m=>m.uncovered).length,verify:board.filter(m=>m.unknown>0 || m.unmapped>0 || m.priority==='verify').length}};
}
