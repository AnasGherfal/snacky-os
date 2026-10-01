import Link from 'next/link';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {CrmForm} from '@/components/CrmForm';
import {crmOptionRows,issueCategories} from '@/lib/crm-workspace';

/** Fast intake on My Work: only the four essentials, then continue from the saved issue. */
export async function CrmQuickIssueAction() {
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm']))return null;
 const {locale}=await getServerI18n(),ar=locale==='ar',tr=(en:string,arabic:string)=>ar?arabic:en;
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return null;
 const {data,error}=await db.rpc('snacky_crm_workspace_v1',{p_section:'issue',p_id:null,p_filters:{}});
 if(error||!data||typeof data!=='object'){
  console.error('[crm-quick-issue] Could not load issue intake options',error);
  return <section className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4" dir={ar?'rtl':'ltr'}>
   <p className="text-sm text-amber-900">{tr('Quick intake is unavailable right now.','التسجيل السريع غير متاح حالياً.')}</p>
   <Link href="/issues/new" className="btn-secondary mt-3">{tr('Open customer issue form','فتح نموذج بلاغ العميل')}</Link>
  </section>;
 }
 const context=data as {options?:{locations?:Array<{id:string;name:string}>}};
 const locations=Array.isArray(context.options?.locations)?context.options.locations:[];
 return <section data-crm-quick-issue dir={ar?'rtl':'ltr'} className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
  <div className="mb-4">
   <h2 className="font-semibold text-emerald-950">{tr('Quick customer issue','بلاغ عميل سريع')}</h2>
   <p className="mt-1 text-sm text-emerald-950">{tr('Only the essentials. Save it, then handle follow-up or send a machine visit from the issue record.','الأساسيات فقط. احفظ البلاغ، ثم تابع العميل أو أرسل زيارة للماكينة من سجل البلاغ.')}</p>
  </div>
  <CrmForm action="issue.save" userId={profile.id} hidden={{contact_channel:'whatsapp'}} fields={[
   {name:'customer_phone',label:tr('Customer phone / WhatsApp','هاتف / واتساب العميل'),type:'tel',required:true},
   {name:'location_id',label:tr('Location','الموقع'),type:'select',required:true,options:[{value:'',label:tr('Choose location','اختر الموقع')},...locations.map(x=>({value:String(x.id),label:String(x.name)}))]},
   {name:'issue_type',label:tr('Problem type','نوع المشكلة'),type:'select',value:'other',required:true,options:crmOptionRows(issueCategories,ar)},
   {name:'description',label:tr('What happened?','ماذا حدث؟'),type:'textarea',required:true},
  ]} submitLabel={tr('Save quick issue','حفظ البلاغ السريع')}/>
 </section>;
}
