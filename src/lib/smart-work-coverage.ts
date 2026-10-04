/** Approved configuration only. This module never assigns work or reserves stock. */
export type WorkWindow = { day: number; start: string; end: string; minutes: number };
export type MachineCoverage = {
  primaryId: string; backupId: string | null; days: number[];
  accessStart: string; accessEnd: string; travelMinutes: number; serviceMinutes: number; enabled: boolean;
};
export type CoverageSave =
  | { kind: 'machine'; id: string; version: number; value: MachineCoverage }
  | { kind: 'operator'; id: string; version: number; value: { windows: WorkWindow[]; enabled: boolean } };
export class CoverageInputError extends Error {}
const fail = (message: string): never => { throw new CoverageInputError(message); };
export function coverageUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected an object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail('Unexpected field. Refresh the form.');
}
function integer(value: unknown, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) return fail('Invalid whole number.');
  return value;
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') return fail('Choose enabled or disabled.'); return value; }
export function clockMinutes(value: unknown): number {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fail('Use a valid 24-hour time.');
  const [h,m] = value.split(':').map(Number); return h * 60 + m;
}
export function parseCoverageSave(input: unknown): CoverageSave {
  const row = object(input); keys(row,['kind','id','version','value']);
  if (!coverageUuid(row.id)) return fail('Choose a valid machine or operator.');
  const id = row.id, version = integer(row.version,0,2147483646), value = object(row.value);
  if (row.kind === 'machine') {
    keys(value,['primaryId','backupId','days','accessStart','accessEnd','travelMinutes','serviceMinutes','enabled']);
    if (!coverageUuid(value.primaryId) || (value.backupId !== null && !coverageUuid(value.backupId))) return fail('Choose valid primary and backup operators.');
    if (value.primaryId === value.backupId) return fail('Primary and backup must be different people.');
    if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 7) return fail('Select site access days.');
    const days = value.days.map(d => integer(d,1,7));
    if (new Set(days).size !== days.length) return fail('Duplicate access day.');
    const start = clockMinutes(value.accessStart), end = clockMinutes(value.accessEnd);
    if (end <= start) return fail('Access end must follow start on the same day.');
    const serviceMinutes = integer(value.serviceMinutes,1,480), travelMinutes = integer(value.travelMinutes,0,480);
    if (serviceMinutes > end-start) return fail('The site access window is shorter than the visit.');
    return {kind:'machine',id,version,value:{primaryId:value.primaryId,backupId:value.backupId as string|null,
      days:days.sort((a,b)=>a-b),accessStart:value.accessStart as string,accessEnd:value.accessEnd as string,
      serviceMinutes,travelMinutes,enabled:flag(value.enabled)}};
  }
  if (row.kind === 'operator') {
    keys(value,['windows','enabled']);
    if (!Array.isArray(value.windows) || value.windows.length > 7) return fail('Provide up to seven work days.');
    const enabled = flag(value.enabled);
    if (enabled && !value.windows.length) return fail('An enabled operator needs a work window.');
    const windows = value.windows.map(item => {
      const w = object(item); keys(w,['day','start','end','minutes']);
      const day = integer(w.day,1,7), start = clockMinutes(w.start), end = clockMinutes(w.end);
      if (end <= start) return fail('Shift end must follow start on the same day.');
      const minutes = integer(w.minutes,1,960);
      if (minutes > end-start) return fail('Available work minutes cannot exceed the shift.');
      return {day,start:w.start as string,end:w.end as string,minutes};
    });
    if (new Set(windows.map(w=>w.day)).size !== windows.length) return fail('Only one work window per weekday is supported in this release.');
    return {kind:'operator',id,version,value:{windows:windows.sort((a,b)=>a.day-b.day),enabled}};
  }
  return fail('Unknown setting type.');
}
