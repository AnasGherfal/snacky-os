import { PRIORITY_RANK, type Priority } from './self-dispatch.ts';

/** Daily responsibility is NOT a route, a stock reservation, or evidence of service. */
export type DutyState = 'required' | 'in_progress' | 'blocked' | 'completed';
export type Duty = {
  id: string; machineId: string; machineName: string; serviceDate: string;
  priority: Priority; requiredAt: string; dueAt: string; visitMinutes: number;
  ownerId: string | null; ownerName: string | null; assignedBy: 'primary' | 'backup' | 'route' | null;
  state: DutyState; plannedAt: string | null; routeId: string | null;
  blocker: string | null; handover: { toId: string; toName: string; reason: string } | null;
  completedAt: string | null; receiptId: string | null; revision: number;
  events: { id: string; action: string; actorId: string; at: string; reason: string | null }[];
};
export type OperatorAvailability = {
  id: string; name: string; active: boolean; eligibleMachineIds: string[];
  availableFrom: string; availableUntil: string; availableMinutes: number;
};
export type CoverageRule = { machineId: string; primaryId: string; backupIds: string[] };
export type ServiceEvidence = {
  machineId: string; routeId: string; receiptId: string; operatorId: string;
  completedAt: string; status: 'verified' | 'pending' | 'partial';
  unresolvedLanes: number; underfilledLanes: number;
};
export class DutyError extends Error {
  code: 'invalid' | 'forbidden' | 'conflict';
  constructor(message: string, code: 'invalid' | 'forbidden' | 'conflict' = 'invalid') { super(message); this.code = code; }
}
const minute = 60_000;
const mandatory = new Set<Priority>(['immediate','urgent','today']);
const timestamp = (value: string) => Date.parse(value);
function validTime(value: string) { return Boolean(value && Number.isFinite(timestamp(value))); }
function requireReason(value: string) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500) throw new DutyError('Record a reason (3–500 characters).');
  return value.trim();
}
function requireDuty(duty: Duty) {
  if (!duty.id || !duty.machineId || !validTime(duty.requiredAt) || !validTime(duty.dueAt)
    || timestamp(duty.dueAt) < timestamp(duty.requiredAt) || !Number.isInteger(duty.visitMinutes)
    || duty.visitMinutes < 1 || duty.visitMinutes > 480 || !Number.isInteger(duty.revision) || duty.revision < 0) {
    throw new DutyError('The daily duty is incomplete. Verify its deadline and visit duration.');
  }
}
function canCover(operator: OperatorAvailability, duty: Duty, now: Date, allowOverdue = false) {
  const start = Math.max(now.getTime(), timestamp(operator.availableFrom));
  const end = allowOverdue && timestamp(duty.dueAt) <= now.getTime()
    ? timestamp(operator.availableUntil)
    : Math.min(timestamp(duty.dueAt), timestamp(operator.availableUntil));
  return operator.active && operator.eligibleMachineIds.includes(duty.machineId)
    && Number.isFinite(start) && Number.isFinite(end) && Number.isInteger(operator.availableMinutes)
    && operator.availableMinutes >= duty.visitMinutes && start + duty.visitMinutes * minute <= end;
}
function nextRevision(duty: Duty, revision: number, actorId: string, eventId: string, action: string, now: Date, reason: string | null = null) {
  requireDuty(duty);
  if (!actorId || !eventId || !Number.isFinite(now.getTime())) throw new DutyError('Invalid actor or event.');
  if (duty.revision !== revision) throw new DutyError('The daily assignment changed. Refresh before trying again.', 'conflict');
  if (duty.state === 'completed') throw new DutyError('A verified service record is already complete.', 'conflict');
  if (duty.events.some(e=>e.id===eventId)) throw new DutyError('This action has already been recorded.', 'conflict');
  return {...duty, revision:revision+1, events:[...duty.events,{id:eventId,action,actorId,at:now.toISOString(),reason}]};
}

/** Assign the whole due workload, not just the stop limit of somebody's next trip.
 * Availability/coverage/deadlines must be supplied from approved configuration.
 * This returns decisions for persistence by a coordinator; it never writes operations.
 */
export function allocateDailyDuties(duties: Duty[], operators: OperatorAvailability[], rules: CoverageRule[], now: Date) {
  if (!Number.isFinite(now.getTime())) throw new DutyError('Invalid evaluation time.');
  const ids = new Set<string>();
  for (const duty of duties) { requireDuty(duty); if (ids.has(duty.id)) throw new DutyError('Duplicate daily duty.'); ids.add(duty.id); }
  const people = new Map<string,OperatorAvailability>();
  for (const person of operators) { if (people.has(person.id)) throw new DutyError('Duplicate operator.'); people.set(person.id,{...person}); }
  const policy = new Map<string,CoverageRule>();
  for (const rule of rules) { if (policy.has(rule.machineId)) throw new DutyError('Duplicate coverage rule.'); policy.set(rule.machineId,rule); }
  const activeMachines = new Set<string>();
  for (const duty of duties.filter(d=>d.state!=='completed')) {
    if (activeMachines.has(duty.machineId)) throw new DutyError('A machine already has an outstanding duty.');
    activeMachines.add(duty.machineId);
  }
  const ordered = [...duties].sort((a,b)=>PRIORITY_RANK[a.priority]-PRIORITY_RANK[b.priority]
    || timestamp(a.dueAt)-timestamp(b.dueAt) || a.id.localeCompare(b.id));
  const notices: {dutyId:string;reason:'no_rule'|'no_capacity'|'owner_unavailable'|'blocked'|'past_deadline'}[] = [];
  const result = ordered.map(duty=>({...duty,events:[...duty.events]}));
  const spend = (person:OperatorAvailability,duty:Duty) => {
    const start=Math.max(now.getTime(),timestamp(person.availableFrom));
    person.availableFrom=new Date(start+duty.visitMinutes*minute).toISOString();
    person.availableMinutes-=duty.visitMinutes;
  };
  // Existing obligations consume time before any newly detected work. Never steal an owner on refresh.
  for (const duty of result.filter(d=>d.state!=='completed' && d.ownerId)) {
    const person=people.get(duty.ownerId!);
    if (person) {
      const feasible=canCover(person,duty,now);
      if (validTime(person.availableFrom)) spend(person,duty);
      if (!feasible) notices.push({dutyId:duty.id,reason:'owner_unavailable'});
    } else notices.push({dutyId:duty.id,reason:'owner_unavailable'});
    if (duty.state==='blocked') notices.push({dutyId:duty.id,reason:'blocked'});
  }
  for (const duty of result.filter(d=>d.state!=='completed' && !d.ownerId)) {
    const overdue=timestamp(duty.dueAt)<=now.getTime();
    if (overdue) notices.push({dutyId:duty.id,reason:'past_deadline'});
    const rule=policy.get(duty.machineId);
    if (!rule) {notices.push({dutyId:duty.id,reason:'no_rule'});continue;}
    const choices=[...new Set([rule.primaryId,...rule.backupIds])];
    const person=choices.map(id=>people.get(id)).find(p=>p && canCover(p,duty,now,overdue));
    if (!person) {notices.push({dutyId:duty.id,reason:'no_capacity'});continue;}
    duty.ownerId=person.id; duty.ownerName=person.name;
    duty.assignedBy=person.id===rule.primaryId?'primary':'backup'; duty.revision+=1;
    duty.plannedAt=new Date(Math.max(now.getTime(),timestamp(person.availableFrom))).toISOString();
    duty.events.push({id:`allocation:${duty.id}:${duty.revision}`,action:'daily_responsibility_assigned',actorId:'coordinator',at:now.toISOString(),reason:duty.assignedBy});
    spend(person,duty);
  }
  return {duties:result,notices,uncoveredDutyIds:result.filter(d=>d.state!=='completed'&&!d.ownerId).map(d=>d.id)};
}

/** One stop now does not release or mark skipped the rest of the operator's daily work. */
export function nextDutyTrip(duties: Duty[], operatorId: string, limit: number) {
  if (!Number.isInteger(limit) || limit<1 || limit>6) throw new DutyError('Choose one to six stops.');
  const mine=duties.filter(d=>d.ownerId===operatorId && d.state!=='completed');
  const eligible=mine.filter(d=>d.state==='required' && !d.routeId && !d.handover)
    .sort((a,b)=>PRIORITY_RANK[a.priority]-PRIORITY_RANK[b.priority] || timestamp(a.dueAt)-timestamp(b.dueAt) || a.id.localeCompare(b.id));
  const chosen=eligible.slice(0,limit);
  const ids=new Set(chosen.map(d=>d.id));
  return {selectedDutyIds:[...ids],selectedMachineIds:chosen.map(d=>d.machineId),
    stillResponsibleFor:mine.filter(d=>!ids.has(d.id)).map(d=>d.id),
    needsHelp:mine.filter(d=>d.state==='blocked'||d.handover).map(d=>d.id)};
}
export function checkDutyTripOrder(duties: Duty[], operatorId:string, selectedIds:string[]) {
  if (!selectedIds.length || new Set(selectedIds).size!==selectedIds.length) throw new DutyError('Select distinct daily duties.');
  const recommended=nextDutyTrip(duties,operatorId,selectedIds.length);
  if (selectedIds.some(id=>!recommended.selectedDutyIds.includes(id))) throw new DutyError('Do the highest-priority duties first, or record why they cannot be done now.','conflict');
  return recommended;
}

export function planDutyLater(duty:Duty, expectedRevision:number, actorId:string, eventId:string, plannedAt:string, now:Date) {
  if (duty.ownerId!==actorId) throw new DutyError('Only the responsible operator can set this visit time.','forbidden');
  if (duty.routeId || duty.state!=='required' || duty.handover) throw new DutyError('Resolve the current trip or handover first.','conflict');
  if (!validTime(plannedAt) || timestamp(plannedAt)<now.getTime()
    || timestamp(plannedAt)+duty.visitMinutes*minute>timestamp(duty.dueAt)) throw new DutyError('That visit would miss the service deadline. Request help instead.');
  return {...nextRevision(duty,expectedRevision,actorId,eventId,'plan_later',now),plannedAt};
}
export function reportDutyBlocked(duty:Duty, expectedRevision:number, actorId:string, eventId:string, reason:string, now:Date) {
  if (duty.ownerId!==actorId) throw new DutyError('Only the responsible operator can report this blocker.','forbidden');
  const message=requireReason(reason);
  return {...nextRevision(duty,expectedRevision,actorId,eventId,'report_blocked',now,message),state:'blocked' as const,blocker:message};
}
export function offerDutyHandover(duty:Duty, expectedRevision:number, actorId:string, eventId:string, target:OperatorAvailability, reason:string, now:Date) {
  if (duty.ownerId!==actorId) throw new DutyError('Only the responsible operator can offer this duty.','forbidden');
  if (duty.routeId || duty.state==='in_progress') throw new DutyError('A started trip requires the existing stock/custody handoff workflow.','conflict');
  if (target.id===actorId || !canCover(target,duty,now)) throw new DutyError('The backup cannot cover this machine before its deadline.');
  const message=requireReason(reason);
  return {...nextRevision(duty,expectedRevision,actorId,eventId,'offer_handover',now,message),
    handover:{toId:target.id,toName:target.name,reason:message}};
}
export function acceptDutyHandover(duty:Duty, expectedRevision:number, actor:OperatorAvailability, eventId:string, now:Date) {
  if (duty.handover?.toId!==actor.id) throw new DutyError('This handover was not offered to you.','forbidden');
  if (duty.routeId || !canCover(actor,duty,now)) throw new DutyError('Assignment or availability changed. Keep the current owner until resolved.','conflict');
  return {...nextRevision(duty,expectedRevision,actor.id,eventId,'accept_handover',now,duty.handover.reason),
    ownerId:actor.id,ownerName:actor.name,assignedBy:'backup' as const,state:'required' as const,
    handover:null,blocker:null,plannedAt:null};
}

/** Call only with trusted server-side service receipts, never client "done" input. */
export function completeDutyFromEvidence(duty:Duty, expectedRevision:number, evidence:ServiceEvidence, eventId:string, now:Date) {
  if (evidence.machineId!==duty.machineId || evidence.routeId!==duty.routeId || !duty.routeId
    || !evidence.receiptId || evidence.operatorId!==duty.ownerId || evidence.status!=='verified'
    || evidence.unresolvedLanes!==0 || evidence.underfilledLanes!==0 || !validTime(evidence.completedAt)
    || timestamp(evidence.completedAt)<timestamp(duty.requiredAt) || timestamp(evidence.completedAt)>now.getTime()+minute) {
    throw new DutyError('A visit, skipped stop, pending XY update or partial refill is not verified completion.','conflict');
  }
  return {...nextRevision(duty,expectedRevision,evidence.operatorId,eventId,'verified_service_completed',now),
    state:'completed' as const,completedAt:evidence.completedAt,receiptId:evidence.receiptId,blocker:null,handover:null};
}

/** A new snapshot cannot silently erase an already-required service or reset its deadline. */
export function reconcileDutyDemand(existing:Duty[], detected:Duty[]) {
  const result=existing.map(d=>({...d,events:[...d.events]}));
  for (const candidate of detected) {
    requireDuty(candidate);
    const outstanding=result.find(d=>d.machineId===candidate.machineId && d.state!=='completed');
    if (outstanding) {
      const priority=PRIORITY_RANK[candidate.priority]<PRIORITY_RANK[outstanding.priority]?candidate.priority:outstanding.priority;
      const dueAt=timestamp(candidate.dueAt)<timestamp(outstanding.dueAt)?candidate.dueAt:outstanding.dueAt;
      if (priority!==outstanding.priority || dueAt!==outstanding.dueAt) {outstanding.priority=priority;outstanding.dueAt=dueAt;outstanding.revision+=1;}
      continue;
    }
    if (result.some(d=>d.id===candidate.id)) continue;
    const completed=result.filter(d=>d.machineId===candidate.machineId && d.completedAt).sort((a,b)=>timestamp(b.completedAt!)-timestamp(a.completedAt!))[0];
    if (completed && timestamp(candidate.requiredAt)<=timestamp(completed.completedAt!)) continue;
    result.push({...candidate,events:[...candidate.events]});
  }
  return result;
}

export function declineDutyHandover(duty:Duty, expectedRevision:number, actorId:string, eventId:string, reason:string, now:Date) {
  if (duty.handover?.toId!==actorId) throw new DutyError('This handover was not offered to you.','forbidden');
  const message=requireReason(reason);
  return {...nextRevision(duty,expectedRevision,actorId,eventId,'decline_handover',now,message),
    handover:null,state:'blocked' as const,blocker:message};
}

export function dailyCoverageSummary(duties:Duty[], now:Date, warnBeforeMinutes=30) {
  const active=duties.filter(d=>d.state!=='completed');
  const issues=active.map(d=>({dutyId:d.id,machineId:d.machineId,ownerId:d.ownerId,
    uncovered:!d.ownerId,blocked:d.state==='blocked',handoverPending:Boolean(d.handover),
    overdue:timestamp(d.dueAt)<=now.getTime(),
    atRisk:timestamp(d.dueAt)-d.visitMinutes*minute-now.getTime()<=warnBeforeMinutes*minute}));
  return {total:duties.length,completed:duties.length-active.length,remaining:active.length,
    uncovered:issues.filter(i=>i.uncovered).length,overdue:issues.filter(i=>i.overdue).length,
    needsAttention:issues.filter(i=>i.uncovered||i.blocked||i.handoverPending||i.atRisk),
    allCompleted:active.length===0,allAssigned:issues.every(i=>!i.uncovered),issues};
}

/** Honest read-only projection while the persistent coordinator is not released.
 * A preview selection and a "later" intention do not confer daily ownership.
 */
export function projectMandatoryWork(board: {
  machineId:string; name:string; priority:Priority; openToday:boolean; unknown:number;
  assignments:{operatorName:string;operatorAssigned:boolean;mine:boolean;routeId:string|null;routeDate:string}[];
}[], now:Date) {
  const rows=board.filter(m=>mandatory.has(m.priority)||m.assignments.length>0).map(m=>({
    machineId:m.machineId,name:m.name,priority:m.priority,openToday:m.openToday,
    state:m.assignments.length>1?'conflict' as const:!m.openToday?'access_blocked' as const:
      m.assignments.length===1 && m.assignments[0].operatorAssigned?'assigned' as const:'uncovered' as const,
    responsible:m.assignments.length===1 && m.assignments[0].operatorAssigned?m.assignments[0].operatorName:null,
    mine:m.assignments.some(a=>a.mine),deadline:null as string|null,
    deadlineNeedsSetup:true,unknownLanes:m.unknown,
    source:m.assignments.length?'existing_route' as const:'no_daily_owner' as const,
  }));
  return {mode:'daily_coverage_preview' as const,generatedAt:now.toISOString(),rows,
    total:rows.length,uncovered:rows.filter(r=>!r.responsible).length,
    urgentUncovered:rows.filter(r=>!r.responsible&&['immediate','urgent'].includes(r.priority)).length,
    blocked:rows.filter(r=>r.state==='access_blocked'||r.state==='conflict').length,
    coordinatorEnabled:false as const};
}
