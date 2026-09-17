import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {readCompanyBody} from '@/lib/company-request';
import {crmRecurringEnabled,validateRoutineCommand} from '@/lib/crm-recurring';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
const failure=(code:string,status:number,retryable=false)=>NextResponse.json({ok:false,code,retryable},{status,headers});
export async function POST(request:Request){
 if(!crmRecurringEnabled)return failure('unavailable',503);
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return failure('denied',403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor']))return failure('denied',403);
 let command;
 try{command=validateRoutineCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,30000))));}
 catch{return failure('invalid',400);}
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return failure('uncertain',503,true);
 try{
  const {data,error}=await db.rpc('snacky_crm_routine_command_v1',{p_request_id:command.request_id,p_action:command.action,p_id:command.id,p_revision:command.revision,p_payload:command.payload??{}});
  if(error){
   console.error('[crm-routines] Save failed',{code:error.code});
   if(error.code==='42501')return failure('denied',403);
   if(error.code==='40001'||error.code==='23505')return failure('conflict',409);
   if(/^(22|23)/.test(error.code))return failure('invalid',400);
   return failure('uncertain',503,true);
  }
  if(data?.id!==command.id||data?.request_id!==command.request_id)return failure('uncertain',503,true);
  revalidatePath('/my-work/team','layout');return NextResponse.json({ok:true,...data},{headers});
 }catch{return failure('uncertain',503,true);}
}
