"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";
const clean=(fd:FormData,key:string)=>String(fd.get(key)??'').trim();
const validDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;

export async function updateInvestorAgreement(fd:FormData) {
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!isOwnerAdminRole(profile))redirect('/unauthorized');
 const id=clean(fd,'agreement_id'),db=await getAuthenticatedSupabaseServerClient();
 const fail=(message:string):never=>redirect(`/finance/investors?agreement=${encodeURIComponent(id)}&error=${encodeURIComponent(message)}`);
 if(!db||!id)fail('Missing investor agreement or database session.');
 const {data:before,error:loadError}=await db.from('investor_agreements').select('*').eq('id',id).maybeSingle();
 if(loadError||!before)fail('Could not verify the investor agreement.');
 const name=clean(fd,'investor_name'),start=clean(fd,'start_date'),end=clean(fd,'end_date')||null,basis=clean(fd,'profit_basis'),status=clean(fd,'status');
 const share=Number(clean(fd,'profit_share_percent')),capital=Number(clean(fd,'investment_amount_lyd')),cap=clean(fd,'payout_cap_lyd')?Number(clean(fd,'payout_cap_lyd')):null;
 if(!name||!validDate(start)||!start.endsWith('-01')||(end&&(!validDate(end)||end<start))||!['operating_profit','operating_profit_after_capex'].includes(basis)||!['draft','active','completed','cancelled'].includes(status)||!Number.isFinite(share)||share<=0||share>100||!Number.isFinite(capital)||capital<0||(cap!==null&&(!Number.isFinite(cap)||cap<0)))fail('Check the dates, positive share percentage, capital amount and agreed profit basis.');
 const {data:after,error}=await db.from('investor_agreements').update({investor_name:name,investment_amount_lyd:capital,profit_share_percent:share,start_date:start,end_date:end,profit_basis:basis,profit_basis_confirmed:true,payout_cap_lyd:cap,status,notes:clean(fd,'notes')||null,updated_at:new Date().toISOString()}).eq('id',id).select('*').single();
 if(error||!after)fail(error?.message??'Agreement update could not be confirmed.');
 await logActivity({profile,action:'update_investor_agreement',entityType:'investor_agreement',entityId:id,entityLabel:name,beforeData:before,afterData:after,summary:'Updated investor agreement terms; no capital receipt or payout was posted'});
 revalidatePath('/finance/investors');revalidatePath('/investor');
 redirect(`/finance/investors?agreement=${id}&success=${encodeURIComponent('Agreement saved. Capital receipts and payouts remain separate money records.')}`);
}
