/** Pure, testable decisions. No network, database writes, or model-generated quantities. */
export type Priority = 'immediate' | 'urgent' | 'today' | 'monitor' | 'healthy' | 'verify';
export type Lane = {
  machineId: string; slotId: string | null; code: string; productId: string | null;
  quantity: number | null; capacity: number | null; capturedAt: string | null;
};
export type Product = { id: string; name: string; category: string | null; available: number };
export type FitRule = { slotId: string; productId: string; rule: string; capacity: number | null };
export type ProductRule = { machineId: string | null; locationId: string | null; locationType: string | null; productId: string; rule: string };
export type Machine = { id: string; name: string; openDays: number[]; locationId?: string | null; locationType?: string | null; expectedLaneCodes?: string[] };
export type LanePlan = {
  machineId: string; slotId: string | null; code: string; originalProductId: string | null;
  productId: string | null; productName: string; current: number | null; capacity: number | null;
  take: number; remove: number; after: number | null; action: 'keep' | 'refill' | 'replace' | 'exception';
  reason: string; evidence: 'current_product' | 'owner_approved' | 'unknown';
};
export type TripPlan = { lanes: LanePlan[]; pickup: { productId: string; productName: string; category: string | null; quantity: number }[]; totalUnits: number; emptyAfter: number; unknownAfter: number; underfilled: number; replacements: number; ready: boolean; requiresAcknowledgement: boolean; errors: string[] };
export const MAX_STOCK_AGE_MS = 30 * 60_000;
export const PRIORITY_RANK: Record<Priority, number> = { immediate: 0, urgent: 1, today: 2, verify: 3, monitor: 4, healthy: 5 };
export function validWhole(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
export function physicalLane(code: string) { return /^\d{1,4}$/.test(code); }
export function dayInTripoli(now: Date) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
export function openToday(days: number[], now: Date) { const d = new Date(`${dayInTripoli(now)}T12:00:00Z`).getUTCDay() || 7; return days.includes(d); }
export function freshLane(lane: Lane, now: Date) {
  const stamp = Date.parse(lane.capturedAt || '');
  return Number.isFinite(stamp) && stamp <= now.getTime() + 60_000 && now.getTime() - stamp <= MAX_STOCK_AGE_MS;
}
export function summarizeMachine(machine: Machine, input: Lane[], now: Date) {
  const reported = input.filter(l => l.machineId === machine.id && physicalLane(l.code));
  const seen = new Set(reported.map(l=>l.code));
  const missing: Lane[] = [...new Set(machine.expectedLaneCodes || [])].filter(code=>physicalLane(code) && !seen.has(code)).map(code=>({machineId:machine.id,slotId:null,code,productId:null,quantity:null,capacity:null,capturedAt:null}));
  const lanes = [...reported,...missing];
  const known = lanes.filter(l => freshLane(l, now) && validWhole(l.quantity) && validWhole(l.capacity) && l.capacity > 0 && l.capacity <= 200 && l.quantity! <= l.capacity);
  const unknown = lanes.length - known.length;
  const empty = known.filter(l => l.quantity === 0).length;
  const low = known.filter(l => l.quantity! > 0 && (l.quantity! <= 2 || l.quantity! / l.capacity! <= .2)).length;
  const mean = known.length ? known.reduce((sum,l) => sum + l.quantity! / l.capacity! * 100,0) / known.length : null;
  const capacity = known.reduce((sum,l) => sum + l.capacity!,0);
  const units = known.reduce((sum,l) => sum + l.quantity!,0);
  const depleted = known.length ? (empty + low) / known.length : 0;
  let priority: Priority = 'healthy';
  if (!known.length) priority = 'verify';
  else if (empty >= 25 || mean! <= 15 || empty / known.length >= .60) priority = 'immediate';
  else if (empty >= 20 || mean! <= 25 || depleted >= .50) priority = 'urgent';
  else if (empty >= 16 || mean! <= 35 || depleted >= .35) priority = 'today';
  else if (empty > 0 || low > 0 || mean! <= 55) priority = 'monitor';
  if (unknown>0 && ['healthy','monitor'].includes(priority)) priority='verify';
  const blocked = !openToday(machine.openDays, now);
  return { machineId: machine.id, name: machine.name, priority, empty, low, unknown, lanes: lanes.length, meanFullness: mean === null ? null : Math.round(mean), stockPercent: capacity ? Math.round(units / capacity * 100) : null, openToday: !blocked, actionable: !blocked && ['immediate','urgent','today'].includes(priority), reason: known.length ? `${empty} empty · ${low} low · ${Math.round(mean!)}% average lane fullness${unknown ? ` · ${unknown} need checking` : ''}` : 'Current lane quantities could not be verified.' };
}
export function candidateProhibited(machine: Machine, productId: string, rules: ProductRule[]) {
  // Hard prohibitions are cumulative; a narrow preference never overrides a broad prohibition.
  return rules.some(r => r.productId === productId && r.rule === 'prohibited' && (r.machineId === machine.id || (!!r.locationId && r.locationId === machine.locationId) || (!!r.locationType && r.locationType === machine.locationType)));
}
export function makeTripPlan(input: { machines: Machine[]; lanes: Lane[]; products: Product[]; fits: FitRule[]; rules: ProductRule[]; now: Date; aiChoices?: Record<string,string> }): TripPlan {
  const productById = new Map(input.products.map(p => [p.id,p]));
  const remaining = new Map(input.products.map(p => [p.id,validWhole(p.available) ? p.available : 0]));
  const plans: LanePlan[] = [];
  const errors: string[] = [];
  type Task = { plan: LanePlan; candidates: { product: Product; capacity: number; evidence: LanePlan['evidence']; original: boolean }[] };
  const tasks: Task[] = [];
  for (const machine of input.machines) {
    const rows = input.lanes.filter(l => l.machineId === machine.id && physicalLane(l.code));
    if (!rows.length) errors.push(`${machine.name}: no current physical lanes are available.`);
    const seen = new Set<string>();
    for (const lane of rows) {
      if (seen.has(lane.code)) { errors.push(`${machine.name}: duplicate lane ${lane.code}.`); continue; }
      seen.add(lane.code);
      const original = lane.productId ? productById.get(lane.productId) : null;
      const plan: LanePlan = { machineId: machine.id, slotId: lane.slotId, code: lane.code, originalProductId: lane.productId, productId: lane.productId, productName: original?.name || 'Unmapped product', current: lane.quantity, capacity: lane.capacity, take: 0, remove: 0, after: lane.quantity, action: 'keep', reason: 'Already stocked.', evidence: 'current_product' };
      plans.push(plan);
      if (!freshLane(lane,input.now) || !validWhole(lane.quantity) || !validWhole(lane.capacity) || lane.capacity <= 0 || lane.capacity > 200 || lane.quantity > lane.capacity || !original || !lane.slotId) {
        Object.assign(plan,{ action:'exception', after:null, evidence:'unknown', reason:'Verify the lane/product/quantity before changing it.' });
        continue;
      }
      const slotRules = input.fits.filter(r => r.slotId === lane.slotId);
      const blockedIds = new Set(slotRules.filter(r => r.rule === 'prohibited').map(r=>r.productId));
      const allowed = (p: Product) => !blockedIds.has(p.id) && !candidateProhibited(machine,p.id,input.rules);
      const originalAllowed = allowed(original);
      const candidates: Task['candidates'] = [];
      if (originalAllowed && original.available > 0) candidates.push({ product:original,capacity:lane.capacity,evidence:'current_product',original:true });
      // Substitutes require an owner's explicit lane approval AND a verified replacement capacity.
      for (const r of slotRules) {
        const p = productById.get(r.productId);
        if (r.rule !== 'allowed' || !p || p.id === original.id || !allowed(p) || p.available <= 0 || !validWhole(r.capacity) || r.capacity <= 0 || r.capacity > 200) continue;
        candidates.push({product:p,capacity:r.capacity,evidence:'owner_approved',original:false});
      }
      const deficit = lane.capacity-lane.quantity;
      const changeUseful = !originalAllowed || (original.available < deficit && lane.quantity <= Math.ceil(lane.capacity*.5));
      if (deficit === 0 && originalAllowed) continue;
      const usable = candidates.filter(c => c.original || lane.quantity===0 || changeUseful);
      if (!usable.length) { plan.reason = lane.quantity>0 && originalAllowed ? 'Keep remaining stock; no approved top-up is available.' : 'No approved compatible product is available in storage.'; if (!originalAllowed) { plan.action='exception'; plan.evidence='unknown'; } continue; }
      const hinted = input.aiChoices?.[`${machine.id}:${lane.code}`];
      usable.sort((a,b) => {
        const aFull = a.product.available >= (a.original ? deficit : a.capacity);
        const bFull = b.product.available >= (b.original ? deficit : b.capacity);
        if (a.original && aFull) return -1;
        if (b.original && bFull) return 1;
        if (aFull!==bFull) return aFull ? -1:1;
        if ((a.product.id===hinted)!==(b.product.id===hinted)) return a.product.id===hinted ? -1:1;
        if (a.original!==b.original) return a.original ? -1:1;
        return b.product.available-a.product.available || a.product.name.localeCompare(b.product.name);
      });
      tasks.push({plan,candidates:usable});
    }
    for (const code of machine.expectedLaneCodes || []) if (!seen.has(code) && physicalLane(code)) {
      plans.push({machineId:machine.id,slotId:null,code,originalProductId:null,productId:null,productName:'Unknown lane',current:null,capacity:null,take:0,remove:0,after:null,action:'exception',reason:'Expected physical lane missing from latest XY snapshot.',evidence:'unknown'});
    }
  }
  // Fill empty, least-flexible lanes first. Allocate one unit across empty lanes before topping up.
  tasks.sort((a,b) => Number((a.plan.current||0)>0)-Number((b.plan.current||0)>0) || a.candidates.length-b.candidates.length || (a.plan.current||0)-(b.plan.current||0) || a.plan.code.localeCompare(b.plan.code,undefined,{numeric:true}));
  const choose = (task:Task) => {
    // Never clear a stocked lane for an undersupplied replacement.
    const selected = task.candidates.find(c => (remaining.get(c.product.id)||0) >= (!c.original && task.plan.current!>0 ? c.capacity : 1));
    if (!selected) return;
    const p=task.plan;
    p.productId=selected.product.id; p.productName=selected.product.name;
    p.capacity=selected.capacity; p.evidence=selected.evidence;
    p.remove=selected.original ? 0 : p.current!;
    p.after=selected.original ? p.current : 0;
    p.action=selected.original ? 'refill':'replace';
    p.reason=selected.original ? 'Top up current product.' : 'Approved substitute: count and remove old units, record their custody, update XY product, then refill. Never mix products.';
  };
  for (const task of tasks) {
    choose(task);
    const p=task.plan;
    if (!['refill','replace'].includes(p.action) || !p.productId) continue;
    const available=remaining.get(p.productId)||0;
    const initialAllocation=p.action==='replace' && p.current!>0 ? p.capacity! : 1;
    const minimum=Math.min(available,p.capacity!-p.after!,initialAllocation);
    if (minimum>0) { p.take+=minimum; p.after!+=minimum; remaining.set(p.productId,available-minimum); }
  }
  // Round-robin top-ups prevent the first machine consuming everything.
  let progress=true;
  while(progress) {
    progress=false;
    for(const {plan:p} of tasks) {
      if (!p.productId || !['refill','replace'].includes(p.action) || p.after!>=p.capacity!) continue;
      const available=remaining.get(p.productId)||0;
      if(available>0) { p.take++; p.after!++; remaining.set(p.productId,available-1); progress=true; }
    }
  }
  const pickupMap=new Map<string,TripPlan['pickup'][number]>();
  for(const p of plans) {
    if(p.take<=0) { if(p.action==='replace') Object.assign(p,{action:'keep',productId:p.originalProductId,productName:productById.get(p.originalProductId||'')?.name||'Unmapped product',remove:0,after:p.current,reason:'No stock left after allocating other lanes.'}); continue; }
    const row=pickupMap.get(p.productId!)||{productId:p.productId!,productName:p.productName,category:productById.get(p.productId!)?.category||null,quantity:0};
    row.quantity+=p.take; pickupMap.set(row.productId,row);
  }
  const pickup=[...pickupMap.values()].sort((a,b)=>categoryOrder(a.category,a.productName)-categoryOrder(b.category,b.productName)||a.productName.localeCompare(b.productName));
  const emptyAfter=plans.filter(p=>p.after===0).length;
  const unknownAfter=plans.filter(p=>p.after===null||p.action==='exception').length;
  const underfilled=plans.filter(p=>p.after!==null&&p.capacity!==null&&p.after>0&&p.after<p.capacity).length;
  return {lanes:plans,pickup,totalUnits:pickup.reduce((sum,p)=>sum+p.quantity,0),emptyAfter,unknownAfter,underfilled,replacements:plans.filter(p=>p.action==='replace'&&p.take>0).length,ready:errors.length===0&&pickup.length>0,requiresAcknowledgement:emptyAfter>0||unknownAfter>0,errors};
}
export function categoryOrder(category:string|null,name:string) { const value=`${category||''} ${name}`.toLowerCase(); if(/water|مياه/.test(value))return 4; if(/chip|spuds|dorito|تيش|شيب/.test(value))return 0; if(/chocol|wafer|gardena|kinder|شوك/.test(value))return 1; if(/candy|gumm|bebeto|حلو/.test(value))return 2; return 3; }
