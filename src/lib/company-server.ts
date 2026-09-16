import 'server-only';
import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole,isOwnerAdminRole} from '@/lib/authz';
import {companyHubEnabled,companyRoles} from '@/lib/company-hub';
export const companyHeaders={'Cache-Control':'private, no-store','Vary':'Cookie'};
export function companyJson(value:unknown,status=200){return NextResponse.json(value,{status,headers:companyHeaders});}
export async function companySession(){
 const profile=await getCurrentProfile();
 if(!companyHubEnabled||!profile||profile.active_status!=='active'||!hasAnyRole(profile,companyRoles))return null;
 const db=await getAuthenticatedSupabaseServerClient();
 return db?{profile,db,manager:isOwnerAdminRole(profile)}:null;
}
export function companyFailure(error:unknown){
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
 if(code==='42501')return companyJson({ok:false,message:'You do not have permission for this action.',retryable:false},403);
 if(code==='40001'||code==='23505')return companyJson({ok:false,message:'This record or request changed. Reload before editing again.',retryable:false},409);
 if(['22023','22P02','22008','23502','23514'].includes(code))return companyJson({ok:false,message:'Check the title, audience, active owner, review date and attachment. Publishing requires complete content.',retryable:false},400);
 console.error('[company-hub] Request not confirmed',{code:code||'unknown'});
 return companyJson({ok:false,message:'The save could not be confirmed. Retry the same request.',retryable:true},503);
}
