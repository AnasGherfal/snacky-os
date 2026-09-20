import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {redirect} from 'next/navigation';
import {buyingRoles,type BuyingWorkspace} from '@/lib/buying-lists';
export async function buyingWorkspace(id:string|null=null,filters:Record<string,string>={}) {
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,buyingRoles))redirect('/unauthorized');
 const db=await getAuthenticatedSupabaseServerClient();if(!db)throw Error('unavailable');
 const {data,error}=await db.rpc('snacky_buying_workspace_v1',{p_id:id,p_filters:filters});
 if(error||!data||!Array.isArray(data.rows)||!Array.isArray(data.people))throw Error(error?.code==='42501'?'denied':'unavailable');
 return {profile,data:data as BuyingWorkspace};
}
