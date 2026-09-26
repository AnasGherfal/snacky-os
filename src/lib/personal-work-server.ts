import 'server-only';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {personalWorkRoles,type PersonalReader} from '@/lib/personal-work';
export async function personalWorkContext():Promise<{authorized:false}|{authorized:true;name:string;read:PersonalReader}>{
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,personalWorkRoles))return {authorized:false};
 const db=await getAuthenticatedSupabaseServerClient();
 const read:PersonalReader=async(section,view,offset,signal)=>{
  if(!db)throw Error('Session unavailable');
  // Identity comes from the authenticated session, never a requested employee ID.
  const result=await db.rpc('snacky_personal_work_section_v1',{p_section:section,p_view:view,p_offset:offset}).abortSignal(signal);
  if(result.error)throw Error('Personal work unavailable');
  return result.data;
 };
 return {authorized:true,name:profile.full_name,read};
}
