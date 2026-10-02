import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';

export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

export async function POST(request:Request){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm']))return json({ok:false,code:'denied'},403);
 let body:any;
 try{body=await request.json();}catch{return json({ok:false,code:'invalid'},400);}
 const action=String(body?.action??''),issueId=body?.issue_id?String(body.issue_id):null,taskId=body?.task_id?String(body.task_id):null;
 if(action!=='create')return json({ok:false,code:'invalid',message:'Only CRM field assignment is supported.'},400);
 const payload=body?.payload&&typeof body.payload==='object'&&!Array.isArray(body.payload)?body.payload:{};
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return json({ok:false,code:'unavailable'},503);
 const {data,error}=await db.rpc('snacky_issue_field_queue_command_v1',{p_action:action,p_issue_id:issueId,p_task_id:taskId,p_payload:payload});
 if(error){
  const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':['22023','22P02','23514','23503','23502'].includes(error.code)?'invalid':'unavailable';
  return json({ok:false,code,message:error.message},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);
 }
 return json(data);
}
