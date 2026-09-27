import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {readCompanyBody,CompanyRequestTooLarge} from '@/lib/company-request';
import {collaborationRoles,collaborationUuid,validateCollaborationCommand,validCollaborationReceipt,validateCollaborationWorkspace} from '@/lib/crm-collaboration';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'};
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
const fail=(code:string,status:number,retryable=false)=>json({ok:false,code,retryable},status);
async function client(){const p=await getCurrentProfile();if(!p||p.active_status!=='active'||!hasAnyRole(p,collaborationRoles))return null;return getAuthenticatedSupabaseServerClient();}
export async function GET(request:Request){
 try{
  const db=await client();if(!db)return fail('denied',403);
  const params=new URL(request.url).searchParams,kind=params.get('kind')??'notes',id=params.get('id'),filter=params.get('filter')??'open',offset=Number(params.get('offset')??0);
  if(!['notes','labels'].includes(kind)||(id&&!collaborationUuid.test(id))||!['open','done','all'].includes(filter)||!Number.isSafeInteger(offset)||offset<0||offset>100000||offset%10!==0)return fail('invalid',400);
  const {data,error}=await db.rpc('snacky_crm_collaboration_workspace_v1',{p_kind:kind,p_id:id,p_filter:filter,p_offset:offset}).abortSignal(AbortSignal.timeout(12000));
  if(error){console.error('[crm-collaboration] Read failed',{code:error.code});return fail(error.code==='42501'?'denied':'unavailable',error.code==='42501'?403:503);}
  return json({ok:true,data:validateCollaborationWorkspace(data)});
 }catch{return fail('unavailable',503);}
}
export async function POST(request:Request){
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return fail('denied',403);
 try{
  const db=await client();if(!db)return fail('denied',403);
  let command;try{command=validateCollaborationCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,24000))));}catch(error){return fail('invalid',error instanceof CompanyRequestTooLarge?413:400);}
  const {data,error}=await db.rpc('snacky_crm_collaboration_command_v1',{p_command:command}).abortSignal(AbortSignal.timeout(20000));
  if(error){
   console.error('[crm-collaboration] Command failed',{code:error.code});
   const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':/^(22|23)/.test(error.code)?'invalid':'uncertain';
   return fail(code,code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503,code==='uncertain');
  }
  if(!validCollaborationReceipt(command,data))return fail('uncertain',503,true);
  revalidatePath('/my-work','layout');revalidatePath('/admin/operations');revalidatePath('/locations-pipeline','layout');
  return json(data);
 }catch{return fail('uncertain',503,true);}
}
