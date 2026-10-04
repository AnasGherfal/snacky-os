'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DutyBoard } from '@/lib/smart-work-duties';
const messages:Record<string,[string,string]>={
  coverage_missing:['Coverage setup is missing or disabled.','إعدادات التغطية ناقصة أو معطّلة.'],
  products_unmapped:['Products need mapping before a reliable refill can be planned.','يجب ربط المنتجات قبل تخطيط تعبئة موثوقة.'],
  future_trip_only:['An existing trip is dated later; today’s coverage is still unresolved.','توجد جولة بتاريخ لاحق؛ تغطية اليوم لم تُحسم.'],
  no_capacity:['No approved operator has enough verified time.','لا يتوفر مشغّل معتمد بوقت كافٍ.'],
  readings_unknown:['Current machine readings need verification.','قراءات الجهاز الحالية تحتاج تحققاً.'],
  site_closed:['Site access is closed today. The duty remains required.','الموقع مغلق اليوم. يبقى الواجب مطلوباً.'],
  assignment_conflict:['Duty and trip assignments conflict. Review coverage.','يوجد تعارض في التكليفات. راجع التغطية.'],
  owner_unavailable:['The responsible operator is unavailable; coverage needs attention.','المشغّل المسؤول غير متاح؛ التغطية تحتاج متابعة.'],
  previous_trip_unfinished:['The previous visit did not verify completion.','الزيارة السابقة لم تؤكد اكتمال التعبئة.'],
  route_without_active_operator:['The existing trip has no active operator.','الجولة الحالية بدون مشغّل نشط.'],
  machine_inactive:['Machine inactive; obligation retained for review.','الجهاز غير نشط؛ الواجب محفوظ للمراجعة.'],
  service_needs_verification:['Service was recorded, but inventory/XY verification is still incomplete.','تم تسجيل الزيارة لكن التحقق من المخزون أو XY غير مكتمل.'],
};
export default function DailyDutiesClient({ar}:{ar:boolean}){
  const [board,setBoard]=useState<DutyBoard|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const version=useRef(0);
  const t=useCallback((en:string,a:string)=>ar?a:en,[ar]);
  const reload=useCallback(async()=>{
    const n=++version.current;setBusy(true);setError('');
    try{
      const refreshed=await fetch('/api/operator/smart-work-duties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refresh'})});
      if(!refreshed.ok) throw new Error(t('Refresh failed. Saved duties have not been cleared. Use your existing routes.','تعذّر التحديث. الواجبات المحفوظة لم تُحذف. استخدم الجولات الحالية.'));
      const response=await fetch('/api/operator/smart-work-duties',{cache:'no-store'});
      if(!response.ok) throw new Error(t('Could not load all duties. Do not treat this as an empty workday.','تعذّر تحميل الواجبات كاملة. هذا لا يعني عدم وجود عمل.'));
      const data=await response.json();if(n===version.current)setBoard(data as DutyBoard);
    }catch(e){if(n===version.current)setError(e instanceof Error?e.message:t('Refresh failed.','تعذّر التحديث.'));}
    finally{if(n===version.current)setBusy(false);}
  },[t]);
  useEffect(()=>{void reload();return()=>{version.current++;};},[reload]);
  const format=(v:string|null)=>v?new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{timeZone:'Africa/Tripoli',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):t('Setup needed','تحتاج إعداداً');
  const labels={required:t('Required','مطلوب'),in_progress:t('Existing trip in progress','جولة حالية قيد التنفيذ'),verification_pending:t('Verification pending','بانتظار التحقق'),completed:t('Verified service','تعبئة مؤكدة')};
  return <main dir={ar?'rtl':'ltr'} className="mx-auto max-w-5xl space-y-5 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-slate-500">SNACKY</p><h1 className="mt-1 text-3xl font-bold">{t('Required refills','واجبات التعبئة')}</h1><p className="mt-2 text-sm text-slate-600">{t('Saved responsibilities · original deadlines · Libya time','مسؤوليات محفوظة · المواعيد الأصلية · بتوقيت ليبيا')}</p></div><button type="button" className="btn-primary min-h-11" disabled={busy} onClick={()=>void reload()}>{busy?t('Checking…','جارٍ التحقق…'):t('Refresh duties','تحديث الواجبات')}</button></header>
    <section className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">{t('Taking one stop now does not remove the other required machines. This page saves duties only: collect goods through an existing assigned route. It does not start a trip or reserve stock.','تنفيذ محطة واحدة الآن لا يلغي بقية الأجهزة المطلوبة. هذه الصفحة تحفظ الواجبات فقط: استلم المنتجات عبر جولة مسندة حالية. لا تبدأ جولة ولا تحجز مخزوناً.')}</section>
    <nav className="flex flex-wrap gap-2"><Link href="/operator/today-work" className="btn-secondary min-h-11">{t('Machine readings','قراءات الأجهزة')}</Link><Link href="/operator/routes" className="btn-secondary min-h-11">{t('Existing routes','الجولات الحالية')}</Link>{board?.canConfigure?<Link href="/settings/smart-work-coverage" className="btn-secondary min-h-11">{t('Coverage & hours','التغطية وأوقات العمل')}</Link>:null}</nav>
    {error?<div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</div>:null}
    {board?<>
      <section aria-label={t('Daily responsibility','المسؤولية اليومية')} className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[[t('Still required','لا تزال مطلوبة'),board.counts.remaining],[t('Your responsibility','مسؤوليتك'),board.counts.mine],[t('Unassigned','بدون مشغّل'),board.counts.uncovered],[t('Past deadline','متأخرة'),board.counts.overdue]].map(([label,count])=><div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4"><strong className="text-3xl tabular-nums">{count}</strong><p className="mt-1 text-sm text-slate-600">{label}</p></div>)}</section>
      {board.counts.uncertainMachines>0?<p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">{t(`${board.counts.uncertainMachines} machines have uncertain readings; the saved duty count may not show all work needed.`,`${board.counts.uncertainMachines} أجهزة بقراءات غير مؤكدة؛ قد توجد أعمال إضافية غير ظاهرة في عدد الواجبات المحفوظة.`)}</p>:null}
      <p className="text-xs text-slate-500">{t('Last checked','آخر تحقق')}: {format(board.checkedAt)} · {t('Opening or refreshing updates this list; unattended alerts are not enabled yet.','فتح الصفحة أو تحديثها يحدّث القائمة؛ التنبيهات التلقائية لم تُفعّل بعد.')}</p>
      {!board.duties.length?<p className="surface-card">{t('No saved duties yet. Check machine readings and coverage setup; this is not proof every machine is full.','لا توجد واجبات محفوظة بعد. تحقق من القراءات وإعدادات التغطية؛ هذا ليس تأكيداً بأن كل الأجهزة ممتلئة.')}</p>:null}
      <section className="grid gap-4 md:grid-cols-2">{board.duties.map(d=><article key={d.id} className={`rounded-2xl border bg-white p-5 ${d.overdue?'border-red-300':'border-slate-200'}`}>
        <div className="flex flex-wrap justify-between gap-2"><h2 className="text-lg font-bold">{d.machineName}</h2><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{labels[d.state]}</span></div>
        <p className={`mt-3 font-semibold ${d.ownerName?'text-emerald-900':'text-red-800'}`}>{d.ownerName||t('No responsible operator yet','لم يُحدد مشغّل مسؤول بعد')}{d.mine?` · ${t('Your duty','واجبك')}`:''}</p>
        <dl className="mt-3 space-y-1 text-sm"><div><dt className="inline text-slate-500">{t('Required since: ','مطلوب منذ: ')}</dt><dd className="inline">{format(d.requiredAt)}</dd></div><div><dt className="inline text-slate-500">{t('Original deadline: ','الموعد المطلوب: ')}</dt><dd className={`inline font-semibold ${d.overdue?'text-red-800':''}`}>{format(d.dueAt)}{d.overdue?` · ${t('Overdue','متأخر')}`:''}</dd></div></dl>
        {d.blocker?<p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950">{messages[d.blocker]?.[ar?1:0]||t('Coverage requires review.','التغطية تحتاج مراجعة.')}</p>:null}
        {d.completedAt?<p className="mt-3 text-sm text-emerald-800">{t('Service verified: ','تم تأكيد التعبئة: ')}{format(d.completedAt)}</p>:<p className="mt-3 text-xs leading-5 text-slate-500">{t('Remains required until verified service. A skipped trip, changed reading or new day does not clear it.','يبقى مطلوباً حتى تأكيد التعبئة. تخطي الجولة أو تغيّر القراءة أو بداية يوم جديد لا يلغيه.')}</p>}
      </article>)}</section>
    </>:busy?<p aria-live="polite" className="surface-card">{t('Checking saved duties and current readings…','جارٍ التحقق من الواجبات والقراءات الحالية…')}</p>:null}
  </main>;
}
