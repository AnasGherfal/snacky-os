import {NextResponse} from 'next/server';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {buyingRoles,buyingSameOrigin,validateBuyingCommand,buyingReceiptMatches,buyingUuid} from '@/lib/buying-lists';
import {readCompanyBody,CompanyRequestTooLarge} from '@/lib/company-request';
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export const dynamic='force-dynamic';
async function client(){const p=await getCurrentProfile();if(!p||p.active_status!=='active'||!hasAnyRole(p,buyingRoles))return null;return getAuthenticatedSupabaseServerClient();}
export async function GET(request:Request){
 const db=await client();if(!db)return json({ok:false,code:'denied'},403);
 const url=new URL(request.url),id=url.searchParams.get('id');if(id&&!buyingUuid.test(id))return json({ok:false,code:'invalid'},400);
 const filters:Record<string,string>={};for(const k of ['scope','status','offset']){const v=url.searchParams.get(k);if(v)filters[k]=v;}
 const {data,error}=await db.rpc('snacky_buying_workspace_v1',{p_id:id,p_filters:filters});
 if(error)return json({ok:false,code:error.code==='42501'?'denied':'unavailable'},error.code==='42501'?403:503);
 return json({ok:true,data});
}
export async function POST(request:Request){
 if(!buyingSameOrigin(request))return json({ok:false,code:'denied',retryable:false},403);
 const db=await client();if(!db)return json({ok:false,code:'denied',retryable:false},403);
 let c;try{c=validateBuyingCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,100000))));}
 catch(e){return json({ok:false,code:'invalid',retryable:false},e instanceof CompanyRequestTooLarge?413:400);}
 const {data,error}=c.action==='source'
  ?await db.rpc('snacky_buying_source_save_v1',{p_command:{request_id:c.request_id,list_id:c.list_id,revision:c.revision,...c.payload}})
  :await db.rpc('snacky_buying_command_v1',{p_command:c});
 if(error){const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':['22023','22P02','22008','23514','23502'].includes(error.code)?'invalid':'uncertain';return json({ok:false,code,retryable:code==='uncertain'},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);}
 const response={...data,ok:true};if(!buyingReceiptMatches(c,response))return json({ok:false,code:'uncertain',retryable:true},503);
 return json(response);
}
