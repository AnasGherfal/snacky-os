import 'server-only';
import { createHash } from 'node:crypto';
import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes, isOwnerAdminRole, normalizeRoles } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { ROUTE_RESERVATION_STATUSES, isRouteStopDoneStatus } from '@/lib/route-workflow';
import { buildProductPlan, planWhole, type PlanInput, type PlanProduct } from '@/lib/smart-work-product-plan';
export class ProductPlanError extends Error { constructor(message:string,public status=503){super(message);} }
const uuid = (s:unknown):s is string => typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function parsePlanRequest(raw:unknown):string[] {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new ProductPlanError('Invalid plan request.',400);
  const r=raw as Record<string,unknown>;
  if (Object.keys(r).length!==1 || !Array.isArray(r.dutyIds) || r.dutyIds.length<1 || r.dutyIds.length>6 || r.dutyIds.some(x=>!uuid(x)) || new Set(r.dutyIds).size!==r.dutyIds.length) throw new ProductPlanError('Choose one to six different required stops.',400);
  return r.dutyIds as string[];
}
type Result = {data:unknown[]|null;error:{message:string}|null};
async function all<T>(page:(a:number,b:number)=>PromiseLike<Result>):Promise<T[]> {
  const rows:T[]=[];
  for(let a=0;a<20_000;a+=500){
    const r=await page(a,a+499);
    if(r.error || !Array.isArray(r.data)) throw new ProductPlanError('Could not verify the complete planning data. No stock was reserved.');
    rows.push(...r.data as T[]); if(r.data.length<500)return rows;
  }
  throw new ProductPlanError('Planning data exceeded its safe limit. No partial quantities are shown.');
}
async function actor() {
  const profile=await getCurrentProfile();
  if(!profile || !profile.team_member_id || profile.active_status!=='active' || profile.must_change_password || !canExecuteRoutes(profile)) throw new ProductPlanError('Active operator access required.',403);
  const db=getSupabaseAdminClient(); if(!db)throw new ProductPlanError('Planning connection unavailable.');
  const people=await all<{id:string;role:string;roles:string[]|null;active:boolean;active_status:string}>(
    (a,b)=>db.from('team_members').select('id,role,roles,active,active_status').eq('auth_user_id',profile.id).order('id').range(a,b));
  const current=people.find(p=>p.id===profile.team_member_id && p.active && p.active_status==='active' && canExecuteRoutes(normalizeRoles(p.roles,p.role)));
  if(!current)throw new ProductPlanError('Operator access changed. Sign in again.',403);
  return {db,profile,manager:isOwnerAdminRole(normalizeRoles(current.roles,current.role)),ids:people.filter(p=>p.active && p.active_status==='active' && canExecuteRoutes(normalizeRoles(p.roles,p.role))).map(p=>p.id)};
}
type Actor=Awaited<ReturnType<typeof actor>>;
type Duty={id:string;machine_id:string;state:string;priority:string;owner_id:string|null;due_at:string|null;revision:number;blocker:string|null};
type Machine={id:string;name:string|null;machine_code:string|null;status:string;location_id:string|null};
type Route={id:string;operator_id:string|null;status:string};
type Stop={id:string;route_id:string;machine_id:string;status:string};
const rank:Record<string,number>={immediate:0,urgent:1,today:2};
async function selection(a:Actor) {
  const [duties,machines,routes]=await Promise.all([
    all<Duty>((i,j)=>a.db.from('smart_work_duties').select('id,machine_id,state,priority,owner_id,due_at,revision,blocker').neq('state','completed').order('id').range(i,j)),
    all<Machine>((i,j)=>a.db.from('machines').select('id,name,machine_code,status,location_id').order('id').range(i,j)),
    all<Route>((i,j)=>a.db.from('routes').select('id,operator_id,status').in('status',[...ROUTE_RESERVATION_STATUSES]).order('id').range(i,j)),
  ]);
  const stops:Stop[]=[];
  for(let i=0;i<routes.length;i+=100)stops.push(...await all<Stop>((x,y)=>a.db.from('route_stops').select('id,route_id,machine_id,status').in('route_id',routes.slice(i,i+100).map(r=>r.id)).order('id').range(x,y)));
  const open=stops.filter(s=>!isRouteStopDoneStatus(s.status) && !['canceled','cancelled'].includes(s.status));
  const scope=duties.filter(d=>a.manager || (d.owner_id && a.ids.includes(d.owner_id)));
  const choices=scope.map(d=>{
    const m=machines.find(m=>m.id===d.machine_id),claimed=open.some(s=>s.machine_id===d.machine_id);
    return {id:d.id,machineId:d.machine_id,name:m?.name||m?.machine_code||'Machine',priority:d.priority,dueAt:d.due_at,
      mine:!!d.owner_id&&a.ids.includes(d.owner_id),state:d.state,
      unavailable:claimed?'existing_route':!m||m.status!=='active'?'machine_inactive':d.state!=='required'?'duty_pending':d.blocker||null};
  }).sort((x,y)=>(rank[x.priority]??9)-(rank[y.priority]??9)||(x.dueAt??'z').localeCompare(y.dueAt??'z')||x.id.localeCompare(y.id));
  return {duties:scope,machines,routes,stops,choices};
}
export async function productPlanChoices(){const a=await actor();const s=await selection(a);return {choices:s.choices,scope:a.manager?'all':'mine',dispatchEnabled:false,checkedAt:new Date().toISOString()};}
async function capture(a:Actor,ids:string[]) {
  const s=await selection(a);
  if(ids.some(id=>!s.choices.some(c=>c.id===id)))throw new ProductPlanError('A selected duty is no longer available to your account.',403);
  if(ids.some(id=>s.choices.find(c=>c.id===id)!.unavailable))throw new ProductPlanError('A selected stop is blocked, inactive or already on an open route. Use its existing route or refresh.',409);
  const duties=ids.map(id=>s.duties.find(d=>d.id===id)!);
  if(new Set(duties.map(d=>d.machine_id)).size!==duties.length)throw new ProductPlanError('Duplicate machine duties need review.',409);
  const machineIds=duties.map(d=>d.machine_id);
  const [products,storage,slots,stock,fits,rules,contexts,locations]=await Promise.all([
    all<{id:string;name:string;category:string|null}>((i,j)=>a.db.from('products').select('id,name,category').eq('active',true).order('id').range(i,j)),
    all<{product_id:string;quantity_on_hand:unknown}>((i,j)=>a.db.from('route_storage_stock_by_product').select('product_id,quantity_on_hand').order('product_id').range(i,j)),
    all<{id:string;machine_id:string;slot_code:string;active:boolean}>((i,j)=>a.db.from('machine_slots').select('id,machine_id,slot_code,active').in('machine_id',machineIds).order('id').range(i,j)),
    all<{machine_id:string;slot_code:string;product_id:string|null;current_qty:unknown;capacity:unknown;captured_at:string|null}>((i,j)=>a.db.from('latest_vms_stock_by_slot').select('machine_id,slot_code,product_id,current_qty,capacity,captured_at').eq('source_provider','xy').in('machine_id',machineIds).order('machine_id').order('slot_code').range(i,j)),
    all<{machine_slot_id:string;product_id:string;rule:string;verified_capacity:unknown}>((i,j)=>a.db.from('smart_route_slot_product_rules').select('machine_slot_id,product_id,rule,verified_capacity').order('id').range(i,j)),
    all<{machine_id:string|null;location_id:string|null;location_type:string|null;product_id:string;rule:string}>((i,j)=>a.db.from('smart_route_location_product_rules').select('machine_id,location_id,location_type,product_id,rule').order('id').range(i,j)),
    all<{machine_id:string;location_type:string|null}>((i,j)=>a.db.from('smart_route_machine_context').select('machine_id,location_type').in('machine_id',machineIds).order('machine_id').range(i,j)),
    all<{id:string;location_type:string|null}>((i,j)=>a.db.from('locations').select('id,location_type').order('id').range(i,j)),
  ]);
  const reservations:{route_id:string;product_id:string;planned_qty:unknown;picked_qty:unknown}[]=[];
  for(let i=0;i<s.routes.length;i+=100)reservations.push(...await all<typeof reservations[number]>((x,y)=>a.db.from('route_stock_lines').select('route_id,product_id,planned_qty,picked_qty').in('route_id',s.routes.slice(i,i+100).map(r=>r.id)).order('id').range(x,y)));
  const availability=new Map<string,number>(),unknown=new Set<string>();
  for(const r of storage){const qty=planWhole(r.quantity_on_hand);if(qty===null || availability.has(r.product_id))unknown.add(r.product_id);else availability.set(r.product_id,qty);}
  for(const r of reservations){const planned=planWhole(r.planned_qty),picked=planWhole(r.picked_qty);if(planned===null||picked===null)unknown.add(r.product_id);else availability.set(r.product_id,(availability.get(r.product_id)??0)-Math.max(0,planned-picked));}
  const available:PlanProduct[]=products.map(p=>({...p,available:unknown.has(p.id)?null:Math.max(0,availability.get(p.id)??0)}));
  const input:Omit<PlanInput,'now'>={
    machines:duties.map(d=>{const m=s.machines.find(m=>m.id===d.machine_id)!;return {id:m.id,name:m.name||m.machine_code||'Machine',priority:rank[d.priority]??9,locationId:m.location_id,locationType:contexts.find(c=>c.machine_id===m.id)?.location_type??locations.find(l=>l.id===m.location_id)?.location_type??null};}),
    slots:slots.map(r=>({id:r.id,machineId:r.machine_id,code:r.slot_code,active:r.active})),
    stock:stock.map(r=>({machineId:r.machine_id,code:r.slot_code,productId:r.product_id,quantity:r.current_qty,capacity:r.capacity,capturedAt:r.captured_at})),
    products:available,fits:fits.map(r=>({slotId:r.machine_slot_id,productId:r.product_id,rule:r.rule,capacity:r.verified_capacity})),
    rules:rules.map(r=>({machineId:r.machine_id,locationId:r.location_id,locationType:r.location_type,productId:r.product_id,rule:r.rule})),
  };
  // Read-only comparison detects changed inputs; it is NOT a transactional reservation.
  const fingerprint=createHash('sha256').update(JSON.stringify({input,duties,routes:s.routes,stops:s.stops,reservations})).digest('hex');
  return {input,fingerprint,choices:s.choices};
}
export async function previewRequiredProducts(raw:unknown) {
  const a=await actor(), ids=parsePlanRequest(raw);
  const first=await capture(a,ids);
  const rechecked=await actor();
  if(rechecked.profile.id!==a.profile.id || rechecked.manager!==a.manager || JSON.stringify(rechecked.ids)!==JSON.stringify(a.ids))throw new ProductPlanError('Account access changed. Refresh.',409);
  const second=await capture(rechecked,ids);
  if(first.fingerprint!==second.fingerprint)throw new ProductPlanError('Stock, lane rules or assignments changed during planning. Generate a fresh preview.',409);
  const plan=buildProductPlan({...second.input,now:new Date()});
  const otherRequired=second.choices.filter(c=>!ids.includes(c.id));
  const earliestSelected=Math.min(...second.choices.filter(c=>ids.includes(c.id)).map(c=>rank[c.priority]??9));
  return {plan,machines:second.input.machines.map(m=>({id:m.id,name:m.name})),otherRequired,
    higherPriorityRemaining:otherRequired.some(c=>(rank[c.priority]??9)<earliestSelected),
    inputFingerprint:second.fingerprint,mode:'product_preview' as const,dispatchEnabled:false as const};
}
