import {createHash} from 'node:crypto';
import {companySameOrigin,companyUuid,companyFileLimit} from '@/lib/company-hub';
import {companySession,companyJson,companyFailure} from '@/lib/company-server';
export const runtime='nodejs';
function mime(bytes:Buffer,name:string){
 if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
 if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 if(name.toLowerCase().endsWith('.svg')&&/<svg[\s>]/i.test(bytes.subarray(0,4096).toString()))return 'image/svg+xml';
 if(bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===3&&bytes[3]===4){
  const ext=name.toLowerCase().split('.').pop();
  return ext==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':ext==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':ext==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':null;
 }
 return null;
}
export async function POST(request:Request){
 if(!companySameOrigin(request))return companyJson({ok:false,message:'Invalid request origin.'},403);
 const session=await companySession();if(!session?.manager)return companyJson({ok:false,message:'Management permission required.'},403);
 if(Number(request.headers.get('content-length')??0)>companyFileLimit+100000)return companyJson({ok:false,message:'Use a file under 4 MB, or link a larger Drive master.'},413);
 try{
  const form=await request.formData(),file=form.get('file'),id=String(form.get('id')??'');
  if(!(file instanceof File)||file.size<1||file.size>companyFileLimit||!companyUuid.test(id))return companyJson({ok:false,message:'Choose a supported file under 4 MB.'},400);
  const bytes=Buffer.from(await file.arrayBuffer()),type=mime(bytes,file.name);
  if(!type)return companyJson({ok:false,message:'Use PDF, PNG, JPEG, WebP, SVG, DOCX, PPTX or XLSX. HTML and executable files are not supported.'},400);
  const digest=createHash('sha256').update(bytes).digest('hex'),path=`${session.profile.id}/${id}/${digest}`;
  const upload=await session.db.storage.from('company-documents').upload(path,bytes,{contentType:type,upsert:false});
  if(upload.error&&!/already exists|duplicate/i.test(upload.error.message))throw upload.error;
  const {data,error}=await session.db.rpc('snacky_company_command_v1',{p_request:id,p_action:'file.register',p_id:id,p_revision:0,p_version:null,p_payload:{object_path:path,digest,original_name:file.name.slice(0,200),mime_type:type,size_bytes:file.size}});
  if(error)throw error;if(data?.id!==id)throw new Error('Unconfirmed file');
  return companyJson({ok:true,id,name:file.name});
 }catch(error){return companyFailure(error);}
}
