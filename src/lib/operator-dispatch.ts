/** Pure dispatch rules. No credentials, database writes, or live-sales dependency. */
export type DispatchPolicy = {
  maxStops: number; staleMinutes: number; allowPartial: boolean;
  emptyToday: number; emptyUrgent: number; emptyImmediate: number;
  lowPercent: number; todayPercent: number; urgentPercent: number; immediatePercent: number;
};
export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  maxStops: 3, staleMinutes: 30, allowPartial: false,
  emptyToday: 16, emptyUrgent: 20, emptyImmediate: 25,
  lowPercent: 20, todayPercent: 35, urgentPercent: 25, immediatePercent: 15,
};
export type DispatchMachine = { id: string; name: string; location_id: string | null; locationType?: string | null; refill_open_days: number[]; };
export type DispatchLane = {
  machine_id: string; slot_code: string; product_id: string | null;
  current_qty: number | null; capacity: number | null; captured_at: string | null;
  slot_id: string | null; enabled: boolean; expected?: boolean;
};
export type DispatchProduct = { id: string; name: string; category: string | null; active: boolean; available: number; };
export type DispatchFit = { machine_slot_id: string; product_id: string; rule: string; verified_capacity: number | null; };
export type DispatchRestriction = { machine_id: string | null; location_id: string | null; location_type: string | null; product_id: string; rule: string; };
export type DispatchPriority = "immediate" | "urgent" | "today" | "monitor" | "healthy" | "closed" | "verify";
export const DISPATCH_PRIORITY_RANK: Record<DispatchPriority, number> = { immediate: 0, urgent: 1, today: 2, verify: 3, monitor: 4, closed: 5, healthy: 6 };
export type DispatchCard = {
  id: string; name: string; priority: DispatchPriority; reason: string;
  empty: number; low: number; total: number; fullness: number | null; averageLaneFullness: number | null;
  unknown: number; stale: number; open: boolean; latestAt: string | null;
};
export type DispatchChoice = { productId: string; productName: string; capacity: number; original: boolean; available: number; evidence: "current_product" | "approved_lane"; preferred: boolean; };
export type DispatchTask = { lane: DispatchLane; machineName: string; choices: DispatchChoice[]; issue: string | null; mustReplace?: boolean; };
export type DispatchPlanLane = {
  machineId: string; machineName: string; slotId: string | null; slotCode: string;
  originalProductId: string | null; originalProductName: string;
  productId: string | null; productName: string; currentQty: number | null;
  originalCapacity: number | null; targetCapacity: number | null; capturedAt: string | null;
  quantity: number; afterQty: number | null; returnQty: number;
  action: "keep" | "refill" | "replace" | "uncovered" | "verify";
  issue: string | null; notes: string; fitEvidence: string | null;
};
export type DispatchPlan = {
  machineIds: string[]; lanes: DispatchPlanLane[];
  pickup: Array<{ productId: string; productName: string; category: string | null; quantity: number }>;
  totalUnits: number; emptyAfter: number; underfilled: number; unknown: number;
  substitutions: number; complete: boolean; canStart: boolean;
};
export function wholeUnits(value: unknown): number {
  const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
export function tripoliDay(now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const v = (k: string) => p.find(x => x.type === k)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
export function isOpenToday(machine: DispatchMachine, now: Date): boolean {
  const day = new Date(`${tripoliDay(now)}T12:00:00Z`).getUTCDay() || 7;
  return (machine.refill_open_days?.length ? machine.refill_open_days : [1,2,3,4,5,6,7]).includes(day);
}
export function laneIssue(lane: DispatchLane, now: Date, policy = DEFAULT_DISPATCH_POLICY): string | null {
  if (!lane.slot_id) return "Lane is not linked to the current machine configuration.";
  if (lane.current_qty === null || !Number.isInteger(lane.current_qty) || lane.current_qty < 0) return "Quantity needs a physical check.";
  if (lane.capacity === null || !Number.isInteger(lane.capacity) || lane.capacity <= 0 || lane.current_qty > lane.capacity) return "Lane capacity needs confirmation.";
  const time = Date.parse(lane.captured_at ?? "");
  if (!Number.isFinite(time) || time > now.getTime() + 60_000 || now.getTime() - time > policy.staleMinutes * 60_000) return "XY reading is stale or missing.";
  if (!lane.product_id) return "Product is not mapped to the Snacky catalog.";
  return null;
}
export function machineCards(machines: DispatchMachine[], lanes: DispatchLane[], now = new Date(), policy = DEFAULT_DISPATCH_POLICY): DispatchCard[] {
  return machines.map(machine => {
    const rows = lanes.filter(l => l.enabled && l.machine_id === machine.id);
    const physical = rows.filter(l => l.current_qty !== null && l.capacity !== null && Number.isInteger(l.current_qty) && l.current_qty >= 0 && l.capacity > 0 && l.current_qty <= l.capacity);
    const stale = rows.filter(l => { const t = Date.parse(l.captured_at ?? ""); return !Number.isFinite(t) || now.getTime() - t > policy.staleMinutes * 60_000 || t > now.getTime() + 60_000; }).length;
    const unknown = rows.filter(l => laneIssue(l, now, policy)).length;
    const empty = physical.filter(l => l.current_qty === 0).length;
    const low = physical.filter(l => l.current_qty! > 0 && (l.current_qty! <= 2 || l.current_qty! / l.capacity! * 100 <= policy.lowPercent)).length;
    const average = physical.length ? physical.reduce((s,l) => s + l.current_qty! / l.capacity! * 100, 0) / physical.length : null;
    const capacity = physical.reduce((s,l) => s + l.capacity!,0);
    const fullness = capacity ? physical.reduce((s,l) => s + l.current_qty!,0) / capacity * 100 : null;
    const open = isOpenToday(machine, now);
    let priority: DispatchPriority = "healthy";
    if (!rows.length || !physical.length) priority = "verify";
    else if (!open) priority = "closed";
    else if (empty >= policy.emptyImmediate || average! <= policy.immediatePercent || empty / rows.length >= 0.6) priority = "immediate";
    else if (empty >= policy.emptyUrgent || average! <= policy.urgentPercent || (empty + low) / rows.length >= 0.5) priority = "urgent";
    else if (empty >= policy.emptyToday || average! <= policy.todayPercent || empty / rows.length >= 0.3) priority = "today";
    else if (unknown || stale) priority = "verify";
    else if (empty || low || average! < 60) priority = "monitor";
    const reason = priority === "verify" ? `${unknown || rows.length || 1} lane readings need verification; missing data is not counted as empty.`
      : !open ? "Outside this machine's configured service days."
      : `${empty} empty, ${low} low, ${Math.round(average ?? 0)}% average lane fullness.${unknown ? ` Also verify ${unknown} lane readings.` : ""}`;
    return { id: machine.id, name: machine.name, priority, reason, empty, low, total: rows.length, fullness, averageLaneFullness: average, unknown, stale, open,
      latestAt: rows.map(l => l.captured_at).filter((x): x is string => !!x).sort().at(-1) ?? null };
  }).sort((a,b) => DISPATCH_PRIORITY_RANK[a.priority] - DISPATCH_PRIORITY_RANK[b.priority] || (a.averageLaneFullness ?? 100) - (b.averageLaneFullness ?? 100) || a.name.localeCompare(b.name));
}
function applicableRules(machine: DispatchMachine, productId: string, restrictions: DispatchRestriction[]) {
  return restrictions.filter(r => r.product_id === productId && (
    (r.machine_id !== null && r.machine_id === machine.id) ||
    (r.location_id !== null && r.location_id === machine.location_id) ||
    (r.location_type !== null && r.location_type === machine.locationType)
  ));
}
export function buildDispatchTasks(machines: DispatchMachine[], lanes: DispatchLane[], products: DispatchProduct[], fits: DispatchFit[], restrictions: DispatchRestriction[], now = new Date(), policy = DEFAULT_DISPATCH_POLICY): DispatchTask[] {
  const machineMap = new Map(machines.map(m => [m.id,m]));
  const productMap = new Map(products.map(p => [p.id,p]));
  return lanes.filter(l => l.enabled && machineMap.has(l.machine_id)).map(lane => {
    const machine = machineMap.get(lane.machine_id)!;
    const original = lane.product_id ? productMap.get(lane.product_id) : null;
    const issue = laneIssue(lane, now, policy) ?? (!original?.active ? "Current product is inactive or missing from the catalog." : null);
    if (issue) return { lane, machineName: machine.name, choices: [], issue };
    const slotRules = fits.filter(f => f.machine_slot_id === lane.slot_id);
    const currentAllowed = !slotRules.some(f => f.product_id === original!.id && f.rule === "prohibited") && !applicableRules(machine,original!.id,restrictions).some(r => r.rule === "prohibited");
    const shouldConsiderReplacement = lane.current_qty === 0 || !currentAllowed || (original!.available === 0 && lane.current_qty! <= lane.capacity! / 2);
    const choices: DispatchChoice[] = products.flatMap(product => {
      if (!product.active || product.available <= 0) return [];
      const local = applicableRules(machine,product.id,restrictions);
      if (local.some(r => r.rule === "prohibited") || slotRules.some(f => f.product_id === product.id && f.rule === "prohibited")) return [];
      const same = product.id === original!.id;
      const verified = slotRules.find(f => f.product_id === product.id && f.rule === "allowed" && Number.isInteger(f.verified_capacity) && f.verified_capacity! > 0);
      if (!same && (!shouldConsiderReplacement || !verified)) return [];
      const cap = same ? lane.capacity! : verified!.verified_capacity!;
      // Never clear a non-empty lane to replace it with a token quantity.
      if (!same && lane.current_qty! > 0 && product.available < Math.min(cap, Math.max(lane.current_qty!, Math.ceil(cap / 2)))) return [];
      return [{ productId: product.id, productName: product.name, capacity: cap, original: same, available: wholeUnits(product.available), evidence: same ? "current_product" as const : "approved_lane" as const, preferred: local.some(r => r.rule === "preferred") }];
    });
    choices.sort((a,b) => {
      const sufficient = (c: DispatchChoice) => c.available >= Math.max(1, Math.ceil((c.capacity - (c.original ? lane.current_qty! : 0)) / 2));
      return Number(sufficient(b)) - Number(sufficient(a)) || Number(b.original) - Number(a.original) || Number(b.preferred) - Number(a.preferred) || b.available - a.available || a.productName.localeCompare(b.productName);
    });
    return { lane, machineName: machine.name, choices, mustReplace: !currentAllowed, issue: !currentAllowed && !choices.length ? "Current product is prohibited and no approved replacement is available." : null };
  });
}
/** AI supplies product preferences only. Integer quantities and coverage are computed here. */
export function allocateDispatchPlan(machineIds: string[], tasks: DispatchTask[], products: DispatchProduct[], preferences: Record<string,string> = {}, policy = DEFAULT_DISPATCH_POLICY): DispatchPlan {
  const remaining = new Map(products.map(p => [p.id, wholeUnits(p.available)]));
  const productMap = new Map(products.map(p => [p.id,p]));
  const order = new Map(machineIds.map((id,i) => [id,i]));
  const rows = tasks.filter(t => machineIds.includes(t.lane.machine_id)).map(task => {
    const l = task.lane;
    const name = productMap.get(l.product_id ?? "")?.name ?? "Unmapped product";
    const row: DispatchPlanLane = { machineId:l.machine_id,machineName:task.machineName,slotId:l.slot_id,slotCode:l.slot_code,
      originalProductId:l.product_id,originalProductName:name,productId:l.product_id,productName:name,currentQty:l.current_qty,
      originalCapacity:l.capacity,targetCapacity:l.capacity,capturedAt:l.captured_at,quantity:0,afterQty:l.current_qty,returnQty:0,
      action:task.issue ? "verify" : "keep",issue:task.issue,notes:"",fitEvidence:null };
    return { task, row, chosen:null as DispatchChoice | null };
  });
  rows.sort((a,b) => Number(a.row.currentQty !== 0) - Number(b.row.currentQty !== 0) || a.task.choices.length - b.task.choices.length || (order.get(a.row.machineId) ?? 0) - (order.get(b.row.machineId) ?? 0) || a.row.slotCode.localeCompare(b.row.slotCode,undefined,{numeric:true}));
  for (const item of rows) {
    const { task,row } = item;
    if (row.issue || row.currentQty === null || row.originalCapacity === null || (row.currentQty >= row.originalCapacity && !task.mustReplace)) continue;
    const hint = preferences[`${row.machineId}:${row.slotCode}`];
    const candidates = [...task.choices].sort((a,b) => Number(b.productId === hint) - Number(a.productId === hint));
    const chosen = candidates.find(c => {
      const min = !c.original && row.currentQty! > 0 ? Math.min(c.capacity,Math.max(row.currentQty!,Math.ceil(c.capacity/2))) : 1;
      return (remaining.get(c.productId) ?? 0) >= min;
    });
    if (!chosen) {
      if (task.mustReplace) { row.action="verify"; row.issue="Prohibited current product cannot be replaced with the available approved stock."; }
      else if (row.currentQty === 0) { row.action="uncovered"; row.issue="No approved compatible product remains in unreserved storage."; }
      continue;
    }
    item.chosen=chosen;
    row.productId=chosen.productId; row.productName=chosen.productName; row.targetCapacity=chosen.capacity; row.fitEvidence=chosen.evidence;
    row.returnQty=chosen.original ? 0 : row.currentQty;
    const base = chosen.original ? row.currentQty : 0;
    const minimum = !chosen.original && row.currentQty > 0 ? Math.min(chosen.capacity,Math.max(row.currentQty,Math.ceil(chosen.capacity/2))) : base === 0 ? 1 : 0;
    row.quantity=minimum; row.afterQty=base+minimum;
    remaining.set(chosen.productId,(remaining.get(chosen.productId) ?? 0)-minimum);
  }
  // Empty lanes receive coverage first, then all lanes reach useful levels,
  // then top-ups. This avoids filling the first lane while starving the last.
  for (const level of [0.5,1]) {
    let progressed = true;
    while (progressed) {
      progressed=false;
      for (const item of rows) {
        const { chosen,row }=item;
        if (!chosen || row.afterQty === null || row.afterQty >= Math.ceil(chosen.capacity*level)) continue;
        const left=remaining.get(chosen.productId) ?? 0;
        if (left <= 0) continue;
        remaining.set(chosen.productId,left-1); row.quantity++; row.afterQty++; progressed=true;
      }
    }
  }
  const pickups = new Map<string,{productId:string;productName:string;category:string|null;quantity:number}>();
  for (const {row} of rows) {
    if (row.quantity > 0 && row.productId) {
      row.action=row.productId !== row.originalProductId ? "replace" : "refill";
      row.notes=row.action === "replace"
        ? `Lane ${row.slotCode}: count and remove ${row.originalProductName} first (XY estimate ${row.currentQty}); record the actual machine return, change and verify XY to ${row.productName}, then add ${row.quantity}. Do not mix products. Return removed goods through the existing custody workflow.`
        : `Lane ${row.slotCode}: add ${row.quantity} ${row.productName}; expected ${row.afterQty}/${row.targetCapacity}.`;
      const p=pickups.get(row.productId) ?? { productId:row.productId,productName:row.productName,category:productMap.get(row.productId)?.category ?? null,quantity:0 };
      p.quantity+=row.quantity; pickups.set(row.productId,p);
    }
  }
  const lanes=rows.map(r=>r.row).sort((a,b)=>(order.get(a.machineId)??0)-(order.get(b.machineId)??0)||a.slotCode.localeCompare(b.slotCode,undefined,{numeric:true}));
  const emptyAfter=lanes.filter(l=>l.afterQty===0).length;
  const unknown=lanes.filter(l=>l.action==="verify").length;
  const underfilled=lanes.filter(l=>l.afterQty!==null && l.targetCapacity!==null && l.afterQty>0 && l.afterQty<l.targetCapacity).length;
  const pickup=[...pickups.values()];
  const totalUnits=pickup.reduce((s,p)=>s+p.quantity,0);
  return {machineIds,lanes,pickup,totalUnits,emptyAfter,underfilled,unknown,substitutions:lanes.filter(l=>l.action==="replace").length,
    complete:emptyAfter===0 && unknown===0 && underfilled===0,
    canStart:totalUnits>0 && unknown===0 && (emptyAfter===0 || policy.allowPartial)};
}

export function tripoliLocalToIso(local: string): string {
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if(!match) throw new Error("Choose a date and time in Libya time.");
  const [y,m,d,h,min]=match.slice(1).map(Number);
  const guess=Date.UTC(y,m-1,d,h,min);
  if(!Number.isFinite(guess) || m<1 || m>12 || d<1 || d>31 || h>23 || min>59 || new Date(guess).getUTCDate()!==d) throw new Error("Invalid local date or time.");
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(guess));
  const v=(key:string)=>Number(parts.find(p=>p.type===key)?.value);
  const displayed=Date.UTC(v("year"),v("month")-1,v("day"),v("hour"),v("minute"));
  return new Date(guess-(displayed-guess)).toISOString();
}
