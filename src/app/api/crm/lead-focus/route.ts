import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {readCompanyBody,CompanyRequestTooLarge} from '@/lib/company-request';
import {leadFocusEnabled,validateLeadFocusCommand,confirmedFocusReceipt} from '@/lib/crm-lead-focus';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
const fail=(code:string,status:number,retryable=false)=>NextResponse.json({ok:false,code,retryable},{status,headers});
export async function POST(request:Request){
 if(!leadFocusEnabled)return fail('unavailable',503);
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return fail('denied',403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor']))return fail('denied',403);
 let command;
 try{command=validateLeadFocusCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,24000))));}
 catch(error){return fail('invalid',error instanceof CompanyRequestTooLarge?413:400);}
 try{
  const db=await getAuthenticatedSupabaseServerClient();if(!db)return fail('uncertain',503,true);
  const {data,error}=await db.rpc('snacky_crm_lead_focus_command_v1',{p_request_id:command.request_id,p_action:command.action,p_items:command.items,p_assigned_to:command.assigned_to,p_until:command.until,p_next_action:command.next_action});
  if(error){
   if(error.code==='42501')return fail('denied',403);
   if(['40001','23505'].includes(error.code))return fail('conflict',409);
   if(['PGRST202','42883'].includes(error.code))return fail('unavailable',503);
   if(/^(22|23)/.test(error.code))return fail('invalid',400);
   console.error('[lead-focus] Unconfirmed save',{code:error.code});return fail('uncertain',503,true);
  }
  const reply={...data,ok:true};if(!confirmedFocusReceipt(command,reply))return fail('uncertain',503,true);
  revalidatePath('/locations-pipeline','layout');revalidatePath('/my-work','layout');
  return NextResponse.json(reply,{headers});
 }catch{return fail('uncertain',503,true);}
}
