import 'server-only';

import { getCurrentProfile, type UserProfile } from '@/lib/auth';
import { canExecuteRoutes, canManageOperations } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { loadAccessibleOperatorIds } from '@/lib/operator-route-access';
import { ROUTE_RESERVATION_STATUSES, isRouteStopDoneStatus } from '@/lib/route-workflow';
import { makeTripPlan, summarizeMachine, PRIORITY_RANK, type Lane, type Machine, type Product, type FitRule, type ProductRule } from '@/lib/self-dispatch';
import { selectNextTrip } from '@/lib/self-dispatch-workflow';

export class TodayWorkError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

type Admin = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
type QueryResult = { data: unknown[] | null; error: { message: string } | null };
const PAGE_SIZE = 500;

/** A missing page is an error, never a silent inventory shortage or empty machine. */
async function allRows<T>(getPage: (from: number, to: number) => PromiseLike<QueryResult>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < 50_000; from += PAGE_SIZE) {
    const result = await getPage(from, from + PAGE_SIZE - 1);
    if (result.error) throw new TodayWorkError('Could not verify the work board data. Refresh or use your assigned routes.');
    const page = result.data ?? [];
    rows.push(...page as T[]);
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new TodayWorkError('The work board data is too large to verify safely.');
}

export async function requireTodayWorkActor() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || profile.must_change_password || !canExecuteRoutes(profile)) {
    throw new TodayWorkError('Your account cannot use the operator work board.', 403);
  }
  const db = getSupabaseAdminClient();
  if (!db) throw new TodayWorkError('The work board is not configured.');
  return { profile, db };
}

type MachineRow = { id: string; name: string | null; machine_code: string | null; location_id: string | null; refill_open_days: number[] | null };
type StockRow = { machine_id: string; slot_code: string; product_id: string | null; current_qty: unknown; capacity: unknown; captured_at: string | null };
type SlotRow = { id: string; machine_id: string; slot_code: string; active: boolean };
type RouteRow = { id: string; operator_id: string | null; route_date: string; status: string };
type StopRow = { id: string; route_id: string; machine_id: string; status: string; stop_order: number };
type ContextRow = { machine_id: string; location_type: string | null };
type LocationRow = { id: string; location_type: string | null };

function quantity(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && Number.isFinite(parsed) ? parsed : null;
}

export async function loadTodayWork(profile: UserProfile, db: Admin) {
  // This shared board contains operational fields only. No cash, costs, customer details,
  // secrets, historical route notes, or write authority is exposed to operators.
  const [machineRows, stockRows, slots, routes, contexts, locations, linkedIds] = await Promise.all([
    allRows<MachineRow>((a,b) => db.from('machines').select('id,name,machine_code,location_id,refill_open_days').eq('status','active').order('id').range(a,b)),
    allRows<StockRow>((a,b) => db.from('latest_vms_stock_by_slot').select('machine_id,slot_code,product_id,current_qty,capacity,captured_at').eq('source_provider','xy').order('machine_id').order('slot_code').range(a,b)),
    allRows<SlotRow>((a,b) => db.from('machine_slots').select('id,machine_id,slot_code,active').eq('active',true).order('id').range(a,b)),
    allRows<RouteRow>((a,b) => db.from('routes').select('id,operator_id,route_date,status').in('status',[...ROUTE_RESERVATION_STATUSES]).order('id').range(a,b)),
    allRows<ContextRow>((a,b) => db.from('smart_route_machine_context').select('machine_id,location_type').order('machine_id').range(a,b)),
    allRows<LocationRow>((a,b) => db.from('locations').select('id,location_type').order('id').range(a,b)),
    loadAccessibleOperatorIds(db,profile),
  ]);
  const routeIds = routes.map(r=>r.id);
  const stops: StopRow[] = [];
  // Keep URL lengths bounded even when historical unclosed routes accumulate.
  for (let offset=0; offset<routeIds.length; offset+=100) {
    stops.push(...await allRows<StopRow>((a,b) => db.from('route_stops').select('id,route_id,machine_id,status,stop_order').in('route_id',routeIds.slice(offset,offset+100)).order('id').range(a,b)));
  }
  const operatorIds = [...new Set(routes.map(r=>r.operator_id).filter((id): id is string=>Boolean(id)))];
  const names = new Map<string,string>();
  for (let offset=0; offset<operatorIds.length; offset+=100) {
    const result = await db.from('team_members').select('id,full_name').in('id',operatorIds.slice(offset,offset+100));
    if (result.error) throw new TodayWorkError('Could not verify current operator assignments.');
    for (const row of result.data ?? []) names.set(String(row.id),String(row.full_name));
  }
  const slotMap = new Map(slots.map(s=>[`${s.machine_id}:${s.slot_code}`,s]));
  const contextMap = new Map(contexts.map(c=>[c.machine_id,c.location_type]));
  const locationMap = new Map(locations.map(l=>[l.id,l.location_type]));
  const machines: Machine[] = machineRows.map(m=>({
    id:m.id,name:m.name || m.machine_code || 'Unnamed machine',locationId:m.location_id,
    locationType:contextMap.get(m.id) ?? locationMap.get(m.location_id || '') ?? null,
    openDays:Array.isArray(m.refill_open_days) && m.refill_open_days.length ? m.refill_open_days : [1,2,3,4,5,6,7],
    expectedLaneCodes:slots.filter(s=>s.machine_id===m.id).map(s=>s.slot_code),
  }));
  const lanes: Lane[] = stockRows.map(s=>({machineId:s.machine_id,slotId:slotMap.get(`${s.machine_id}:${s.slot_code}`)?.id ?? null,
    code:s.slot_code,productId:s.product_id,quantity:quantity(s.current_qty),capacity:quantity(s.capacity),capturedAt:s.captured_at}));
  const routeMap = new Map(routes.map(r=>[r.id,r]));
  const activeStops = stops.filter(s=>!isRouteStopDoneStatus(s.status) && !['canceled','cancelled'].includes(s.status));
  const now = new Date();
  const board = machines.map(m=>{
    const assignments = activeStops.filter(s=>s.machine_id===m.id).map(s=>{
      const route=routeMap.get(s.route_id)!;
      const mine=Boolean(route.operator_id && linkedIds.includes(route.operator_id));
      return {operatorName:names.get(route.operator_id || '') || 'Assigned route',mine,
        routeId:mine || canManageOperations(profile) ? route.id : null,routeDate:route.route_date};
    });
    return {...summarizeMachine(m,lanes,now),assignments};
  }).sort((a,b)=>PRIORITY_RANK[a.priority]-PRIORITY_RANK[b.priority] || a.name.localeCompare(b.name));
  const mine=routes.filter(r=>r.operator_id && linkedIds.includes(r.operator_id)).map(r=>({id:r.id,date:r.route_date,status:r.status,
    remaining:activeStops.filter(s=>s.route_id===r.id).length,
    machineNames:stops.filter(s=>s.route_id===r.id).sort((a,b)=>a.stop_order-b.stop_order).map(s=>machines.find(m=>m.id===s.machine_id)?.name || 'Machine'),
  }));
  const recommended=selectNextTrip(board.map(m=>({machineId:m.machineId,name:m.name,priority:m.priority,
    eligible:true,openToday:m.openToday,claimedBy:m.assignments.length ? 'assigned' : null})),1);
  return {machines,lanes,routes,board,mine,generatedAt:now.toISOString(),recommendedMachineIds:recommended.selectedMachineIds};
}

export async function previewTodayTrip(profile: UserProfile, db: Admin, selected: string[]) {
  if (selected.length<1 || selected.length>6 || new Set(selected).size!==selected.length) {
    throw new TodayWorkError('Choose one to six different machines.',400);
  }
  const work=await loadTodayWork(profile,db);
  for (const id of selected) {
    const machine=work.board.find(m=>m.machineId===id);
    if (!machine || !machine.openToday || machine.assignments.length) throw new TodayWorkError('A selected machine is closed, unavailable, or already assigned. Refresh the board.',409);
  }
  const [products,storage,reservations,fitRows,ruleRows] = await Promise.all([
    allRows<{id:string;name:string;category:string|null}>((a,b)=>db.from('products').select('id,name,category').eq('active',true).order('id').range(a,b)),
    allRows<{product_id:string;quantity_on_hand:unknown}>((a,b)=>db.from('route_storage_stock_by_product').select('product_id,quantity_on_hand').order('product_id').range(a,b)),
    allRows<{route_id:string;product_id:string;planned_qty:unknown;picked_qty:unknown}>((a,b)=>db.from('route_stock_lines').select('route_id,product_id,planned_qty,picked_qty').order('id').range(a,b)),
    // Optional verified_capacity can be absent during rollout. Missing approval never means inferred fit.
    allRows<{machine_slot_id:string;product_id:string;rule:string;verified_capacity?:unknown}>((a,b)=>db.from('smart_route_slot_product_rules').select('*').order('id').range(a,b)),
    allRows<{machine_id:string|null;location_id:string|null;location_type:string|null;product_id:string;rule:string}>((a,b)=>db.from('smart_route_location_product_rules').select('machine_id,location_id,location_type,product_id,rule').order('id').range(a,b)),
  ]);
  const totals=new Map<string,number>();
  const unknown=new Set<string>();
  for(const row of storage) {
    const qty=quantity(row.quantity_on_hand);
    if(qty===null) unknown.add(row.product_id);
    else totals.set(row.product_id,(totals.get(row.product_id)||0)+qty);
  }
  const activeIds=new Set(work.routes.map(r=>r.id));
  for(const row of reservations) {
    if(!activeIds.has(row.route_id)) continue;
    const planned=quantity(row.planned_qty),picked=quantity(row.picked_qty);
    if(planned===null || picked===null || planned<0 || picked<0) unknown.add(row.product_id);
    else totals.set(row.product_id,(totals.get(row.product_id)||0)-Math.max(0,planned-picked));
  }
  const available:Product[]=products.map(p=>({...p,available:unknown.has(p.id) ? 0 : Math.max(0,totals.get(p.id)||0)}));
  const fits:FitRule[]=fitRows.map(f=>({slotId:f.machine_slot_id,productId:f.product_id,rule:f.rule,capacity:quantity(f.verified_capacity)}));
  const rules:ProductRule[]=ruleRows.map(r=>({machineId:r.machine_id,locationId:r.location_id,locationType:r.location_type,productId:r.product_id,rule:r.rule}));
  const plan=makeTripPlan({machines:selected.map(id=>work.machines.find(m=>m.id===id)!),lanes:work.lanes,products:available,fits,rules,now:new Date()});
  return {plan,machines:selected.map(id=>({id,name:work.machines.find(m=>m.id===id)!.name})),generatedAt:new Date().toISOString(),
    mode:'rules_preview' as const,dispatchEnabled:false as const,
    warning:'Preview only. No route, stock reservation, deduction or later assignment has been created.'};
}
