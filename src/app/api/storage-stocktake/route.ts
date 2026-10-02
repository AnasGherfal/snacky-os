import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {canAccessPath} from '@/lib/authz';
import {CompanyRequestTooLarge,readCompanyBody} from '@/lib/company-request';
import {stocktakeReceiptMatches,stocktakeSameOrigin,stocktakeUuid,validateStocktakeCommand} from '@/lib/storage-stocktake';

export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

async function client(){
 const profile=await getCurrentProfile();
 const context=profile?{id:profile.id,role:profile.role,roles:profile.roles,canAddProducts:profile.can_add_products,teamMemberId:profile.team_member_id,activeStatus:profile.active_status}:null;
 if(!profile||profile.active_status!=='active'||!canAccessPath(context,'/inventory/stocktake'))return null;
 return getAuthenticatedSupabaseServerClient();
}

export async function GET(request:Request){
 const db=await client();if(!db)return json({ok:false,code:'denied'},403);
 const url=new URL(request.url),id=url.searchParams.get('id');
 if(id&&!stocktakeUuid.test(id))return json({ok:false,code:'invalid'},400);
 const filters:Record<string,string>={};for(const key of ['status','offset']){const value=url.searchParams.get(key);if(value)filters[key]=value;}
 const {data,error}=await db.rpc('snacky_storage_stocktake_workspace_v1',{p_id:id,p_filters:filters});
 if(error)return json({ok:false,code:error.code==='42501'?'denied':'unavailable'},error.code==='42501'?403:503);
 return json({ok:true,data});
}

export async function POST(request:Request){
 if(!stocktakeSameOrigin(request))return json({ok:false,code:'denied',retryable:false},403);
 const db=await client();if(!db)return json({ok:false,code:'denied',retryable:false},403);
 let command;
 try{command=validateStocktakeCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request,100000))));}
 catch(error){return json({ok:false,code:'invalid',retryable:false},error instanceof CompanyRequestTooLarge?413:400);}
 const {data,error}=await db.rpc('snacky_storage_stocktake_command_v1',{p_command:command});
 if(error){
  const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':['22023','22P02','22008','23514','23503','23502'].includes(error.code)?'invalid':'uncertain';
  return json({ok:false,code,retryable:code==='uncertain'},code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503);
 }
 if(!stocktakeReceiptMatches(command,data))return json({ok:false,code:'uncertain',retryable:true},503);
 return json(data);
}
