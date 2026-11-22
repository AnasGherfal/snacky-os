import { NextResponse } from 'next/server';
import { getCurrentProfile } from '@/lib/auth';
import { canAccessPath } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { ROUTE_RESERVATION_STATUSES } from '@/lib/route-workflow';
import { calculateXyRefillEvidence, type XyEvidenceHistory, type XyEvidencePlan, type XyEvidencePlanSlot, type XyEvidenceSlot, type XyEvidenceProduct } from '@/lib/xy-refill-evidence';

export const dynamic = 'force-dynamic';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Page<T> = {data:T[]|null;count:number|null;error:{message:string}|null};
type ClientPage<T> = (from:number,to:number,signal:AbortSignal)=>PromiseLike<Page<T>>;
type HistoricalRow = {id:string;machine_id:string;product_id:string;planned_quantity:number;filled_quantity:number|null;created_at:string|null;updated_at:string|null;route:{route_date:string;status:string}[]};

/** Use a count verified across pages. A PostgREST row cap is not an empty result. */
async function loadAll<T>(fetch:ClientPage<T>, identity:(row:T)=>string, signal:AbortSignal, max=20000):Promise<T[]>{
 const result:T[]=[];let expected:number|null=null;const seen=new Set<string>();
 for(let page=0;page<120;page++){
   if(signal.aborted)throw new Error('XY review timed out; no partial data used.');
   const next=await fetch(result.length,result.length+499,signal);
   if(next.error)throw new Error(next.error.message);
   if(!Array.isArray(next.data)||!Number.isSafeInteger(next.count)||next.count===null||next.count<0)throw new Error('XY review could not verify a complete row count.');
   if(next.count>max)throw new Error('XY review list is too large; narrow the machine selection.');
   if(expected!==null&&expected!==next.count)throw new Error('XY data changed while loading. Refresh and retry.');
   expected=next.count;
   for(const row of next.data){const id=identity(row);if(!id||seen.has(id))throw new Error('XY data contained duplicate or missing records.');seen.add(id);result.push(row)}
   if(result.length===expected)return result;
   if(next.data.length===0||result.length>expected)throw new Error('XY list was incomplete; partial quantities withheld.');
 }
 throw new Error('XY list exceeded the bounded page count.');
}

export async function POST(request:Request){
 const profile=await getCurrentProfile();
 if(!profile||!canAccessPath({id:profile.id,role:profile.role,roles:profile.roles,canAddProducts:profile.can_add_products,
     teamMemberId:profile.team_member_id,activeStatus:profile.active_status},'/routes/new'))
   return NextResponse.json({error:'Only authorized route planners can review XY stock.'},{status:403});
 let payload:unknown;
 try{payload=await request.json()}catch{return NextResponse.json({error:'Invalid XY review request.'},{status:400})}
 if(!payload||typeof payload!=='object')return NextResponse.json({error:'Invalid XY review request.'},{status:400});
 const raw=payload as {machineIds?:unknown;plannedItems?:unknown};
 if(!Array.isArray(raw.machineIds)||raw.machineIds.length<1||raw.machineIds.length>50||
    raw.machineIds.some(x=>typeof x!=='string'||!uuid.test(x)))
   return NextResponse.json({error:'Choose 1–50 valid machines.'},{status:400});
 if(!Array.isArray(raw.plannedItems)||raw.plannedItems.length>1000)
   return NextResponse.json({error:'The selected refill plan is invalid or too large.'},{status:400});
 const machineIds=[...new Set(raw.machineIds as string[])];
 const planned: XyEvidencePlan[]=[];
 for(const value of raw.plannedItems){
   if(!value||typeof value!=='object')return NextResponse.json({error:'Invalid planned product.'},{status:400});
   const item=value as Record<string,unknown>;
   if(typeof item.machineId!=='string'||!machineIds.includes(item.machineId)||typeof item.productId!=='string'||!uuid.test(item.productId)||
      typeof item.quantity!=='number'||!Number.isSafeInteger(item.quantity)||item.quantity<0||item.quantity>2000)
     return NextResponse.json({error:'Invalid product, machine, or planned quantity.'},{status:400});
   planned.push({machineId:item.machineId,productId:item.productId,quantity:item.quantity});
 }
 const db=getSupabaseAdminClient();
 if(!db)return NextResponse.json({error:'Warehouse evidence is unavailable.'},{status:503});
 const signal=AbortSignal.timeout(15000);
 try{
  const [machines,xy,layout,hidden,products,storage,reservations,historical]=await Promise.all([
   loadAll((from,to,signal)=>db.from('machines').select('id,name,status',{count:'exact'}).in('id',machineIds).order('id').range(from,to).abortSignal(signal),r=>r.id!,signal),
   loadAll<XyEvidenceSlot&{id:string}>((from,to,signal)=>db.from('latest_vms_stock_by_slot')
     .select('id,machine_id,slot_code,product_id,current_qty,capacity,captured_at',{count:'exact'}).in('machine_id',machineIds).order('id').range(from,to).abortSignal(signal),r=>r.id,signal),
   loadAll<XyEvidencePlanSlot&{id:string}>((from,to,signal)=>db.from('machine_slots')
     .select('id,machine_id,slot_code,product_id,capacity,active',{count:'exact'}).in('machine_id',machineIds).eq('active',true).order('id').range(from,to).abortSignal(signal),r=>r.id,signal),
   loadAll<{machine_id:string;slot_code:string}>((from,to,signal)=>db.from('xy_hidden_machine_selections')
     .select('machine_id,slot_code',{count:'exact'}).in('machine_id',machineIds).order('machine_id').order('slot_code').range(from,to).abortSignal(signal),r=>r.machine_id+':'+r.slot_code,signal),
   loadAll<XyEvidenceProduct>((from,to,signal)=>db.from('products').select('id,name,sku',{count:'exact'}).eq('active',true).order('id').range(from,to).abortSignal(signal),r=>r.id,signal),
   loadAll<{product_id:string;quantity_on_hand:number}>((from,to,signal)=>db.from('route_storage_stock_by_product').select('product_id,quantity_on_hand',{count:'exact'}).order('product_id').range(from,to).abortSignal(signal),r=>r.product_id,signal),
   loadAll<{id:string;product_id:string;planned_qty:number;picked_qty:number}>((from,to,signal)=>db.from('route_stock_lines')
      .select('id,product_id,planned_qty,picked_qty,route:routes!inner(status)',{count:'exact'})
      .in('route.status',[...ROUTE_RESERVATION_STATUSES]).order('id').range(from,to).abortSignal(signal),r=>r.id,signal),
   // Historic owner choices are OPTIONAL context, never proof the physical lanes held that quantity.
   loadAll<HistoricalRow>((from,to,signal)=>db.from('route_stop_items')
     .select('id,machine_id,product_id,planned_quantity,filled_quantity,created_at,updated_at,route:routes!inner(route_date,status)',{count:'exact'})
     .in('machine_id',machineIds).gte('route.route_date',new Date(Date.now()-45*86400000).toISOString().slice(0,10))
     .order('updated_at',{ascending:false}).order('id').range(from,to).abortSignal(signal),r=>r.id,signal,20000)
   .catch(error=>{console.warn('[xy-review] Optional history unavailable',error);return [] as HistoricalRow[];}),
  ]);
  if(machines.length!==machineIds.length||machines.some(m=>m.status!=='active'))
    return NextResponse.json({error:'One or more selected machines are inactive or unavailable.'},{status:400});
  const stock=new Map<string,number>();for(const x of storage)stock.set(x.product_id,Number(x.quantity_on_hand));
  for(const r of reservations)stock.set(r.product_id,(stock.get(r.product_id)??0)-Math.max(0,Number(r.planned_qty??0)-Number(r.picked_qty??0)));
  const available=new Map([...stock].map(([id,qty])=>[id,Math.max(0,qty)]));
  // PostgREST may return an object for the joined routes row. Preserve its actual status/date.
  const history:XyEvidenceHistory[]=historical.map(r=>({
   machine_id:r.machine_id,product_id:r.product_id,planned_quantity:Number(r.planned_quantity??0),
   filled_quantity:r.filled_quantity===null?null:Number(r.filled_quantity),
   created_at:r.created_at,updated_at:r.updated_at,
   route_date:r.route?.[0]?.route_date??'',
   route_status:r.route?.[0]?.status??'',
  }));
  const audit=calculateXyRefillEvidence({machineIds,slots:xy,layout,hiddenLanes:hidden,products,
    planned,history,availableByProduct:available});
  return NextResponse.json({audit,machineNames:Object.fromEntries(machines.map(m=>[m.id,m.name]))},
    {headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  console.error('[xy-review] Verified XY evidence unavailable',error);
  return NextResponse.json({error:'Could not verify the complete XY/warehouse record. No partial recommendation is shown.'},
    {status:503,headers:{'Cache-Control':'no-store'}});
 }
}
