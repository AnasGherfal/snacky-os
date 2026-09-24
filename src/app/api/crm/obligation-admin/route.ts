import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {uuidPattern} from '@/lib/crm-workspace';

export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
const month=/^\d{4}-(0[1-9]|1[0-2])$/;
const fail=(code:string,status:number,message?:string)=>NextResponse.json({ok:false,code,message},{status,headers});

export async function POST(request:Request){
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return fail('denied',403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin']))return fail('denied',403);
 let body:any;
 try{body=await request.json();}catch{return fail('invalid',400);}
 const obligationId=String(body?.obligation_id??''),assignedTo=String(body?.assigned_to??''),start=String(body?.period_start??''),end=String(body?.period_end??''),version=String(body?.version??'');
 if(!uuidPattern.test(obligationId)||!uuidPattern.test(assignedTo)||!month.test(start)||!month.test(end)||!/^\d{4}-\d{2}-\d{2}T/.test(version))return fail('invalid',400);
 if(end<start)return fail('invalid',400,'End month cannot be before start month.');
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return fail('unavailable',503);
 const {data,error}=await db.rpc('snacky_obligation_admin_update_v1',{
  p_obligation_id:obligationId,
  p_assigned_to:assignedTo,
  p_period_start_month:`${start}-01`,
  p_period_end_month:`${end}-01`,
  p_version:version,
 });
 if(error){
  console.error('[obligation-admin] save failed',{code:error.code,message:error.message});
  if(error.code==='42501')return fail('denied',403,error.message);
  if(error.code==='40001')return fail('stale',409,error.message);
  if(String(error.code).startsWith('22')||String(error.code).startsWith('23')||error.code==='P0001')return fail('invalid',409,error.message);
  return fail('unavailable',503);
 }
 for(const path of ['/my-work','/relationships','/relationships/obligations'])revalidatePath(path,'layout');
 return NextResponse.json({ok:true,data},{headers});
}
