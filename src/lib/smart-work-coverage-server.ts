import 'server-only';
import { getCurrentProfile } from '@/lib/auth';
import { isOwnerAdminRole, canExecuteRoutes } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { CoverageInputError, parseCoverageSave } from '@/lib/smart-work-coverage';
export class CoverageAccessError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function coverageActor() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || profile.must_change_password || !profile.team_member_id || !isOwnerAdminRole(profile)) {
    throw new CoverageAccessError('Owner/admin access is required.',403);
  }
  const db = getSupabaseAdminClient();
  if (!db) throw new CoverageAccessError('Coverage storage is unavailable.',503);
  return {profile,db};
}
export type CoverageRow = {id:string;kind:'machine'|'operator';machine_id:string|null;operator_id:string|null;value:Record<string,unknown>;version:number;updated_at:string};
export async function loadCoverageSettings() {
  const {db} = await coverageActor();
  const [m,p,s] = await Promise.all([
    db.from('machines').select('id,name,machine_code,status').order('name').limit(501),
    db.from('team_members').select('id,full_name,role,roles,active,active_status').order('full_name').limit(501),
    db.from('smart_work_coverage_settings').select('id,kind,machine_id,operator_id,value,version,updated_at').order('id').limit(1001),
  ]);
  if (m.error || p.error || s.error || !m.data || !p.data || !s.data) throw new CoverageAccessError('Could not load saved coverage settings. Nothing was changed.',503);
  if (m.data.length>500 || p.data.length>500 || s.data.length>1000) throw new CoverageAccessError('Coverage setup exceeded its supported size. No partial list is shown.',503);
  return {machines:m.data.map(x=>({id:String(x.id),name:String(x.name||x.machine_code),active:x.status==='active'})),
    operators:p.data.filter(x=>canExecuteRoutes(x)).map(x=>({id:String(x.id),name:String(x.full_name),active:x.active===true&&x.active_status==='active'})),
    settings:s.data as CoverageRow[],coordinationEnabled:false as const,dispatchEnabled:false as const};
}
export async function saveCoverageSettings(raw: unknown) {
  const {profile,db}=await coverageActor();
  const input=parseCoverageSave(raw);
  const result=await db.rpc('snacky_save_smart_work_coverage',{
    p_actor:profile.team_member_id,p_kind:input.kind,p_target:input.id,p_expected:input.version,p_value:input.value,
  });
  if (result.error) {
    if (result.error.code==='40001' || result.error.code==='23505') throw new CoverageAccessError('Another save changed these settings. Reload before saving again.',409);
    if (result.error.code==='42501') throw new CoverageAccessError('Your account cannot change coverage settings.',403);
    if (result.error.code==='22023' || result.error.code==='23514') throw new CoverageInputError('Verify the people, access days and working hours before saving.');
    throw new CoverageAccessError('Coverage settings were not saved. Try again after checking the connection.',503);
  }
  if (!result.data) throw new CoverageAccessError('Save confirmation was missing. Reload to verify the saved version.',503);
  return result.data as CoverageRow;
}
