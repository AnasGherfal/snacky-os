import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {getSupabaseAdminClient} from '@/lib/supabase-server';
import {hasAnyRole} from '@/lib/authz';
import {readCompanyBody,CompanyRequestTooLarge} from '@/lib/company-request';
import {buyingSameOrigin} from '@/lib/buying-lists';
import {buyingPurchaseRoles,validateBuyingReceiptCommand,buyingReceiptResultMatches,receiptFileExtension,receiptFileMatches,type BuyingReceiptCommand} from '@/lib/buying-purchase';
export const dynamic='force-dynamic';
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
const failure=(code:string,status:number,retryable=false)=>json({ok:false,code,retryable},status);
export async function POST(request:Request){
 if(!buyingSameOrigin(request))return failure('denied',403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,buyingPurchaseRoles))return failure('denied',403);
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return failure('unavailable',503,true);
 let fd:FormData;let command:BuyingReceiptCommand;
 try{
  const bytes=await readCompanyBody(request,6*1024*1024);
  fd=await new Request(request.url,{method:'POST',headers:{'Content-Type':request.headers.get('content-type')??''},body:bytes}).formData();
  command=validateBuyingReceiptCommand(JSON.parse(String(fd.get('command')??'')));
 }catch(error){return failure('invalid',error instanceof CompanyRequestTooLarge?413:400);}
 // Always use authenticated scope checks before any privileged Storage operation.
 const scope=await db.rpc('snacky_buying_purchase_workspace_v1',{p_list:command.list_id});
 if(scope.error||!scope.data)return failure(scope.error?.code==='42501'?'denied':'unavailable',scope.error?.code==='42501'?403:503,true);
 if(scope.data.can_record!==true)return failure('denied',403);
 let payload=command.payload;
 if(command.action==='create'){
  const mime=String(payload.receipt_mime),digest=String(payload.receipt_sha256),extension=receiptFileExtension(mime);
  if(!extension)return failure('invalid',400);
  const path=`buying/${profile.id}/${command.list_id}/${digest}.${extension}`;
  const file=fd.get('receipt_file');
  if(file instanceof File&&file.size>0){
   if(file.size>5*1024*1024||file.type!==mime)return failure('invalid',400);
   const bytes=new Uint8Array(await file.arrayBuffer());
   if(!receiptFileMatches(bytes,mime)||createHash('sha256').update(bytes).digest('hex')!==digest)return failure('invalid',400);
   const storage=getSupabaseAdminClient();if(!storage)return failure('unavailable',503,true);
   // Content-addressed path; never upsert/overwrite already linked receipt evidence.
   const uploaded=await storage.storage.from('receipt-images').upload(path,bytes,{contentType:mime,upsert:false,cacheControl:'31536000'});
   if(uploaded.error){
    const existing=await storage.storage.from('receipt-images').download(path);
    if(existing.error||!existing.data)return failure('unavailable',503,true);
    const existingBytes=new Uint8Array(await existing.data.arrayBuffer());
    if(createHash('sha256').update(existingBytes).digest('hex')!==digest)return failure('conflict',409);
   }
  }
  // An uncertain response can be retried after refresh without uploading again.
  // The database verifies that this exact user's content-addressed object exists.
  payload={...payload,receipt_path:path};
 }
 const dbCommand={...command,payload};
 try{
  const {data,error}=await db.rpc('snacky_buying_purchase_command_v1',{p_command:dbCommand});
  if(error){
   const code=error.code==='42501'?'denied':['40001','23505'].includes(error.code)?'conflict':['22023','22P02','22003','22007','22008','23514','23503','23502'].includes(error.code)?'invalid':'uncertain';
   return failure(code,code==='denied'?403:code==='conflict'?409:code==='invalid'?400:503,code==='uncertain');
  }
  if(!buyingReceiptResultMatches(command,data))return failure('uncertain',503,true);
  return json(data);
 }catch{return failure('uncertain',503,true);}
}
