/** Serialized duty board. Responsibility is not a route or permission to collect goods. */
export type DutyView = {
  id: string; machineId: string; machineName: string; serviceDate: string;
  priority: 'today'|'urgent'|'immediate'; state: 'required'|'in_progress'|'verification_pending'|'completed';
  requiredAt: string; dueAt: string|null; ownerName: string|null; mine: boolean;
  assignedVia: string|null; blocker: string|null; completedAt: string|null; overdue: boolean;
};
export type DutyBoard = {duties: DutyView[]; checkedAt: string; dispatchEnabled: false;
  counts: {remaining:number; mine:number; uncovered:number; overdue:number; completed:number; uncertainMachines:number}; canConfigure:boolean};
export function parseDutyRefresh(value: unknown) {
  if(!value || typeof value!=='object' || Array.isArray(value)
    || Object.keys(value).length!==1 || (value as Record<string,unknown>).action!=='refresh') {
    throw new Error('Only a fresh evaluation is accepted. Quantities and assignments cannot be supplied.');
  }
  return 'refresh' as const;
}
