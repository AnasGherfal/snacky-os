'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useLanguage} from '@/components/I18nProvider';
import {operationSections,operationStates,parseOperationData,waitingMinutes,type OperationData,type OperationResult,type OperationSection} from '@/lib/owner-operations';

const headings:Record<OperationSection,[string,string]>={cash:['Cash handovers','تسليم النقد وعدّه'],buying:['Buying & storage','الشراء ووضع البضاعة'],stocktakes:['Storage counts','جرد المخزن'],issues:['Customer issues','بلاغات العملاء'],notifications:['Phone notifications','إشعارات الفريق']};
const moduleLinks:Record<OperationSection,string>={cash:'/cash-handling',buying:'/buying-lists',stocktakes:'/inventory/stocktake',issues:'/issues',notifications:'/team'};
const descriptions:Record<OperationSection,[string,string]>={
 cash:['Recorded cash movements only. Earlier records without a box reference are separated below; they are not evidence of missing money.','حركات النقد المسجلة فقط. السجلات السابقة دون رقم علبة تظهر منفصلة ولا تعني وجود نقد مفقود.'],
 buying:['Open lists, reported shortages and linked receipts awaiting physical storage confirmation. The buyer may also place the goods in storage.','القوائم المفتوحة والنواقص والفواتير المرتبطة التي لم يتأكد وضع بضائعها في المخزن. يمكن للمشتري نفسه تأكيد وضع البضاعة.'],
 stocktakes:['Assigned counts and submitted counts awaiting owner approval. Nothing is adjusted from this overview.','الجرد المسند والجرد المرسل لاعتماد المالك. لا يتم تعديل أي كمية من هذه الصفحة.'],
 issues:['Open, non-historical customer issues. Field completion does not replace CRM verification. Each issue appears once.','البلاغات المفتوحة غير التاريخية. إتمام العمل الميداني لا يغني عن تحقق علاقات العملاء. يظهر كل بلاغ مرة واحدة.'],
 notifications:['Active operations staff. A registered device is not proof of delivery or that a notification was read. Device permission must be enabled on the employee’s own phone.','الموظفون التشغيليون النشطون. تسجيل جهاز لا يثبت وصول الإشعار أو قراءته. يجب تفعيل الإذن من هاتف الموظف نفسه.'],
};
function date(value:string,ar:boolean){return new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Tripoli'}).format(new Date(value));}
function age(since:string|null,checkedAt:string,ar:boolean){const n=waitingMinutes(since,checkedAt);if(n===null)return ar?'وقت البداية غير مسجل':'Start time not recorded';if(n<60)return ar?`${n} دقيقة`:`${n} min`;if(n<1440)return ar?`${Math.floor(n/60)} ساعة`:`${Math.floor(n/60)} hr`;return ar?`${Math.floor(n/1440)} يوم`:`${Math.floor(n/1440)} days`;}
function metric(section:OperationSection,data:OperationData){if(section==='notifications')return data.counts.no_device??0;if(section==='stocktakes')return data.counts.stock_review??0;if(section==='cash')return data.total-(data.counts.cash_reference??0);return data.total;}
function metricLabel(section:OperationSection,ar:boolean){if(section==='notifications')return ar?'دون جهاز مسجل':'without a registered device';if(section==='stocktakes')return ar?'بانتظار اعتمادك':'awaiting your approval';if(section==='cash')return ar?'علب نقد بانتظار إجراء':'cash boxes awaiting action';return ar?'سجلات تحتاج متابعة':'records to follow up';}
function severe(state:string){return ['crm_blocked','crm_acceptance','crm_unassigned','crm_overdue','no_device'].includes(state);}

export function OwnerOperationsWorkspace({initial}:{initial:OperationResult[]}){const {locale}=useLanguage();return <OwnerOperationsOverview initial={initial} ar={locale==='ar'}/>;}
export function OwnerOperationsOverview({initial,ar}:{initial:OperationResult[];ar:boolean}){
 const [results,setResults]=useState(initial),[busy,setBusy]=useState<OperationSection[]>([]);
 const requests=useRef(new Map<OperationSection,AbortController>());
 useEffect(()=>{const pending=requests.current;return()=>{for(const controller of pending.values())controller.abort();pending.clear();};},[]);
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 async function refresh(section:OperationSection,offset=0){
  requests.current.get(section)?.abort();const controller=new AbortController();requests.current.set(section,controller);
  setBusy(previous=>[...previous.filter(x=>x!==section),section]);const timer=setTimeout(()=>controller.abort(),18000);
  try{
   const response=await fetch(`/api/owner-operations?section=${section}&offset=${offset}`,{cache:'no-store',signal:controller.signal});
   const body=await response.json();if(!response.ok||body.status!=='ready')throw Error('Unavailable');
   const data=parseOperationData(body.data,section,offset);
   if(requests.current.get(section)===controller)setResults(previous=>operationSections.map(key=>key===section?{section,status:'ready',data}:previous.find(x=>x.section===key)??{section:key,status:'unavailable'}));
  }catch{
   if(requests.current.get(section)===controller)setResults(previous=>operationSections.map(key=>key===section?{section,status:'unavailable'}:previous.find(x=>x.section===key)??{section:key,status:'unavailable'}));
  }finally{clearTimeout(timer);if(requests.current.get(section)===controller){requests.current.delete(section);setBusy(previous=>previous.filter(x=>x!==section));}}
 }
 const unavailable=operationSections.filter(section=>results.find(x=>x.section===section)?.status!=='ready'&&!busy.includes(section));
 return <div className="min-w-0 space-y-6" dir={ar?'rtl':'ltr'} data-testid="owner-operations">
  <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
   <div><p className="text-xs font-bold uppercase tracking-wider text-orange-700">SNACKY · {tr('OWNER / ADMIN','المالك / الإدارة')}</p><h1 className="mt-2 text-2xl font-semibold text-slate-950 sm:text-3xl">{tr('Owner Operations','متابعة العمليات')}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{tr('What is pending, who is responsible, and the next step. Read-only snapshots of your existing records.','ما الذي ينتظر؟ من المسؤول؟ وما الخطوة التالية؟ عرض فقط لسجلات العمل الموجودة.')}</p></div>
   <button type="button" className="btn-secondary min-h-11 shrink-0" disabled={busy.length>0} onClick={()=>void Promise.all(operationSections.map(section=>refresh(section)))}>{busy.length?tr('Refreshing…','جارٍ التحديث…'):tr('Refresh overview','تحديث المتابعة')}</button>
  </header>
  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">{tr('No balances, approval buttons or stock changes here. Open the original record to take action.','لا أرصدة مالية ولا أزرار اعتماد أو تعديل مخزون هنا. افتح السجل الأصلي لاتخاذ الإجراء.')}</div>
  {unavailable.length>0?<p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-950">{tr('Some sections could not load. Their pending counts are unknown—not zero.','تعذر تحميل بعض الأقسام. عدد السجلات المعلقة فيها غير معروف، وليس صفراً.')}</p>:null}
  <nav aria-label={tr('Operations sections','أقسام المتابعة')} className="grid grid-cols-1 gap-3 min-[390px]:grid-cols-2 xl:grid-cols-5">
   {operationSections.map(section=>{const result=results.find(x=>x.section===section),loading=busy.includes(section),data=result?.status==='ready'?result.data:null;return <a key={section} href={`#ops-${section}`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-orange-400">
    <span className="text-sm font-semibold text-slate-700">{headings[section][ar?1:0]}</span><strong className="mt-3 block text-3xl tabular-nums text-slate-950" data-testid={`ops-metric-${section}`}>{loading?'…':data?metric(section,data):'—'}</strong>
    <span className="mt-1 block text-xs leading-5 text-slate-500">{loading?tr('Checking…','جارٍ التحقق…'):data?metricLabel(section,ar):tr('Could not load','تعذر التحميل')}</span>
    {data&&section==='cash'&&(data.counts.cash_reference??0)>0?<span className="mt-2 block text-xs text-amber-800">{tr('Earlier records to review: ','سجلات سابقة للمراجعة: ')}{data.counts.cash_reference}</span>:null}
   </a>;})}
  </nav>
  {operationSections.map(section=>{const result=results.find(x=>x.section===section),loading=busy.includes(section),data=result?.status==='ready'?result.data:null;return <section key={section} id={`ops-${section}`} aria-busy={loading} className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
   <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-900">{headings[section][ar?1:0]}</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{descriptions[section][ar?1:0]}</p></div><Link className="text-sm font-semibold text-orange-800 underline underline-offset-4" href={moduleLinks[section]}>{tr('Open module','فتح القسم')}</Link></div>
   {loading?<p role="status" className="py-8 text-sm text-slate-600">{tr('Checking this section…','جارٍ التحقق من هذا القسم…')}</p>:!data?<div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-950">{tr('Could not load. This is not an empty queue.','تعذر التحميل. هذا لا يعني أن القائمة فارغة.')}</p><button type="button" className="btn-secondary mt-3 min-h-11" onClick={()=>void refresh(section)}>{tr('Retry this section','إعادة تحميل هذا القسم')}</button></div>:<>
    <p className="mt-3 text-xs text-slate-500">{tr('Checked: ','آخر تحقق: ')}<time dateTime={data.checked_at}>{date(data.checked_at,ar)}</time> · {tr('Records: ','السجلات: ')}{data.total}</p>
    {data.diagnostics?<div className="mt-3 flex flex-col gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-700">
     <p>{tr('Notification service: ','خدمة الإشعارات: ')}{data.diagnostics.notifications_enabled===null?tr('Unknown','غير معروفة'):data.diagnostics.notifications_enabled?tr('Enabled','مفعّلة'):tr('Paused','متوقفة')}. {tr('Urgent escalation: ','تصعيد المهام العاجلة: ')}{data.diagnostics.escalation_enabled===null?tr('Unknown','غير معروف'):data.diagnostics.escalation_enabled?tr('Enabled','مفعّل'):tr('Paused','متوقف')}.</p>
     <p>{tr('Last escalation scan: ','آخر فحص للتصعيد: ')}{data.diagnostics.last_scan_at?date(data.diagnostics.last_scan_at,ar):tr('No scan recorded','لا يوجد فحص مسجل')}. {tr('Phone delivery still needs a real device test.','يظل وصول الإشعار للهاتف بحاجة إلى اختبار فعلي.')}</p>
    </div>:null}
    {data.total===0?<p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">{tr('No matching records at the last successful check.','لا توجد سجلات مطابقة عند آخر تحقق ناجح.')}</p>:<ul className="mt-4 space-y-3">
     {data.rows.map(row=>{const labels=operationStates[row.state],overdue=row.due_at&&Date.parse(row.due_at)<=Date.parse(data.checked_at);return <li key={`${row.state}:${row.id}`} className="min-w-0 rounded-xl border border-slate-200 p-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><h3 className="break-words text-base font-semibold text-slate-950">{row.title}</h3>{row.context?<p className="mt-1 break-words text-sm text-slate-500">{row.context}</p>:null}</div><span className={`self-start rounded-lg px-2.5 py-1 text-xs font-medium ${severe(row.state)?'bg-amber-50 text-amber-950':'bg-slate-100 text-slate-700'}`}>{labels[ar?1:0]}</span></div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs leading-5 text-slate-600"><p>{tr('Responsible: ','المسؤول: ')}<strong className="text-slate-800">{row.person??tr('Not assigned / not recorded','غير معيّن / غير مسجل')}</strong></p>{section!=='notifications'?<p>{tr('Elapsed: ','المدة: ')}{age(row.since,data.checked_at,ar)}</p>:null}{row.due_at?<p className={overdue?'font-semibold text-amber-900':''}>{tr('Deadline: ','الموعد: ')}{date(row.due_at,ar)}{overdue?' · '+tr('Overdue','متأخر'):''}</p>:null}</div>
      <Link className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-orange-800 underline underline-offset-4" href={row.href}>{labels[ar?3:2]}</Link>
     </li>;})}
    </ul>}
    {data.total>25?<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><span>{Math.min(data.offset+1,data.total)}–{Math.min(data.offset+25,data.total)} / {data.total}</span><div className="flex gap-2"><button className="btn-secondary min-h-11" disabled={data.offset===0} onClick={()=>void refresh(section,Math.max(0,data.offset-25))}>{tr('Previous','السابق')}</button><button className="btn-secondary min-h-11" disabled={data.offset+25>=data.total} onClick={()=>void refresh(section,data.offset+25)}>{tr('Next','التالي')}</button></div></div>:null}
   </>}
  </section>;})}
 </div>;
}
