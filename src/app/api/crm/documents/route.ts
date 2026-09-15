import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { crmKinds, crmSameOrigin, uuidPattern } from '@/lib/crm-workspace';
export const runtime='nodejs';
const LIMIT=10_000_000;
export async function POST(request:Request){
 if(!crmSameOrigin(request))return NextResponse.json({ok:false,message:'Invalid origin.'},{status:403});
 if(Number(request.headers.get('content-length')??0)>LIMIT+100000)return NextResponse.json({ok:false,message:'Use a file smaller than 10 MB.'},{status:413});
 const profile=await getCurrentProfile(),db=await getAuthenticatedSupabaseServerClient();
 if(!profile||profile.active_status!=='active'||!db)return NextResponse.json({ok:false,message:'Sign in again.'},{status:403});
 try{
  const fd=await request.formData(),file=fd.get('file'),kind=String(fd.get('kind')??''),id=String(fd.get('record_id')??''),command=String(fd.get('command_id')??'');
  if(!(file instanceof File)||file.size<=0||file.size>LIMIT||!crmKinds.includes(kind as never)||!uuidPattern.test(id)||!uuidPattern.test(command))return NextResponse.json({ok:false,message:'Choose a valid image or PDF under 10 MB.'},{status:400});
  const access=await db.rpc('snacky_crm_allowed',{p_kind:kind,p_id:id,p_write:true});
  if(access.error||access.data!==true)return NextResponse.json({ok:false,message:'You cannot attach files to this record.'},{status:403});
  const bytes=Buffer.from(await file.arrayBuffer());
  const mime=bytes.subarray(0,5).toString()==='%PDF-'?'application/pdf':bytes[0]===0xff&&bytes[1]===0xd8?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mime)return NextResponse.json({ok:false,message:'Only JPEG, PNG, WebP and PDF files are supported.'},{status:400});
  const digest=createHash('sha256').update(bytes).digest('hex');
  const objectPath=`${profile.id}/${kind}/${id}/${command}/${digest}`;
  const upload=await db.storage.from('crm-documents').upload(objectPath,bytes,{contentType:mime,upsert:false});
  if(upload.error&&!/already exists|duplicate/i.test(upload.error.message))throw upload.error;
  const registered=await db.rpc('snacky_crm_command_v1',{p_command_id:command,p_action:'document.register',p_id:id,p_payload:{kind,object_path:objectPath,original_name:file.name.slice(0,200),mime_type:mime}});
  if(registered.error)throw registered.error;
  revalidatePath('/my-work','layout');revalidatePath('/issues','layout');revalidatePath('/locations-pipeline','layout');revalidatePath('/relationships','layout');revalidatePath('/follow-ups','layout');
  return NextResponse.json({ok:true,message:'Private document attached.'});
 }catch(error){console.error('[crm-documents] Upload not confirmed',error);return NextResponse.json({ok:false,message:'The attachment could not be confirmed. Keep this file selected and retry the same upload.'},{status:503});}
}
