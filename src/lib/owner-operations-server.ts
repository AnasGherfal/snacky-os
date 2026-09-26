import 'server-only';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {isOwnerAdminRole} from '@/lib/authz';
import type {OperationReader} from '@/lib/owner-operations';

export async function ownerOperationsContext():Promise<{authorized:false}|{authorized:true;read:OperationReader}>{
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!isOwnerAdminRole(profile))return {authorized:false};
 // Use this owner's authenticated client, never the service-role client.
 const db=await getAuthenticatedSupabaseServerClient();
 const read:OperationReader=async(section,offset,signal)=>{
  if(!db)throw Error('Session unavailable');
  const result=await db.rpc('snacky_owner_operations_section_v1',{p_section:section,p_offset:offset}).abortSignal(signal);
  if(result.error)throw Error('Overview read unavailable');
  return result.data;
 };
 return {authorized:true,read};
}
