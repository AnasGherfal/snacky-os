import type {BuyingSources} from '@/lib/buying-sources';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {redirect} from 'next/navigation';
import {buyingRoles,type BuyingWorkspace} from '@/lib/buying-lists';
export async function buyingWorkspace(id:string|null=null,filters:Record<string,string>={}) {
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,buyingRoles))redirect('/unauthorized');
 const db=await getAuthenticatedSupabaseServerClient();if(!db)throw Error('unavailable');
 const {data,error}=await db.rpc('snacky_buying_workspace_v1',{p_id:id,p_filters:filters});
 if(error||!data||!Array.isArray(data.rows)||!Array.isArray(data.people))throw Error(error?.code==='42501'?'denied':'unavailable');
 let sources:BuyingSources|null=null;
 let sourcesStatus:'available'|'not_installed'|'unavailable'='available';
 if(id){
  const result=await db.rpc('snacky_buying_sources_v1',{p_id:id});
  if(result.error){sourcesStatus=result.error.code==='PGRST202'?'not_installed':'unavailable';}
  else if(!result.data||result.data.list_id!==id||result.data.revision!==data.record?.revision||!Array.isArray(result.data.sources)||!Array.isArray(result.data.stores)||!Array.isArray(result.data.options))sourcesStatus='unavailable';
  else sources=result.data as BuyingSources;
 }
 return {profile,data:data as BuyingWorkspace,sources,sourcesStatus};
}
