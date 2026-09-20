/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import {redirect} from 'next/navigation';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {crmHref,crmStatus} from '@/lib/crm-workspace';

function money(value:unknown){
 const n=Number(value);
 return Number.isFinite(n)&&n>0?`${n.toLocaleString('en-US',{maximumFractionDigits:2})} LYD`:'—';
}
function frequency(value:string|undefined,ar:boolean){
 const rows:Record<string,[string,string]>={
  once:['Once','مرة واحدة'],monthly:['Monthly','شهري'],quarterly:['Quarterly','ربع سنوي'],yearly:['Yearly','سنوي']
 };
 return rows[value??'']?.[ar?1:0]??(ar?'غير محدد':'Not set');
}

export async function CrmRelationshipOverview(){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active')redirect('/login');
 if(!hasAnyRole(profile,['owner','admin','supervisor','crm']))return null;
 const {locale}=await getServerI18n();
 const ar=locale==='ar',tr=(en:string,arabic:string)=>ar?arabic:en;
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return null;
 const [locationResult,paymentResult]=await Promise.all([
  db.rpc('snacky_crm_workspace_v1',{p_section:'location',p_id:null,p_filters:{scope:'mine'}}),
  db.rpc('snacky_crm_workspace_v1',{p_section:'obligation',p_id:null,p_filters:{scope:'mine',window:'all'}}),
 ]);
 if(locationResult.error||paymentResult.error)return (
  <section className="surface-card" dir={ar?'rtl':'ltr'}>
   <h2 className="font-semibold">{tr('Existing locations','المواقع الحالية')}</h2>
   <p className="mt-2 text-sm text-amber-900">{tr('Could not load relationship or payment information. Report the Snacky OS issue and try again.','تعذر تحميل معلومات العلاقات أو الدفعات. بلّغي عن مشكلة Snacky OS ثم حاولي مرة أخرى.')}</p>
  </section>
 );
 const locations=(locationResult.data?.rows??[]) as any[];
 const payments=((paymentResult.data?.rows??[]) as any[])
  .filter(row=>row.status==='open'||(row.status==='paid'&&!row.data?.finance_verified_at))
  .sort((a,b)=>String(a.due_date??'9999').localeCompare(String(b.due_date??'9999')));
 const today=String(locationResult.data?.today??'');
 return <div className="space-y-5" dir={ar?'rtl':'ltr'}>
  <section className="surface-card">
   <div className="flex flex-wrap items-start justify-between gap-3">
    <div>
     <h2 className="text-lg font-semibold">{tr('Your current Snacky locations','مواقع سناكي الحالية المسؤولة عنها')}</h2>
     <p className="mt-1 text-sm text-slate-600">{tr('These relationships are part of your work even when no visit is due today. Open a location to see its contacts, history, machines, rent terms and next follow-up.','هذه العلاقات جزء من عملك حتى لو لم تكن هناك زيارة مستحقة اليوم. افتحي الموقع لرؤية جهات الاتصال والسجل والماكينات وشروط الإيجار والمتابعة القادمة.')}</p>
    </div>
    <span className="rounded-full border px-3 py-1 text-sm font-semibold">{locations.length}</span>
   </div>
   <div className="mt-4 grid gap-3 lg:grid-cols-2">
    {locations.map(row=>{
     const d=row.data??{},rel=d.relationship??{},fixed=rel.agreement_type==='fixed_rent';
     return <article className="rounded-xl border border-slate-200 bg-white p-4" key={row.id}>
      <div className="flex items-start justify-between gap-3">
       <div>
        <Link className="font-semibold text-sky-900 underline" href={crmHref('location',row.id)}>{row.title}</Link>
        <p className="mt-1 text-sm text-slate-600">{d.address||tr('Address not recorded','العنوان غير مسجّل')}</p>
       </div>
       <span className="rounded-full bg-slate-50 px-2.5 py-1 text-xs font-semibold">{crmStatus(row.status,ar)}</span>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
       <div><dt className="text-xs text-slate-500">{tr('Main contact','المسؤول في الموقع')}</dt><dd>{d.contact_name||tr('Not recorded','غير مسجّل')}{d.contact_phone?` · ${d.contact_phone}`:''}</dd></div>
       <div><dt className="text-xs text-slate-500">{tr('Rent / agreement','الإيجار / الاتفاق')}</dt><dd>{rel.agreement_type==='free_service'?tr('No rent','دون إيجار'):fixed?(Number(d.rent_amount)>0?money(d.rent_amount):tr('Amount not configured','المبلغ غير مضبوط')):tr('See agreement','راجعي الاتفاق')}</dd></div>
       <div><dt className="text-xs text-slate-500">{tr('Payment frequency','تكرار الدفع')}</dt><dd>{frequency(rel.payment_frequency,ar)}</dd></div>
       <div><dt className="text-xs text-slate-500">{tr('Next rent due','موعد الإيجار القادم')}</dt><dd>{rel.payment_recurring?(rel.next_payment_due_date||tr('Not configured','غير مضبوط')):tr('Recurring payment not enabled','الدفع الدوري غير مفعّل')}</dd></div>
       <div className="sm:col-span-2"><dt className="text-xs text-slate-500">{tr('Relationship next step','الخطوة القادمة للعلاقة')}</dt><dd>{rel.next_action||tr('No follow-up scheduled','لا توجد متابعة محددة')} {rel.next_action_date?`· ${rel.next_action_date}`:''}</dd></div>
      </dl>
     </article>;
    })}
   </div>
  </section>

  <section className="surface-card">
   <div className="flex flex-wrap items-start justify-between gap-3">
    <div>
     <h2 className="text-lg font-semibold">{tr('Location rent & payments','إيجارات ودفعات المواقع')}</h2>
     <p className="mt-1 text-sm text-slate-600">{tr('Unpaid and overdue rent stays visible until it is reported paid. Recurring rent creates a new payment obligation automatically when each payment period approaches.','الإيجار غير المدفوع أو المتأخر يبقى ظاهراً حتى يتم تسجيل دفعه. الإيجار الدوري ينشئ التزام دفع جديداً تلقائياً عند اقتراب كل موعد دفع.')}</p>
    </div>
    <Link className="btn-secondary" href="/relationships/obligations">{tr('Open all payments','فتح كل الدفعات')}</Link>
   </div>
   <div className="mt-4 space-y-3">
    {payments.length?payments.map(row=>{
     const overdue=row.status==='open'&&row.due_date&&row.due_date<today;
     return <Link href={crmHref('obligation',row.id)} key={row.id} className={`block rounded-xl border p-4 ${overdue?'border-rose-200 bg-rose-50':'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
       <div><strong>{row.location_name||row.title}</strong><p className="mt-1 text-sm text-slate-600">{money(row.data?.amount_lyd)} · {row.due_date??'—'}</p></div>
       <span className="text-sm font-semibold">{overdue?tr('Overdue - unpaid','متأخر - غير مدفوع'):row.status==='paid'?tr('Reported paid - awaiting verification','مسجّل كمدفوع - بانتظار التحقق'):tr('Unpaid','غير مدفوع')}</span>
      </div>
     </Link>;
    }):<p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{tr('No open location payment is currently due. The next configured recurring rent date is still visible on each current location above.','لا توجد حالياً دفعة موقع مفتوحة مستحقة. يظل موعد الإيجار الدوري القادم ظاهراً في كل موقع حالي أعلاه.')}</p>}
   </div>
  </section>
 </div>;
}
