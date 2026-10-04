import 'server-only';
import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes, isOwnerAdminRole } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { loadAccessibleOperatorIds } from '@/lib/operator-route-access';
import type { DutyBoard, DutyView } from '@/lib/smart-work-duties';
export class DutyAccessError extends Error {constructor(message:string,public status=503){super(message);}}
async function actor() {
  const profile=await getCurrentProfile();
  if(!profile || !profile.team_member_id || profile.active_status!=='active' || profile.must_change_password || !canExecuteRoutes(profile)) {
    throw new DutyAccessError('Active operator or operations access required.',403);
  }
  const db=getSupabaseAdminClient();
  if(!db) throw new DutyAccessError('Daily duties are unavailable. Continue using assigned routes.');
  return {profile,db};
}
type DutyRow={id:string;machine_id:string;service_date:string;priority:DutyView['priority'];state:DutyView['state'];required_at:string;due_at:string|null;owner_id:string|null;assigned_via:string|null;blocker:string|null;completed_at:string|null};
export async function loadDutyBoard():Promise<DutyBoard> {
  const {profile,db}=await actor();
  const cutoff=new Date(Date.now()-7*86400000).toISOString();
  const [result,machines,people,observations,accessible]=await Promise.all([
    db.from('smart_work_duties').select('id,machine_id,service_date,priority,state,required_at,due_at,owner_id,assigned_via,blocker,completed_at')
      .or(`completed_at.is.null,completed_at.gte.${cutoff}`).order('required_at').limit(1001),
    db.from('machines').select('id,name,machine_code').order('id').limit(1001),
    db.from('team_members').select('id,full_name').order('id').limit(1001),
    db.rpc('snacky_smart_duty_observations'),
    loadAccessibleOperatorIds(db,profile),
  ]);
  for(const value of [result,machines,people,observations]) {
    if(value.error || !Array.isArray(value.data) || value.data.length>1000) throw new DutyAccessError('The full duty board could not be verified. No partial list is shown.');
  }
  const names=new Map((machines.data??[]).map(m=>[String(m.id),String(m.name||m.machine_code||'Machine')]));
  const operatorNames=new Map((people.data??[]).map(p=>[String(p.id),String(p.full_name)]));
  const now=Date.now();
  const duties: DutyView[]=(result.data as DutyRow[]).map(d=>({
    id:d.id,machineId:d.machine_id,machineName:names.get(d.machine_id)||'Machine',serviceDate:d.service_date,
    priority:d.priority,state:d.state,requiredAt:d.required_at,dueAt:d.due_at,ownerName:d.owner_id?operatorNames.get(d.owner_id)||'Assigned operator':null,
    mine:Boolean(d.owner_id&&accessible.includes(d.owner_id)),assignedVia:d.assigned_via,blocker:d.blocker,completedAt:d.completed_at,
    overdue:d.state!=='completed'&&d.due_at!==null&&Date.parse(d.due_at)<now,
  }));
  const rank={immediate:0,urgent:1,today:2};
  duties.sort((a,b)=>Number(a.state==='completed')-Number(b.state==='completed')||Number(b.overdue)-Number(a.overdue)||rank[a.priority]-rank[b.priority]||a.requiredAt.localeCompare(b.requiredAt));
  const active=duties.filter(d=>d.state!=='completed');
  return {duties,checkedAt:new Date().toISOString(),dispatchEnabled:false,canConfigure:isOwnerAdminRole(profile),counts:{
    remaining:active.length,mine:active.filter(d=>d.mine).length,uncovered:active.filter(d=>!d.ownerName).length,
    overdue:active.filter(d=>d.overdue).length,completed:duties.length-active.length,
    uncertainMachines:(observations.data as {priority:string;unknown_lanes:number;unmapped_lanes?:number}[]).filter(o=>o.priority==='verify'||o.unknown_lanes>0||Number(o.unmapped_lanes)>0).length,
  }};
}
export async function refreshDutyBoard() {
  const {profile,db}=await actor();
  // No browser-supplied person, date, quantities, machine IDs, completion or owner changes.
  const result=await db.rpc('snacky_refresh_smart_work_duties',{p_actor:profile.team_member_id});
  if(result.error) {
    if(result.error.code==='42501') throw new DutyAccessError('Your account cannot refresh duties.',403);
    throw new DutyAccessError('Duties could not be refreshed. Previously saved duties remain unchanged.');
  }
  if(!result.data || result.data.dispatchEnabled!==false) throw new DutyAccessError('Refresh confirmation is missing. Reload to verify the saved duties.');
  return result.data as {created:number;changed:number;checkedAt:string;dispatchEnabled:false};
}
