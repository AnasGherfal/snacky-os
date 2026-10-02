import { NextResponse } from 'next/server';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { uuidPattern } from '@/lib/crm-workspace';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 if(!uuidPattern.test(id))return new NextResponse('Not found',{status:404});
 const profile=await getCurrentProfile(),db=await getAuthenticatedSupabaseServerClient();
 if(!profile||profile.active_status!=='active'||!db)return new NextResponse('Sign in required',{status:403});
 const {data,error}=await db.from('crm_documents').select('id,object_path,original_name').eq('id',id).maybeSingle();
 if(error||!data)return new NextResponse('Document unavailable',{status:404});
 const signed=await db.storage.from('crm-documents').createSignedUrl(data.object_path,60,{download:data.original_name});
 if(signed.error||!signed.data?.signedUrl)return new NextResponse('Document temporarily unavailable',{status:503});
 const response=NextResponse.redirect(signed.data.signedUrl);
 response.headers.set('Cache-Control','private, no-store');
 response.headers.set('Referrer-Policy','no-referrer');
 return response;
}
