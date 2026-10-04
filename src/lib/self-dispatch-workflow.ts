import { PRIORITY_RANK, type Priority, type TripPlan } from './self-dispatch.ts';

/** Workflow decisions only. These never claim a stop or reserve stock. */
export type WorkCandidate = {
  machineId: string;
  name: string;
  priority: Priority;
  eligible: boolean;
  openToday: boolean;
  claimedBy: string | null;
};
export type LaterIntention = { machineId: string; operatorId: string; plannedAt: string };
export type WorkSelection = {
  selectedMachineIds: string[];
  deferredMachineIds: string[];
  uncoveredImmediateMachineIds: string[];
  excluded: { machineId: string; reason: 'outside_scope' | 'closed' | 'already_claimed' | 'verify' | 'not_due' }[];
};

/** Select only the work an operator is committing to now. Later plans are advisory. */
export function selectNextTrip(candidates: WorkCandidate[], stopLimit: number): WorkSelection {
  if (!Number.isInteger(stopLimit) || stopLimit < 1 || stopLimit > 6) {
    throw new Error('Choose between one and six stops for this trip.');
  }
  const ids = new Set<string>();
  const excluded: WorkSelection['excluded'] = [];
  const eligible: WorkCandidate[] = [];
  for (const c of candidates) {
    if (!c.machineId || ids.has(c.machineId)) throw new Error('The work board contains a missing or duplicate machine. Refresh it.');
    ids.add(c.machineId);
    const reason = !c.eligible ? 'outside_scope'
      : !c.openToday ? 'closed'
        : c.claimedBy ? 'already_claimed'
          : c.priority === 'verify' ? 'verify'
            : ['healthy', 'monitor'].includes(c.priority) ? 'not_due' : null;
    if (reason) excluded.push({ machineId: c.machineId, reason });
    else eligible.push(c);
  }
  eligible.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.name.localeCompare(b.name) || a.machineId.localeCompare(b.machineId));
  const selectedMachineIds = eligible.slice(0, stopLimit).map(c => c.machineId);
  const deferred = eligible.slice(stopLimit);
  return {
    selectedMachineIds,
    deferredMachineIds: deferred.map(c => c.machineId),
    uncoveredImmediateMachineIds: deferred.filter(c => c.priority === 'immediate').map(c => c.machineId),
    excluded,
  };
}

export function dispatchReadiness(plan: TripPlan) {
  const needsCoverageReview = plan.emptyAfter > 0 || plan.unknownAfter > 0 || plan.underfilled > 0;
  const hasWork = plan.totalUnits > 0 && plan.pickup.length > 0;
  const blocked = plan.errors.length > 0 || !hasWork;
  return {
    // A plan being computationally valid is not permission to dispatch it.
    canStartRoutine: !blocked && !needsCoverageReview,
    canReviewPartial: !blocked && needsCoverageReview,
    blocked,
    requiresAcknowledgement: !blocked && needsCoverageReview,
    coverage: { empty: plan.emptyAfter, unknown: plan.unknownAfter, underfilled: plan.underfilled },
  };
}

/** Filter intentions for display; they confer no ownership and hold no inventory. */
export function visibleLaterIntentions(intentions: LaterIntention[], board: WorkCandidate[], now: Date) {
  const byId = new Map(board.map(c => [c.machineId, c]));
  return intentions.filter(i => {
    const c = byId.get(i.machineId);
    const at = Date.parse(i.plannedAt);
    return Boolean(c && c.eligible && !c.claimedBy && Number.isFinite(at)
      && at > now.getTime() && at <= now.getTime() + 24 * 60 * 60 * 1000);
  });
}

export function canReleasePreparation(input: {
  started: boolean; pickedUnits: number; hasCustody: boolean; expiresAt: string; now: Date;
}) {
  // Unknown or physically collected stock must never be freed by a timer.
  return !input.started && !input.hasCustody
    && Number.isInteger(input.pickedUnits) && input.pickedUnits === 0
    && Number.isFinite(Date.parse(input.expiresAt))
    && Date.parse(input.expiresAt) <= input.now.getTime();
}
