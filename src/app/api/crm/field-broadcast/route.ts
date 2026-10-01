import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {CompanyRequestTooLarge,readCompanyBody} from '@/lib/company-request';
import {crmFieldBroadcastReceiptMatches,validateCrmFieldBroadcast} from '@/lib/crm-field-broadcast';
import {crmSameOrigin} from '@/lib/crm-workspace';

export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

export async function POST(request:Request){
 if(!crmSameOrigin(request))return json({ok:false,code:'denied',retryable:false},403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm']))return json({ok:false,code:'denied',retryable:false},403);
 let command;
 try{command=validateCrmFieldBroadcast(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,50000))));}
 catch(error){return json({ok:false,code:'invalid',retryable:false},error instanceof CompanyRequestTooLarge?413:400);}
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return json({ok:false,code:'unavailable',retryable:true},503);
 const {data,error}=await db.rpc('snacky_issue_field_broadcast_v1',{p_request:command});
 if(error){
  const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':['22023','22P02','23514','23503','23502'].includes(error.code)?'invalid':'uncertain';
  return json({ok:false,code,retryable:code==='uncertain',message:error.message},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);
 }
 if(!crmFieldBroadcastReceiptMatches(command,data))return json({ok:false,code:'uncertain',retryable:true},503);
 for(const path of ['/my-work','/issues','/follow-ups'])revalidatePath(path,'layout');
 return json(data);
}
