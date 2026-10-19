import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { crmSameOrigin, uuidPattern } from '@/lib/crm-workspace';
export const dynamic = 'force-dynamic';
const json = (data:unknown,status=200) => NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export async function POST(request:Request) {
 if (!crmSameOrigin(request)) return json({ok:false,code:'denied',message:'Invalid origin.'},403);
 const profile = await getCurrentProfile();
 if (!profile || profile.active_status !== 'active' || !hasAnyRole(profile,['owner','admin','supervisor','crm'])) return json({ok:false,code:'denied'},403);
 let body:Record<string,unknown>;
 try {
  const raw = await request.text();
  if (raw.length>16000) return json({ok:false,code:'invalid'},413);
  const parsed:unknown = JSON.parse(raw);
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) return json({ok:false,code:'invalid'},400);
  body = parsed as Record<string,unknown>;
 } catch { return json({ok:false,code:'invalid'},400); }
 const action=String(body.action??''),issueId=String(body.issue_id??'');
 if(action!=='create'||!uuidPattern.test(issueId)) return json({ok:false,code:'invalid',message:'Only CRM field assignment is supported.'},400);
 const payload=body.payload&&typeof body.payload==='object'&&!Array.isArray(body.payload)?body.payload:{};
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return json({ok:false,code:'unavailable'},503);
 const {data,error}=await db.rpc('snacky_issue_field_queue_command_v1',{p_action:action,p_issue_id:issueId,p_task_id:null,p_payload:payload});
 if(error){
  const code=error.code==='42501'?'denied':['40001','23505','55P03','40P01'].includes(error.code)?'conflict':['22023','22P02','23514','23503','23502'].includes(error.code)?'invalid':'unavailable';
  return json({ok:false,code,message:error.message},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);
 }
 revalidatePath(`/issues/${issueId}`);
 revalidatePath('/issues');revalidatePath('/operator/issues');revalidatePath('/operator');revalidatePath('/my-work');
 return json(data);
}
