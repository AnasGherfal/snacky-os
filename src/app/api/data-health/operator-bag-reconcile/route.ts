import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';

export const dynamic='force-dynamic';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

export async function POST(request:Request){
 const origin=request.headers.get('origin');
 if(origin){try{if(new URL(origin).origin!==new URL(request.url).origin)return json({ok:false,code:'denied'},403);}catch{return json({ok:false,code:'denied'},403);}}
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin']))return json({ok:false,code:'denied'},403);
 let body:any;try{body=await request.json();}catch{return json({ok:false,code:'invalid'},400);}
 const requestId=String(body?.request_id??''),caseId=String(body?.case_id??''),countedQty=Number(body?.counted_qty),reason=String(body?.reason??'').trim();
 if(!uuid.test(requestId)||!uuid.test(caseId)||!Number.isInteger(countedQty)||countedQty<0||countedQty>100000||reason.length<3||reason.length>1000)return json({ok:false,code:'invalid'},400);
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return json({ok:false,code:'unavailable'},503);
 const {data,error}=await db.rpc('snacky_data_health_operator_bag_reconcile_v1',{p_request_id:requestId,p_case_id:caseId,p_counted_qty:countedQty,p_reason:reason});
 if(error){
  const code=error.code==='42501'?'denied':error.code==='23505'?'conflict':['22023','23514','P0002'].includes(error.code)?'invalid':'unavailable';
  return json({ok:false,code,message:error.message},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);
 }
 return json(data);
}
