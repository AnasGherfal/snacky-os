/** Part 3A: quantity decisions only. Never claims duties, reserves goods or authorizes pickup. */
export type PlanProduct = { id: string; name: string; category: string | null; available: number | null };
export type PlanMachine = { id: string; name: string; priority: number; locationId: string | null; locationType: string | null };
export type PlanSlot = { id: string; machineId: string; code: string; active: boolean };
export type PlanStock = { machineId: string; code: string; productId: string | null; quantity: unknown; capacity: unknown; capturedAt: string | null };
export type PlanFit = { slotId: string; productId: string; rule: string; capacity: unknown };
export type PlanRule = { machineId: string | null; locationId: string | null; locationType: string | null; productId: string; rule: string };
export type PlanInput = { machines: PlanMachine[]; slots: PlanSlot[]; stock: PlanStock[]; products: PlanProduct[]; fits: PlanFit[]; rules: PlanRule[]; now: Date };
export type PlanReason = 'stocked' | 'top_up' | 'approved_replacement' | 'verify_lane' | 'missing_mapping' | 'restricted' | 'stock_unknown' | 'no_compatible_stock' | 'insufficient_stock' | 'keep_remaining';
export type ProductLanePlan = {
  machineId: string; slotId: string | null; code: string; originalProductId: string | null; originalName: string;
  productId: string | null; productName: string; current: number | null; originalCapacity: number | null;
  target: number | null; take: number; removeExpected: number; after: number | null;
  action: 'keep' | 'refill' | 'replace' | 'exception'; reason: PlanReason;
};
export type ProductPlan = {
  lanes: ProductLanePlan[];
  pickup: {productId: string; productName: string; category: string | null; quantity: number; available: number}[];
  totalUnits: number; emptyAfter: number; unknownAfter: number; underfilled: number; replacements: number;
  status: 'complete' | 'partial' | 'blocked' | 'nothing_to_load'; generatedAt: string; expiresAt: string;
  dispatchEnabled: false; errors: string[];
};
export const PLAN_STOCK_MAX_AGE_MS = 30 * 60_000;
export function planLaneCode(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^\d{1,4}$/.test(s) ? String(Number(s)).padStart(3,'0') : null;
}
export function planWhole(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000 ? n : null;
}
export function planCategoryOrder(category: string | null, name: string): number {
  const s = `${category ?? ''} ${name}`.toLowerCase();
  if (/water|مياه|ماء/.test(s)) return 4;
  if (/chip|crisps|spuds|dorito|شيب|تشيب/.test(s)) return 0;
  if (/chocol|wafer|gardena|kinder|شوك|شكلا/.test(s)) return 1;
  if (/candy|gumm|bebeto|حلو/.test(s)) return 2;
  return 3;
}
export function buildProductPlan(input: PlanInput): ProductPlan {
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new Error('Invalid planning time.');
  if (!input.machines.length || input.machines.length > 6 || new Set(input.machines.map(m=>m.id)).size !== input.machines.length) throw new Error('Choose one to six distinct machines.');
  if (new Set(input.products.map(p=>p.id)).size !== input.products.length) throw new Error('Duplicate product catalog entries.');
  const products = new Map(input.products.map(p=>[p.id,p]));
  const remaining = new Map(input.products.map(p=>[p.id,typeof p.available==='number' ? planWhole(p.available) ?? 0 : 0]));
  const lanes: ProductLanePlan[] = [], errors: string[] = [];
  let expires = now + 5 * 60_000;
  type Candidate = {product: PlanProduct; target: number; original: boolean; preferred: boolean};
  type Task = {plan: ProductLanePlan; candidates: Candidate[]; priority: number};
  const tasks: Task[] = [];
  for (const machine of [...input.machines].sort((a,b)=>a.priority-b.priority || a.id.localeCompare(b.id))) {
    const slots = input.slots.filter(s=>s.machineId===machine.id && planLaneCode(s.code));
    const stock = input.stock.filter(s=>s.machineId===machine.id && planLaneCode(s.code));
    const codes = [...new Set([...slots.map(s=>planLaneCode(s.code)!),...stock.map(s=>planLaneCode(s.code)!)])].sort((a,b)=>Number(a)-Number(b));
    let usable = 0;
    for (const code of codes) {
      const matchingSlots = slots.filter(s=>planLaneCode(s.code)===code);
      // A single deliberately inactive physical lane is not an empty selection.
      if (matchingSlots.length===1 && !matchingSlots[0].active) continue;
      usable++;
      const rows = stock.filter(s=>planLaneCode(s.code)===code);
      const row = rows.length===1 ? rows[0] : null;
      const slot = matchingSlots.length===1 && matchingSlots[0].active ? matchingSlots[0] : null;
      const qty = row ? planWhole(row.quantity) : null, cap = row ? planWhole(row.capacity) : null;
      const original = row?.productId ? products.get(row.productId) : null;
      const plan: ProductLanePlan = {machineId:machine.id,slotId:slot?.id??null,code,originalProductId:row?.productId??null,
        originalName:original?.name??'',productId:row?.productId??null,productName:original?.name??'',current:qty,
        originalCapacity:cap,target:cap,take:0,removeExpected:0,after:qty,action:'keep',reason:'stocked'};
      lanes.push(plan);
      const at = Date.parse(row?.capturedAt ?? '');
      if (!slot || !row || !Number.isFinite(at) || at > now+60_000 || now-at > PLAN_STOCK_MAX_AGE_MS || qty===null || cap===null || cap<1 || cap>1000 || qty>cap) {
        Object.assign(plan,{action:'exception',reason:'verify_lane',after:null}); continue;
      }
      expires = Math.min(expires,at+PLAN_STOCK_MAX_AGE_MS);
      if (!original) { Object.assign(plan,{action:'exception',reason:'missing_mapping',after:null}); continue; }
      const slotRules = input.fits.filter(r=>r.slotId===slot.id);
      const venueRules = input.rules.filter(r=>r.machineId===machine.id || (r.locationId && r.locationId===machine.locationId) || (r.locationType && r.locationType===machine.locationType));
      const prohibited = (id:string) => slotRules.some(r=>r.productId===id && r.rule==='prohibited') || venueRules.some(r=>r.productId===id && r.rule==='prohibited');
      const candidates: Candidate[] = [];
      const deficit = cap-qty, originalOK = !prohibited(original.id);
      if (originalOK && qty===cap) continue;
      if (originalOK && (remaining.get(original.id)??0)>0) candidates.push({product:original,target:cap,original:true,preferred:false});
      const allowReplace = qty===0 || !originalOK || ((remaining.get(original.id)??0)<deficit && qty<=Math.ceil(cap*.5));
      if (allowReplace) for (const rule of slotRules) {
        const p = products.get(rule.productId), target = planWhole(rule.capacity);
        if (rule.rule!=='allowed' || !p || p.id===original.id || prohibited(p.id) || (remaining.get(p.id)??0)<1 || target===null || target<1 || target>1000) continue;
        if (slotRules.filter(r=>r.productId===p.id && r.rule==='allowed').length!==1) continue;
        // Do not clear several old units just to carry fewer replacement units.
        if (qty>0 && target<qty) continue;
        candidates.push({product:p,target,original:false,preferred:venueRules.some(r=>r.productId===p.id && r.rule==='preferred')});
      }
      candidates.sort((a,b)=>{
        const fullA=(remaining.get(a.product.id)??0)>=(a.original?deficit:a.target), fullB=(remaining.get(b.product.id)??0)>=(b.original?deficit:b.target);
        if (a.original&&fullA) return -1; if (b.original&&fullB) return 1;
        return Number(fullB)-Number(fullA) || Number(b.preferred)-Number(a.preferred) || Number(b.original)-Number(a.original) || a.product.id.localeCompare(b.product.id);
      });
      if (!originalOK) Object.assign(plan,{action:'exception',reason:'restricted'});
      else plan.reason=original.available===null?'stock_unknown':qty>0?'keep_remaining':'no_compatible_stock';
      tasks.push({plan,candidates,priority:machine.priority});
    }
    if (!usable) errors.push(`${machine.name}: no verified physical lane configuration.`);
  }
  if (lanes.length>600) throw new Error('Selected machines exceed the safe lane limit.');
  const emptyTasks=tasks.filter(t=>t.plan.current===0).sort((a,b)=>a.priority-b.priority || a.candidates.length-b.candidates.length || a.plan.code.localeCompare(b.plan.code));
  // Capacity-aware augmenting paths preserve coverage when flexible lanes compete with single-option lanes.
  // Each matched empty lane receives one provisional unit; all remaining units are allocated below.
  const chosen = new Map<Task,Candidate>(), holders = new Map<string,Set<Task>>();
  function match(task:Task, seenProducts:Set<string>): boolean {
    for (const c of task.candidates) {
      const id=c.product.id; if (seenProducts.has(id)) continue; seenProducts.add(id);
      const set=holders.get(id)??new Set<Task>(); holders.set(id,set);
      if (set.size<(remaining.get(id)??0)) {set.add(task);chosen.set(task,c);return true;}
      for (const previous of [...set]) if (match(previous,seenProducts)) {
        set.delete(previous);set.add(task);chosen.set(task,c);return true;
      }
    }
    return false;
  }
  for (const task of emptyTasks) match(task,new Set());
  const assign = (task:Task,c:Candidate,amount:number) => {
    const p=task.plan; p.productId=c.product.id;p.productName=c.product.name;p.target=c.target;
    p.removeExpected=c.original?0:p.current!;p.after=(c.original?p.current!:0)+amount;p.take=amount;
    p.action=c.original?'refill':'replace';p.reason=c.original?'top_up':'approved_replacement';
    remaining.set(c.product.id,(remaining.get(c.product.id)??0)-amount);
  };
  for (const t of emptyTasks) {const c=chosen.get(t);if(c)assign(t,c,1);}
  const otherTasks=tasks.filter(t=>t.plan.current!==0).sort((a,b)=>a.priority-b.priority || (a.plan.current!/a.plan.originalCapacity!)-(b.plan.current!/b.plan.originalCapacity!));
  for (const t of otherTasks) {
    const original=t.candidates.find(c=>c.original && (remaining.get(c.product.id)??0)>0);
    const fullOriginal=original && (remaining.get(original.product.id)??0)>=original.target-t.plan.current!;
    const replacement=t.candidates.find(c=>!c.original && (remaining.get(c.product.id)??0)>=c.target);
    const c=fullOriginal?original:replacement??original;
    if (c) assign(t,c,c.original?Math.min(remaining.get(c.product.id)??0,c.target-t.plan.current!,1):c.target);
  }
  // First bring all supplied lanes above the low-stock threshold, then top up toward full capacity.
  for (const stage of ['useful','full']) {
    let progress=true;
    for (let pass=0; progress && pass<1000; pass++) {
      progress=false;
      for (const t of [...emptyTasks,...otherTasks]) {
        const p=t.plan;
        if (!p.productId || !['refill','replace'].includes(p.action) || p.after===null || p.target===null) continue;
        const target=stage==='useful'?Math.min(p.target,Math.max(3,Math.floor(p.target*.2)+1)):p.target;
        const left=remaining.get(p.productId)??0;
        if (p.after<target && left>0) {p.take++;p.after++;remaining.set(p.productId,left-1);progress=true;}
      }
    }
  }
  const pickupMap = new Map<string,ProductPlan['pickup'][number]>();
  for (const p of lanes) if (p.take>0 && p.productId) {
    const product=products.get(p.productId)!;
    const item=pickupMap.get(p.productId)??{productId:p.productId,productName:product.name,category:product.category,quantity:0,available:product.available??0};
    item.quantity+=p.take;pickupMap.set(p.productId,item);
    if (p.after!==null && p.target!==null && p.after<p.target && p.action!=='replace') p.reason='insufficient_stock';
  }
  const pickup=[...pickupMap.values()].sort((a,b)=>planCategoryOrder(a.category,a.productName)-planCategoryOrder(b.category,b.productName)||a.productName.localeCompare(b.productName));
  const emptyAfter=lanes.filter(p=>p.after===0).length, unknownAfter=lanes.filter(p=>p.after===null || p.action==='exception').length;
  const underfilled=lanes.filter(p=>p.after!==null&&p.target!==null&&p.after>0&&p.after<p.target).length;
  const totalUnits=pickup.reduce((n,p)=>n+p.quantity,0);
  // Defensive invariants remain true even when multiple lanes use the same substitute.
  for(const p of pickup) if(p.quantity>p.available || p.quantity<1) throw new Error('Unsafe stock allocation rejected.');
  return {lanes,pickup,totalUnits,emptyAfter,unknownAfter,underfilled,replacements:lanes.filter(p=>p.action==='replace').length,
    status:errors.length||unknownAfter?'blocked':emptyAfter||underfilled?'partial':totalUnits?'complete':'nothing_to_load',
    generatedAt:input.now.toISOString(),expiresAt:new Date(Math.max(now,expires)).toISOString(),dispatchEnabled:false,errors};
}
