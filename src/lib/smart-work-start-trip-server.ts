import 'server-only';
import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes, normalizeRoles } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { previewRequiredProducts, ProductPlanError } from '@/lib/smart-work-products-server';

export class StartTripError extends Error {
  constructor(message: string, public status = 503, public retryable = false) { super(message); }
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export type StartTripInput = { dutyIds: string[]; inputFingerprint: string; requestId: string };
export type StartedTrip = { routeId: string; href: string; stopCount: number; reservedUnits: number; replayed: boolean };

export function parseStartTripInput(raw: unknown): StartTripInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StartTripError('Invalid trip request.', 400);
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'dutyIds,inputFingerprint,requestId' || !uuid(r.requestId)
    || typeof r.inputFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(r.inputFingerprint)
    || !Array.isArray(r.dutyIds) || r.dutyIds.length < 1 || r.dutyIds.length > 6 || !r.dutyIds.every(uuid)) {
    throw new StartTripError('Use the current product preview and select one to six required stops.', 400);
  }
  // Preserve the preview's order: its fingerprint includes the ordered machine inputs.
  const dutyIds = r.dutyIds.map(id => (id as string).toLowerCase());
  if (new Set(dutyIds).size !== dutyIds.length) throw new StartTripError('Select each required stop only once.', 400);
  return { dutyIds, inputFingerprint: r.inputFingerprint, requestId: r.requestId.toLowerCase() };
}

async function currentActor() {
  const profile = await getCurrentProfile();
  if (!profile || !profile.team_member_id || profile.active_status !== 'active' || profile.must_change_password || !canExecuteRoutes(profile)) {
    throw new StartTripError('Active operator access is required.', 403);
  }
  const db = getSupabaseAdminClient();
  if (!db) throw new StartTripError('Trip storage is unavailable. Nothing was started.');
  const row = await db.from('team_members').select('id,auth_user_id,role,roles,active,active_status,must_change_password')
    .eq('id', profile.team_member_id).eq('auth_user_id', profile.id).maybeSingle();
  if (row.error) throw new StartTripError('Could not verify current operator access.');
  if (!row.data || row.data.active !== true || row.data.active_status !== 'active' || row.data.must_change_password
    || !canExecuteRoutes(normalizeRoles(row.data.roles, row.data.role))) {
    throw new StartTripError('Operator access changed. Sign in again.', 403);
  }
  return { db, userId: profile.id, actorId: String(row.data.id) };
}

async function dispatchGate(a: Awaited<ReturnType<typeof currentActor>>) {
  if (process.env.SMART_WORK_START_TRIP_ENABLED === 'false') return { enabled:false,reason:'emergency_disabled',mode:'off' as const };
  const control=await a.db.from('smart_work_dispatch_control').select('enabled,mode').eq('id',1).maybeSingle();
  if(control.error) return {enabled:false,reason:'schema_unavailable',mode:'off' as const};
  if(!control.data?.enabled) return {enabled:false,reason:'release_not_enabled',mode:'off' as const};
  const mode=String(control.data.mode||'all');
  if(mode==='all') return {enabled:true,reason:'standing_rules_apply',mode:'all' as const};
  if(mode!=='pilot') return {enabled:false,reason:'release_not_enabled',mode:'off' as const};
  const scoped=await a.db.from('smart_work_dispatch_scope').select('machine_id').eq('operator_id',a.actorId).limit(1);
  if(scoped.error) return {enabled:false,reason:'schema_unavailable',mode:'pilot' as const};
  const enabled=Array.isArray(scoped.data)&&scoped.data.length>0;
  return {enabled,reason:enabled?'pilot_scope':'not_in_pilot',mode:'pilot' as const};
}
export async function startTripAvailability() {
  const a=await currentActor();
  const gate=await dispatchGate(a);
  return {enabled:gate.enabled,reason:gate.reason,mode:gate.mode};
}

function receipt(raw: unknown): StartedTrip {
  const r = raw as Partial<StartedTrip> | null;
  if (!r || !uuid(r.routeId) || !Number.isInteger(r.stopCount) || !Number.isInteger(r.reservedUnits)
    || Number(r.stopCount) < 1 || Number(r.stopCount) > 6 || Number(r.reservedUnits) < 1 || typeof r.replayed !== 'boolean') {
    throw new StartTripError('Save confirmation is unclear. Retry with the same request; do not create another trip.', 503, true);
  }
  return { routeId: r.routeId, href: `/operator/routes/${r.routeId}`, stopCount: Number(r.stopCount), reservedUnits: Number(r.reservedUnits), replayed: r.replayed };
}

export async function startRequiredTrip(raw: unknown): Promise<StartedTrip> {
  const input = parseStartTripInput(raw);
  const a = await currentActor();
  // Receipt resolution is permitted while the release is paused, but cannot create a new trip.
  const old = await a.db.from('smart_work_trip_requests').select('actor_id,duty_ids,input_fingerprint,result')
    .eq('auth_user_id', a.userId).eq('request_id', input.requestId).maybeSingle();
  if (old.error) throw new StartTripError('Could not verify whether this request already started. Keep the same request ID.', 503, true);
  if (old.data) {
    if (old.data.actor_id !== a.actorId || old.data.input_fingerprint !== input.inputFingerprint
      || !Array.isArray(old.data.duty_ids)
      || JSON.stringify([...old.data.duty_ids].sort()) !== JSON.stringify([...input.dutyIds].sort())) {
      throw new StartTripError('That request ID belongs to a different trip. Generate a fresh preview.', 409);
    }
    return receipt({ ...old.data.result, replayed: true });
  }
  const gate=await dispatchGate(a);
  if(!gate.enabled) throw new StartTripError(gate.reason==='not_in_pilot'?'Start Trip is currently limited to the controlled pilot.':'Start Trip is not enabled yet. Continue using existing assigned routes.',gate.reason==='not_in_pilot'?403:503);
  let preview: Awaited<ReturnType<typeof previewRequiredProducts>>;
  try { preview = await previewRequiredProducts({ dutyIds: input.dutyIds }); }
  catch (error) {
    if (error instanceof ProductPlanError) throw new StartTripError(error.message, error.status);
    throw error;
  }
  if (preview.inputFingerprint !== input.inputFingerprint) throw new StartTripError('Stock, rules or duties changed. Regenerate the product preview before starting.', 409);
  if (preview.plan.status !== 'complete' || preview.plan.emptyAfter || preview.plan.unknownAfter || preview.plan.underfilled
    || preview.plan.errors.length || preview.plan.totalUnits < 1 || !Number.isFinite(Date.parse(preview.plan.expiresAt))
    || Date.parse(preview.plan.expiresAt) <= Date.now()) {
    throw new StartTripError('The product plan is incomplete or expired. Resolve the shown lanes before starting.', 409);
  }
  const saved = await a.db.rpc('snacky_start_smart_work_trip_v1', {
    p_auth_user: a.userId, p_actor: a.actorId, p_request: input.requestId,
    p_duty_ids: input.dutyIds, p_fingerprint: input.inputFingerprint, p_plan: preview.plan,
  });
  if (saved.error) {
    const code = String(saved.error.code ?? '');
    if (code === '42501') throw new StartTripError('Your current account cannot start these duties.', 403);
    if (['40001', '40P01', '55P03'].includes(code)) throw new StartTripError('Work or stock is changing. Retry this request; regenerate the preview if its quantities changed.', 409, true);
    if (['22023', '23514', '23505', '22P02', '22007'].includes(code)) throw new StartTripError('Stock, lane coverage, priority or working hours no longer permit this trip. Refresh the preview.', 409);
    if (code === '55000') throw new StartTripError('Start Trip has not been enabled for production.', 503);
    throw new StartTripError('Trip save could not be confirmed. Retry with the same request ID.', 503, true);
  }
  return receipt(saved.data);
}
