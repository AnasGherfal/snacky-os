/** A machine's XY reading is evidence, not an instruction to blindly fill a route.
 * This pure calculator NEVER assumes missing XY data means zero stock.
 */
export type XyEvidenceSlot = {
  machine_id: string;
  slot_code: string | null;
  product_id: string | null;
  current_qty: number | null;
  capacity: number | null;
  captured_at: string | null;
};
export type XyEvidencePlanSlot = {machine_id: string; slot_code: string | null; product_id: string | null; capacity: number | null; active: boolean};
export type XyEvidenceHistory = {machine_id: string; product_id: string; planned_quantity: number; filled_quantity: number | null;
  updated_at: string | null; created_at: string | null; route_date: string; route_status: string};
export type XyEvidencePlan = {machineId: string; productId: string; quantity: number};
export type XyEvidenceProduct = {id: string; name: string; sku?: string | null};
export type XyRefillLine = {
 machineId: string; productId: string; productName: string; sku: string | null;
 xyCurrent: number | null; xyCapacity: number | null; xyMissing: number | null;
 selectedQty: number; extraAboveXy: number | null; remainingXyGap: number | null;
 previousPlanned: number | null; previousFilled: number | null; previousDate: string | null;
 previousEdited: boolean; previousIsCompleted: boolean;
 stockAvailable: number | null; laneCodes: string[];
 issues: string[]; status: 'verified' | 'review' | 'blocked';
};
export type XyRefillMachine = {
 machineId: string; latestStockAt: string | null; ageHours: number | null;
 status: 'verified' | 'review' | 'blocked';
 totalMissing: number | null; plannedTotal: number; missingLanes: string[];
 lines: XyRefillLine[]; warnings: string[];
};
export type XyRefillResult = {machines: XyRefillMachine[]; generatedAt: string; warnings: string[]};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const key = (machine: string, code: string) => `${machine}:${code}`;
const minutes = (value: string) => Date.parse(value) / 60000;
/** A route edit is preference evidence, but NOT proof that the items physically fitted. */
export function calculateXyRefillEvidence(input: {
 machineIds: string[];
 slots: XyEvidenceSlot[];
 layout: XyEvidencePlanSlot[];
 hiddenLanes?: Array<{machine_id: string;slot_code: string}>;
 products: XyEvidenceProduct[];
 planned: XyEvidencePlan[];
 history?: XyEvidenceHistory[];
 availableByProduct: Map<string, number>;
 at?: string;
}): XyRefillResult {
 const generatedAt=input.at??new Date().toISOString();
 const clock=minutes(generatedAt);if (!Number.isFinite(clock)) throw new Error('Unverifiable audit time');
 const known=new Map(input.products.map(p=>[p.id,p]));
 const hidden=new Set((input.hiddenLanes??[]).map(s=>key(s.machine_id,s.slot_code)));
 const all=[] as XyRefillMachine[];
 const routeTotalByProduct=new Map<string,number>();
 for(const item of input.planned){
   if(!integer(item.quantity))throw new Error('Invalid planned quantity');
   routeTotalByProduct.set(item.productId,(routeTotalByProduct.get(item.productId)??0)+item.quantity);
 }
 const globalWarnings:string[]=[];
 for(const machineId of [...new Set(input.machineIds)]){
  const xyRows=input.slots.filter(s=>s.machine_id===machineId && s.slot_code && !hidden.has(key(machineId,s.slot_code)));
  const laneIds=new Set<string>();const duplicate=new Set<string>();
  for(const s of xyRows){if(laneIds.has(s.slot_code!))duplicate.add(s.slot_code!);laneIds.add(s.slot_code!)}
  const layout=input.layout.filter(s=>s.machine_id===machineId && s.active && s.slot_code && !hidden.has(key(machineId,s.slot_code)));
  const missingLanes=layout.filter(s=>!laneIds.has(s.slot_code!)).map(s=>s.slot_code!);
  const layoutByCode=new Map(layout.map(s=>[s.slot_code!,s]));
  const captures=xyRows.map(s=>s.captured_at?minutes(s.captured_at):NaN).filter(Number.isFinite);
  const lastMinutes=captures.length?Math.max(...captures):null;
  const ageHours=lastMinutes===null?null:Math.round(((clock-lastMinutes)/60)*10)/10;
  const latestStockAt=lastMinutes===null?null:new Date(lastMinutes*60000).toISOString();
  const machineIssues:string[]=[];
  if(!xyRows.length)machineIssues.push('No verified XY slots for this machine.');
  if(missingLanes.length)machineIssues.push(`${missingLanes.length} configured lanes have no XY reading; do not treat missing lanes as empty.`);
  if(duplicate.size)machineIssues.push(`Duplicate XY lane identities: ${[...duplicate].join(', ')}`);
  if(ageHours===null||ageHours>24||ageHours<-.1)machineIssues.push('XY snapshot unavailable, expired (>24h), or from the future.');
  else if(ageHours>6)machineIssues.push(`XY snapshot is ${ageHours} hours old. Confirm the latest sales before loading.`);
  const observations=new Map<string,{current:number;capacity:number;codes:string[];issues:string[];invalid:boolean}>();
  const invalidLines=new Set<string>();
  for(const s of xyRows){
    const prod=s.product_id??'unmapped';const lkey=key(machineId,prod);const lane=s.slot_code!;
    const current=observations.get(lkey)??{current:0,capacity:0,codes:[],issues:[],invalid:false};
    current.codes.push(lane);
    const configured=layoutByCode.get(lane);
    const capacity=s.capacity??configured?.capacity??null;
    const observed=s.current_qty;
    const sameSnapshot=s.captured_at&&lastMinutes!==null&&Math.abs(minutes(s.captured_at)-lastMinutes)<=30;
    if(!integer(capacity)||capacity<=0||!integer(observed)||observed>capacity||!sameSnapshot||duplicate.has(lane)){
      current.invalid=true;
      invalidLines.add(lane);
    }else {current.current+=observed;current.capacity+=capacity;}
    if(!s.product_id)current.issues.push(`Slot ${lane} has no mapped XY product.`);
    if(configured?.product_id&&s.product_id&&configured.product_id!==s.product_id)
      current.issues.push(`Slot ${lane}: the configured product differs from latest XY; XY identity takes precedence.`);
    observations.set(lkey,current);
  }
  if(invalidLines.size)machineIssues.push(`Missing/invalid/stale XY quantities on lanes: ${[...invalidLines].join(', ')}.`);
  const groupedPlan=new Map<string,number>();
  for(const item of input.planned.filter(r=>r.machineId===machineId)){
    if(!integer(item.quantity))throw new Error('Invalid proposed route quantity');
    groupedPlan.set(item.productId,(groupedPlan.get(item.productId)??0)+item.quantity);
  }
  const history=new Map<string,XyEvidenceHistory>();
  for(const r of [...(input.history??[])].filter(r=>r.machine_id===machineId)
    .sort((a,b)=>Date.parse(b.updated_at??b.created_at??'')-Date.parse(a.updated_at??a.created_at??''))){
    if(integer(r.planned_quantity)&&!history.has(r.product_id))history.set(r.product_id,r);
  }
  const productIds=new Set([...groupedPlan.keys(),...history.keys(),...[...observations.keys()].map(k=>k.slice(machineId.length+1))]);
  const lines:XyRefillLine[]=[];
  for(const productId of productIds){
   const obs=observations.get(key(machineId,productId));
   const selected=groupedPlan.get(productId)??0;
   const xyKnown=Boolean(obs&&!obs.invalid&&obs.issues.length===0&&productId!=='unmapped'&&ageHours!==null&&ageHours<=24&&ageHours>=-.1);
   const xyCurrent=xyKnown?obs!.current:null;
   const xyCapacity=xyKnown?obs!.capacity:null;
   const xyMissing=xyKnown?obs!.capacity-obs!.current:null;
   const previous=history.get(productId);
   const priorEdited=Boolean(previous&&previous.created_at&&previous.updated_at&&
       Date.parse(previous.updated_at)-Date.parse(previous.created_at)>30_000);
   const available=input.availableByProduct.get(productId)??null;
   const issues=[...(obs?.issues??[])];
   if(selected>0&&!xyKnown)issues.push('No trustworthy mapped XY gap for this product: verify actual lane assignment before filling.');
   if(xyMissing!==null&&selected>xyMissing)issues.push(`Planned ${selected}; XY has room for only ${xyMissing}. Extra ${selected-xyMissing} needs a verified physical lane or explicit owner approval.`);
   if(available!==null&&(routeTotalByProduct.get(productId)??0)>available)
      issues.push(`Across all selected machines, ${routeTotalByProduct.get(productId)} units are planned but unreserved MAIN has only ${available}.`);
   if(available===null&&selected>0)issues.push('Available storage balance could not be verified.');
   const blocked=selected>0&&(available===null||(routeTotalByProduct.get(productId)??0)>available||!xyKnown);
   lines.push({machineId,productId,productName:known.get(productId)?.name??'Unmapped XY product',sku:known.get(productId)?.sku??null,
    xyCurrent,xyCapacity,xyMissing,selectedQty:selected,
    extraAboveXy:xyMissing===null?null:Math.max(0,selected-xyMissing),
    remainingXyGap:xyMissing===null?null:Math.max(0,xyMissing-selected),
    previousPlanned:previous?.planned_quantity??null,previousFilled:previous?.filled_quantity??null,
    previousDate:previous?.route_date??null,previousEdited:priorEdited,
    previousIsCompleted:previous?.route_status==='completed'||previous?.route_status==='reviewed',
    stockAvailable:available,laneCodes:obs?.codes??[],issues,
    status:blocked?'blocked':issues.length?'review':'verified'});
  }
  lines.sort((a,b)=>b.selectedQty-a.selectedQty||a.productName.localeCompare(b.productName));
  const trusted=machineIssues.length===0;
  const totalMissing=trusted&&[...observations.values()].every(o=>!o.invalid)
    ? [...observations.values()].reduce((n,o)=>n+o.capacity-o.current,0):null;
  const state: XyRefillMachine['status']=missingLanes.length>0||duplicate.size>0||invalidLines.size>0||machineIssues.some(x=>x.startsWith('XY snapshot unavailable')||x.startsWith('No verified'))||lines.some(x=>x.status==='blocked')
    ? 'blocked':machineIssues.length||lines.some(x=>x.status==='review')?'review':'verified';
  all.push({machineId,latestStockAt,ageHours,status:state,totalMissing,
    plannedTotal:[...groupedPlan.values()].reduce((s,v)=>s+v,0),missingLanes,lines,warnings:machineIssues});
  globalWarnings.push(...machineIssues.map(x=>`${machineId}: ${x}`));
 }
 return {machines:all,generatedAt,warnings:globalWarnings};
}
