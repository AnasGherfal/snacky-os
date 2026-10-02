import Link from 'next/link';
import {crmContactLink,crmStatus} from '@/lib/crm-workspace';

type SupportRow={
 id:string;
 customer_name?:string|null;
 customer_phone?:string|null;
 customer_whatsapp?:string|null;
 description?:string|null;
 status:string;
 priority?:string|null;
 location_name?:string|null;
 next_action?:string|null;
 next_action_date?:string|null;
 waiting_operator?:boolean;
 waiting_customer?:boolean;
 needs_management?:boolean;
 overdue?:boolean;
 due_today?:boolean;
};

export function CustomerSupportPanel({data,ar}:{data:any;ar:boolean}){
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const counts=data?.counts??{},rows=(data?.rows??[]) as SupportRow[];
 const cards=[
  ['open',tr('Open cases','الحالات المفتوحة')],
  ['waiting_operator',tr('Waiting for operator','بانتظار المشغّل')],
  ['waiting_customer',tr('Waiting for customer','بانتظار العميل')],
  ['needs_management',tr('Needs management','تحتاج موافقة الإدارة')],
  ['due_today',tr('Due today','متابعة اليوم')],
  ['overdue',tr('Overdue','متأخرة')],
  ['recent_resolved',tr('Resolved in 7 days','حُلّت آخر 7 أيام')],
 ] as const;
 return <section className="surface-card space-y-4" aria-labelledby="customer-support-heading">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div>
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr('CUSTOMER SUPPORT','خدمة العملاء')}</p>
    <h2 id="customer-support-heading" className="mt-1 text-xl font-semibold">{tr('Support queue','قائمة دعم العملاء')}</h2>
    <p className="mt-1 text-sm text-slate-600">{tr('WhatsApp and calls stay fast; cases, operator work, approvals and outcomes stay in Snacky OS.','يبقى واتساب والاتصال للتواصل السريع، وتبقى الحالات وإجراءات المشغّل والموافقات والنتائج داخل نظام سناكي.')}</p>
   </div>
   <div className="flex flex-wrap gap-2">
    <Link className="btn-primary" href="/issues/new">+ {tr('Quick issue','بلاغ عميل سريع')}</Link>
    <Link className="btn-secondary" href="/issues?scope=mine">{tr('All cases','كل الحالات')}</Link>
   </div>
  </div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
   {cards.map(([key,label])=><div key={key} className={`rounded-xl border p-3 ${key==='overdue'&&Number(counts[key]??0)>0?'border-rose-200 bg-rose-50':key==='needs_management'&&Number(counts[key]??0)>0?'border-amber-200 bg-amber-50':'border-slate-200 bg-slate-50'}`}>
    <span className="text-xs text-slate-600">{label}</span>
    <strong className="mt-1 block text-2xl">{Number(counts[key]??0)}</strong>
   </div>)}
  </div>
  {rows.length?<div className="space-y-2">
   {rows.map(row=>{
    const phone=row.customer_phone;
    const whatsapp=row.customer_whatsapp??phone;
    const callHref=crmContactLink('phone',phone);
    const waHref=crmContactLink('whatsapp',whatsapp);
    const flags=[
     row.needs_management?tr('Management','الإدارة'):null,
     row.waiting_operator?tr('Operator','المشغّل'):null,
     row.waiting_customer?tr('Customer','العميل'):null,
     row.overdue?tr('Overdue','متأخرة'):row.due_today?tr('Today','اليوم'):null,
    ].filter(Boolean);
    return <article key={row.id} className={`rounded-xl border p-4 ${row.overdue?'border-rose-200':row.needs_management?'border-amber-200':'border-slate-200'}`}>
     <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
       <div className="flex flex-wrap items-center gap-2">
        <Link className="font-semibold text-slate-950 underline decoration-slate-300 underline-offset-4" href={`/issues/${row.id}`}>{row.customer_name||row.location_name||tr('Customer issue','بلاغ عميل')}</Link>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs">{crmStatus(row.status,ar)}</span>
        {flags.map(flag=><span key={String(flag)} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-700">{flag}</span>)}
       </div>
       <p className="mt-1 line-clamp-2 text-sm text-slate-600">{row.description||tr('No description recorded','لا يوجد وصف مسجّل')}</p>
       <p className="mt-2 text-xs text-slate-500">{row.location_name??tr('Location not identified','الموقع غير محدد')} · {tr('Next','التالي')}: {row.next_action||tr('Open the case and set the next action','افتح الحالة وحدد الخطوة القادمة')} {row.next_action_date?`· ${row.next_action_date}`:''}</p>
      </div>
      <div className="flex flex-wrap gap-2">
       {callHref?<a className="btn-secondary min-h-10 text-xs" href={callHref}>{tr('Call','اتصال')}</a>:null}
       {waHref?<a className="btn-secondary min-h-10 text-xs" href={waHref} target="_blank" rel="noopener noreferrer">WhatsApp</a>:null}
       <Link className="btn-secondary min-h-10 text-xs" href={`/issues/${row.id}`}>{tr('Open','فتح')}</Link>
      </div>
     </div>
    </article>;
   })}
  </div>:<div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">{tr('No open customer cases are assigned to you.','لا توجد حالات عملاء مفتوحة مسندة إليك.')}</div>}
 </section>;
}
