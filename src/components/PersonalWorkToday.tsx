'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useLanguage} from '@/components/I18nProvider';
import {Banknote,ShoppingBasket,PackageCheck,ClipboardCheck,ArrowUpRight,RefreshCw} from 'lucide-react';
import {personalSections,personalViews,personalStates,personalHref,personalOverdue,parsePersonalResult,firstWorkSection,type PersonalResult,type PersonalSection,type PersonalView} from '@/lib/personal-work';
const headings:Record<PersonalSection,[string,string]>={cash:['Cash boxes','علب النقد'],buying:['Shopping lists','قوائم الشراء'],storage:['Place in storage','وضع البضاعة'],stocktakes:['Storage counts','جرد المخزن']};
const icons={cash:Banknote,buying:ShoppingBasket,storage:PackageCheck,stocktakes:ClipboardCheck};
const views:Record<PersonalView,[string,string]>={active:['Active','الحالية'],upcoming:['Upcoming','القادمة'],history:['History','السجل']};
function date(value:string,ar:boolean){return new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Tripoli'}).format(new Date(value));}
export function PersonalWorkToday(props:{name:string;initial:PersonalResult[];initialView?:PersonalView;initialSection?:PersonalSection}){
 const {locale}=useLanguage();return <PersonalWorkContent {...props} ar={locale==='ar'}/>;
}
export function PersonalWorkContent({name,initial,initialView='active',initialSection,ar}:{name:string;initial:PersonalResult[];initialView?:PersonalView;initialSection?:PersonalSection;ar:boolean}){
 const [results,setResults]=useState(initial),[view,setView]=useState<PersonalView>(initialView);
 const [selected,setSelected]=useState<PersonalSection>(initialSection??firstWorkSection(initial));
 const [busy,setBusy]=useState<PersonalSection[]>([]);
 const requests=useRef(new Map<PersonalSection,AbortController>());
 useEffect(()=>{const current=requests.current;return()=>{for(const controller of current.values())controller.abort();current.clear();};},[]);
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 async function refresh(section:PersonalSection,wanted:PersonalView,offset=0){
  requests.current.get(section)?.abort();const controller=new AbortController();requests.current.set(section,controller);
  setBusy(previous=>[...previous.filter(s=>s!==section),section]);
  const timer=setTimeout(()=>controller.abort(),15000);
  let result:PersonalResult={section,view:wanted,status:'unavailable'};
  try{
   const response=await fetch(`/api/personal-work?section=${section}&view=${wanted}&offset=${offset}`,{cache:'no-store',signal:controller.signal});
   const body=await response.json();if(!response.ok||body.section!==section||body.view!==wanted)throw Error('Unavailable');
   if(body.status==='restricted')result={section,view:wanted,status:'restricted'};
   else if(body.status==='ready')result=parsePersonalResult(body.data,section,wanted,offset);
  }catch{/* Unknown is not an empty list. Keep other sections available. */}
  finally{
   clearTimeout(timer);
   if(requests.current.get(section)===controller){
    requests.current.delete(section);
    setResults(previous=>personalSections.map(s=>s===section?result:previous.find(r=>r.section===s)??{section:s,view:wanted,status:'unavailable'}));
    setBusy(previous=>previous.filter(s=>s!==section));
   }
  }
 }
 function changeView(next:PersonalView){if(next===view)return;setView(next);for(const section of personalSections)void refresh(section,next);}
 const unknown=personalSections.filter(s=>!busy.includes(s)&&results.find(r=>r.section===s)?.status==='unavailable');
 const current=results.find(r=>r.section===selected&&r.view===view),loading=busy.includes(selected);
 const data=current?.status==='ready'?current.data:null;
 const currentIcon=icons[selected];const Icon=currentIcon;
 return <div dir={ar?'rtl':'ltr'} className="mx-auto min-w-0 max-w-4xl space-y-5" data-testid="personal-work">
  <header className="flex items-start justify-between gap-3">
   <div className="min-w-0"><p className="text-xs font-bold tracking-wide text-orange-800">SNACKY · {tr('YOUR ASSIGNMENTS','العمل المسند إليك')}</p><h1 className="mt-2 text-2xl font-semibold text-slate-950 sm:text-3xl">{tr('My Work Today','مهامي اليوم')}</h1><p className="mt-2 break-words text-sm text-slate-600">{name} · {tr('One place for cash, shopping and stock.','النقد والشراء والجرد في مكان واحد.')}</p></div>
   <button type="button" className="btn-secondary min-h-11 shrink-0" aria-label={tr('Refresh all work','تحديث كل المهام')} disabled={busy.length>0} onClick={()=>{for(const s of personalSections)void refresh(s,view);}}><RefreshCw className="h-4 w-4" aria-hidden="true"/></button>
  </header>
  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-600">{tr('Your assignments only. Open the original record to do the work; this screen does not change cash or stock.','عملك المسند إليك فقط. افتح السجل الأصلي لتنفيذه؛ هذه الصفحة لا تعدّل النقد أو المخزون.')}</div>
  <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1" role="group" aria-label={tr('Work period','فترة المهام')}>
   {personalViews.map(v=><button key={v} type="button" aria-pressed={view===v} className={`min-h-11 rounded-lg px-2 text-sm font-semibold ${view===v?'bg-white text-slate-950 shadow-sm':'text-slate-600 hover:bg-white/60'}`} onClick={()=>changeView(v)}>{views[v][ar?1:0]}</button>)}
  </div>
  {unknown.length>0?<p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{tr('Some work could not load. Missing counts are unknown—not zero.','تعذر تحميل بعض المهام. أعدادها غير معروفة، وليست صفراً.')}</p>:null}
  <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={tr('Work categories','أنواع المهام')}>
   {personalSections.map(s=>{const r=results.find(x=>x.section===s&&x.view===view),pending=busy.includes(s),d=r?.status==='ready'?r.data:null,TileIcon=icons[s];return <button key={s} type="button" aria-label={headings[s][ar?1:0]} aria-pressed={selected===s} className={`min-w-0 rounded-xl border p-3 text-start transition ${selected===s?'border-orange-400 bg-orange-50':'border-slate-200 bg-white hover:border-orange-300'}`} onClick={()=>setSelected(s)}>
    <div className="flex items-center justify-between gap-2"><TileIcon className="h-5 w-5 text-orange-800" aria-hidden="true"/><strong className="text-2xl tabular-nums text-slate-950" data-testid={`my-count-${s}`}>{pending?'…':d?d.total:'—'}</strong></div>
    <span className="mt-2 block text-sm font-semibold text-slate-900">{headings[s][ar?1:0]}</span>
    <span className="mt-1 block text-xs leading-5 text-slate-600">{pending?tr('Checking…','جارٍ التحقق…'):r?.status==='restricted'?tr('Not in your access','ليست ضمن صلاحياتك'):!d?tr('Could not load','تعذر التحميل'):view==='history'?tr('Past records','سجلات سابقة'):`${d.actions} ${tr('actions to do','إجراءات مطلوبة')}`}</span>
   </button>;})}
  </nav>
  <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-busy={loading} aria-labelledby="my-work-heading">
   <div className="flex items-center gap-2"><Icon className="h-5 w-5 text-orange-800" aria-hidden="true"/><h2 id="my-work-heading" className="text-lg font-semibold">{headings[selected][ar?1:0]}</h2></div>
   {loading?<p role="status" className="py-10 text-sm text-slate-600">{tr('Checking your assigned work…','جارٍ التحقق من مهامك المسندة…')}</p>:current?.status==='restricted'?<p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">{tr('This workflow is not part of your current permissions. Your other work is unchanged.','هذا القسم ليس ضمن صلاحياتك الحالية. لا يتغير عملك في الأقسام الأخرى.')}</p>:!data?<div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-950">{tr('Could not load this section. This is not an empty task list.','تعذر تحميل هذا القسم. هذا لا يعني عدم وجود مهام.')}</p><button type="button" className="btn-secondary mt-3 min-h-11" onClick={()=>void refresh(selected,view)}>{tr('Retry this section','إعادة تحميل هذا القسم')}</button></div>:<>
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-slate-500"><span>{tr('Checked: ','آخر تحقق: ')}<time dateTime={data.checked_at}>{date(data.checked_at,ar)}</time></span>{view==='active'&&data.total>data.actions?<span>{data.total-data.actions} {tr('waiting on someone else','بانتظار شخص آخر')}</span>:null}</div>
    {data.total===0?<p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm leading-6 text-slate-600">{tr('No matching assignments at the last successful check.','لا توجد مهام مطابقة عند آخر تحقق ناجح.')}</p>:<ul className="mt-4 space-y-3">
     {data.rows.map(row=>{const overdue=personalOverdue(row,data);return <li key={row.id} className={`min-w-0 rounded-xl border p-4 ${overdue?'border-amber-300 bg-amber-50/40':'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold text-slate-950">{row.title}</h3>{overdue?<span className="shrink-0 rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-950">{tr('Overdue','متأخر')}</span>:null}</div>
      {row.context?<p className="mt-1 break-words text-xs leading-5 text-slate-600">{row.context}</p>:null}
      <p className={`mt-2 text-sm font-medium ${row.actionable?'text-slate-900':'text-slate-500'}`}>{personalStates[row.state][ar?1:0]}</p>
      {row.done!==null&&row.total!==null?<p className="mt-2 text-xs text-slate-600">{row.done} / {row.total} {selected==='buying'?tr('items checked','منتجات تمت مراجعتها'):tr('products counted','منتجات تم عدّها')}</p>:null}
      {row.due_at&&row.actionable?<p className="mt-2 text-xs leading-5 text-slate-500">{tr('Deadline: ','الموعد النهائي: ')}{date(row.due_at,ar)}</p>:row.since?<p className="mt-2 text-xs leading-5 text-slate-500">{tr('Recorded: ','التسجيل: ')}{date(row.since,ar)}</p>:null}
      <Link prefetch={false} className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-orange-800 underline underline-offset-4" href={personalHref(selected,row.target_id)}>{row.actionable?tr('Open and continue','افتح وأكمل'):tr('View record','عرض السجل')}<ArrowUpRight className="h-4 w-4" aria-hidden="true"/></Link>
     </li>;})}
    </ul>}
    {data.total>5?<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><span className="tabular-nums text-slate-600">{Math.min(data.offset+1,data.total)}–{Math.min(data.offset+5,data.total)} / {data.total}</span><div className="flex gap-2"><button type="button" className="btn-secondary min-h-11" disabled={data.offset===0} onClick={()=>void refresh(selected,view,Math.max(0,data.offset-5))}>{tr('Previous','السابق')}</button><button type="button" className="btn-secondary min-h-11" disabled={data.offset+5>=data.total} onClick={()=>void refresh(selected,view,data.offset+5)}>{tr('Next','التالي')}</button></div></div>:null}
   </>}
  </section>
  <p className="text-xs leading-5 text-slate-500">{tr('Refill routes and CRM tasks remain in their existing pages. Phone notifications can be managed in Account.','مسارات التعبئة ومهام العلاقات تبقى في صفحاتها الحالية. يمكنك إدارة إشعارات هاتفك من الحساب.')}</p>
 </div>;
}
