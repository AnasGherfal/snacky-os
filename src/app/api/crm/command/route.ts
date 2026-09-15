import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { crmHref, crmPayload, crmSameOrigin, uuidPattern } from '@/lib/crm-workspace';

export const runtime='nodejs';
export async function POST(request:Request){
 if(!crmSameOrigin(request))return NextResponse.json({ok:false,message:'Invalid request origin.'},{status:403});
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm','operator']))return NextResponse.json({ok:false,message:'Active staff login required.'},{status:403});
 let command:{id:string;action:string;recordId?:string|null;values:Record<string,string>};
 try{
  const text=await request.text();if(text.length>30000)throw new Error('Record is too large.');
  command=JSON.parse(text);
  if(!command||!uuidPattern.test(command.id)||typeof command.action!=='string'||command.action.length>60||!command.values||Array.isArray(command.values)||Object.values(command.values).some(v=>typeof v!=='string')||(command.recordId&&!uuidPattern.test(command.recordId)))throw new Error('Invalid record or request identity.');
 }catch{return NextResponse.json({ok:false,message:'Invalid record data.',resetAllowed:true},{status:400});}
 let payload:Record<string,unknown>;
 try{payload=crmPayload(command.values);}catch(error){return NextResponse.json({ok:false,message:error instanceof Error?error.message:'Invalid record data.',resetAllowed:true},{status:400});}
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return NextResponse.json({ok:false,message:'Session unavailable. Keep the saved request and sign in again.'},{status:503});
 try{
  const {data,error}=await db.rpc('snacky_crm_command_v1',{p_command_id:command.id,p_action:command.action,p_id:command.recordId||null,p_payload:payload});
  if(error){
   console.error('[crm] Command failed',{action:command.action,code:error.code,message:error.message});
   const receiptConflict=String(error.code)==='23505'&&error.message.includes('Saved request does not match');
   const knownRollback=!receiptConflict&&(/^(22|23)/.test(String(error.code))||['P0001','42501','40001'].includes(String(error.code)));
   return NextResponse.json({ok:false,message:knownRollback?error.message:'Could not confirm the result. Retry the same saved request.',resetAllowed:knownRollback,refreshRequired:String(error.code)==='40001'},{status:knownRollback?409:503});
  }
  if(!data||typeof data!=='object'||!uuidPattern.test(String(data.id??'')))return NextResponse.json({ok:false,message:'Unexpected result. Retry the same saved request before adding another record.'},{status:503});
  for(const path of ['/my-work','/locations-pipeline','/issues','/relationships','/contacts','/follow-ups','/operator/issues'])revalidatePath(path,'layout');
  return NextResponse.json({ok:true,commandId:command.id,id:data.id,kind:data.kind,href:crmHref(data.kind,data.id),message:'Saved in Snacky OS.'});
 }catch(error){
  // Unknown failures may happen after a committed write. Never mint another ID.
  console.error('[crm] Command result uncertain',error);
  return NextResponse.json({ok:false,message:'Could not confirm the result. Retry this same saved request.'},{status:503});
 }
}
