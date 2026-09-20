import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';

export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(code:string,status:number)=>NextResponse.json({ok:false,code},{status,headers});

export async function POST(request:Request){
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return fail('denied',403);
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor']))return fail('denied',403);
 let p:any;
 try{p=await request.json();}catch{return fail('invalid',400);}
 const amount=Number(p?.rent_amount),notice=Number(p?.notice_days);
 if(!uuid.test(String(p?.location_id??''))||!Number.isFinite(amount)||amount<0||!Number.isInteger(notice)||notice<0||notice>30
  ||!['fixed_rent','revenue_share','free_service','other'].includes(String(p?.agreement_type))
  ||!['once','monthly','quarterly','yearly'].includes(String(p?.frequency))
  ||typeof p?.recurring!=='boolean'
  ||(String(p?.next_due_date??'')!==''&&!/^\d{4}-\d{2}-\d{2}$/.test(String(p.next_due_date))))return fail('invalid',400);
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return fail('unavailable',503);
 const {data,error}=await db.rpc('snacky_location_payment_schedule_v1',{
  p_location_id:p.location_id,
  p_rent_amount:amount,
  p_agreement_type:p.agreement_type,
  p_frequency:p.frequency,
  p_next_due_date:p.next_due_date||null,
  p_recurring:p.recurring,
  p_notice_days:notice,
 });
 if(error){
  console.error('[location-payment-schedule] save failed',{code:error.code});
  if(error.code==='42501')return fail('denied',403);
  if(error.code?.startsWith('22')||error.code?.startsWith('23'))return fail('invalid',400);
  return fail('unavailable',503);
 }
 revalidatePath('/my-work','page');
 revalidatePath('/relationships','layout');
 return NextResponse.json({ok:true,data},{headers});
}
