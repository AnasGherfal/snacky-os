import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {CompanyRequestTooLarge,readCompanyBody} from '@/lib/company-request';
import {crmDispatchReceiptMatches,crmDispatchSameOrigin,validateCrmDispatchCommand} from '@/lib/crm-dispatch';

export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

export async function POST(request:Request){
 if(!crmDispatchSameOrigin(request))return json({ok:false,code:'denied',retryable:false},403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm','operator']))return json({ok:false,code:'denied',retryable:false},403);
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return json({ok:false,code:'unavailable',retryable:true},503);
 let command;
 try{command=validateCrmDispatchCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,50000))));}
 catch(error){return json({ok:false,code:'invalid',retryable:false},error instanceof CompanyRequestTooLarge?413:400);}
 const {data,error}=await db.rpc('snacky_issue_dispatch_command_v1',{p_command:command});
 if(error){
  const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':['22023','22P02','23514','23503','23502'].includes(error.code)?'invalid':'uncertain';
  return json({ok:false,code,retryable:code==='uncertain'},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);
 }
 if(!crmDispatchReceiptMatches(command,data))return json({ok:false,code:'uncertain',retryable:true},503);
 return json(data);
}
