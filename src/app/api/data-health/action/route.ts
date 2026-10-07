import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';

export const dynamic='force-dynamic';
const actions=new Set(['scan_negative_inventory','cancel_stale_refill','archive_vms_batch','classify_legacy_cash','unclassify_legacy_cash','resolve_inventory_case','bulk_cancel_stale_refills','bulk_archive_vms_batches']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

export async function POST(request:Request){
 const origin=request.headers.get('origin');
 if(origin){try{if(new URL(origin).origin!==new URL(request.url).origin)return json({ok:false,code:'denied'},403);}catch{return json({ok:false,code:'denied'},403);}}
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin']))return json({ok:false,code:'denied'},403);
 let body:any;
 try{body=await request.json();}catch{return json({ok:false,code:'invalid'},400);}
 const action=String(body?.action??''),targetId=body?.target_id?String(body.target_id):null,reason=body?.reason===null||body?.reason===undefined?null:String(body.reason).trim();
 if(!actions.has(action)||(targetId&&!uuid.test(targetId))||(reason&&reason.length>1000))return json({ok:false,code:'invalid'},400);
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return json({ok:false,code:'unavailable'},503);
 const {data,error}=await db.rpc('snacky_data_health_command_v1',{p_action:action,p_target_id:targetId,p_reason:reason});
 if(error){
  const code=error.code==='42501'?'denied':['22023','22P02','23514','P0002'].includes(error.code)?'invalid':'unavailable';
  return json({ok:false,code,message:error.message},code==='denied'?403:code==='invalid'?400:503);
 }
 return json(data);
}
