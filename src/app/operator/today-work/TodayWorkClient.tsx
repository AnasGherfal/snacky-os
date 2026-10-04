'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Priority, TripPlan } from '@/lib/self-dispatch';
import type { projectMandatoryWork } from '@/lib/self-dispatch-duties';
import DailyCoveragePanel from './DailyCoveragePanel';

type MachineCard = {
  machineId:string; name:string; priority:Priority; empty:number; low:number; unknown:number;
  lanes:number; meanFullness:number|null; stockPercent:number|null; openToday:boolean; actionable:boolean;
  assignments:{operatorName:string;operatorAssigned:boolean;mine:boolean;routeId:string|null;routeDate:string}[];
};
type Board = {
  board:MachineCard[];
  dailyCoverage:ReturnType<typeof projectMandatoryWork>;
  myTrips:{id:string;date:string;status:string;remaining:number;machineNames:string[]}[];
  generatedAt:string; recommendedMachineIds:string[]; canManage:boolean; dispatchEnabled:false;
};
type Preview = {
  plan:TripPlan; machines:{id:string;name:string}[];generatedAt:string;mode:'rules_preview';dispatchEnabled:false;warning:string;
};
const labels:Record<Priority,[string,string]> = {
  immediate:['Immediate attention','تعبئة فورية'],urgent:['Fill as soon as possible','تعبئة عاجلة'],
  today:['Fill today','تعبئة اليوم'],monitor:['Monitor','متابعة'],healthy:['Stock is healthy','المخزون جيد'],verify:['Check XY data','تحقق من بيانات XY'],
};
const badge:Record<Priority,string> = {
  immediate:'border-red-200 bg-red-50 text-red-900',urgent:'border-orange-200 bg-orange-50 text-orange-900',
  today:'border-amber-200 bg-amber-50 text-amber-900',monitor:'border-slate-200 bg-slate-50 text-slate-600',
  healthy:'border-emerald-200 bg-emerald-50 text-emerald-900',verify:'border-violet-200 bg-violet-50 text-violet-900',
};

export default function TodayWorkClient({locale}:{locale:'en'|'ar'}) {
  const ar=locale==='ar';
  const t=(en:string,arabic:string)=>ar?arabic:en;
  const [board,setBoard]=useState<Board|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [preview,setPreview]=useState<Preview|null>(null);
  const [busy,setBusy]=useState<'board'|'preview'|null>(null);
  const [error,setError]=useState('');
  const [copied,setCopied]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const generation=useRef(0);
  const previewRef=useRef<HTMLDivElement>(null);

  const refresh=useCallback(async()=>{
    controller.current?.abort();
    const request=new AbortController();controller.current=request;
    const version=++generation.current;
    const timeout=setTimeout(()=>request.abort(),25_000);
    setBusy('board');setError('');setPreview(null);
    try {
      const response=await fetch('/api/operator/today-work',{cache:'no-store',signal:request.signal});
      const result=await response.json();
      if(!response.ok) throw new Error(result.error || 'Could not load today’s work.');
      if(version!==generation.current) return;
      const next=result as Board;
      setBoard(next);
      setSelected(previous=>{
        const stillAvailable=previous.filter(id=>next.board.some(m=>m.machineId===id && m.openToday && !m.assignments.length));
        return stillAvailable.length ? stillAvailable : next.recommendedMachineIds;
      });
    } catch(err) {
      if(version!==generation.current) return;
      setError(err instanceof Error && err.name!=='AbortError' ? err.message : 'The work board request timed out. Your existing routes are unchanged.');
    } finally { clearTimeout(timeout);if(version===generation.current)setBusy(null); }
  },[]);
  useEffect(()=>{void refresh();return()=>{generation.current++;controller.current?.abort();};},[refresh]);

  function toggle(id:string) {
    if(busy) return;
    setPreview(null);setError('');setCopied(false);
    setSelected(ids=>ids.includes(id)?ids.filter(x=>x!==id):ids.length<6?[...ids,id]:ids);
  }
  async function generatePreview() {
    if(!selected.length || busy) return;
    controller.current?.abort();const request=new AbortController();controller.current=request;
    const version=++generation.current;const timeout=setTimeout(()=>request.abort(),30_000);
    setBusy('preview');setError('');setPreview(null);setCopied(false);
    try {
      const response=await fetch('/api/operator/today-work',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({machineIds:selected}),signal:request.signal});
      const result=await response.json();
      if(!response.ok) throw new Error(result.error || 'Could not verify the preview.');
      if(version!==generation.current) return;
      setPreview(result as Preview);
      setTimeout(()=>previewRef.current?.scrollIntoView({behavior:'smooth',block:'start'}),0);
    } catch(err) {
      if(version!==generation.current)return;
      setError(err instanceof Error && err.name!=='AbortError'?err.message:'Preview timed out. No route or reservation was created.');
    } finally {clearTimeout(timeout);if(version===generation.current)setBusy(null);}
  }
  async function copyList() {
    if(!preview)return;
    const title=t('PREVIEW ONLY — not pickup authorization','معاينة فقط — ليست إذناً باستلام المخزون');
    const lines=[title,preview.machines.map(m=>m.name).join(' · '),
      ...preview.plan.pickup.map(p=>`${p.productName} × ${p.quantity}`),
      `${t('Empty / unknown / underfilled','فارغة / غير مؤكدة / غير مكتملة')}: ${preview.plan.emptyAfter} / ${preview.plan.unknownAfter} / ${preview.plan.underfilled}`];
    try {await navigator.clipboard.writeText(lines.join('\n'));setCopied(true);}catch{setError(t('Copy is unavailable in this browser.','النسخ غير متاح في هذا المتصفح.'));}
  }
  const time=(value:string)=>new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{timeZone:'Africa/Tripoli',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  const due=board?.board.filter(m=>m.actionable && !m.assignments.length) ?? [];
  const remaining=due.filter(m=>!selected.includes(m.machineId));

  return <main dir={ar?'rtl':'ltr'} className="mx-auto max-w-6xl space-y-5 pb-32">
    <header className="rounded-2xl bg-emerald-950 px-5 py-6 text-white sm:px-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-orange-300">SNACKY · {t('OPERATIONS','التشغيل')}</p>
          <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{t('Today’s work','شغل اليوم')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-emerald-100">{t('See what needs filling. Preview only the machines you can handle now.','شوف الماكينات اللي تحتاج تعبئة، وعاين فقط الماكينات اللي تقدر تخدمها توا.')}</p>
        </div>
        <button onClick={()=>void refresh()} disabled={Boolean(busy)} className="min-h-11 rounded-xl border border-white/30 px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy==='board'?t('Refreshing…','جارٍ التحديث…'):t('Refresh board','تحديث القائمة')}</button>
      </div>
      {board?<p className="mt-4 text-xs text-emerald-200">{t('Board checked','تم فحص القائمة')} {time(board.generatedAt)} · {t('Libya time','بتوقيت ليبيا')}</p>:null}
    </header>

    <section className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
      <strong>{t('Preview release — existing routes remain in control.','نسخة معاينة — الجولات الحالية هي المعتمدة.')}</strong>{' '}
      {t('This screen does not assign machines, reserve goods, or authorize pickup. Use your assigned route to start work.','هذه الشاشة لا تسند ماكينات ولا تحجز منتجات ولا تسمح باستلام المخزون. ابدأ العمل من جولتك المسندة.')}
      <Link href="/operator/routes" className="ms-2 font-semibold underline">{t('My assigned routes','جولاتي المسندة')}</Link>
    </section>
    {error?<div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}<button className="ms-3 font-semibold underline" onClick={()=>void refresh()} disabled={Boolean(busy)}>{t('Refresh','تحديث')}</button></div>:null}

    {board?.myTrips.length?<section aria-label={t('My current trips','جولاتي الحالية')} className="space-y-3">
      <h2 className="text-lg font-semibold">{t('Continue my work','كمّل شغلك')}</h2>
      <div className="grid gap-3 md:grid-cols-2">{board.myTrips.map(trip=><Link key={trip.id} href={`/operator/routes/${trip.id}`} className="rounded-xl border border-emerald-200 bg-white p-4 transition hover:border-emerald-600">
        <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold">{trip.date}</span><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-900">{trip.remaining} {t('remaining','متبقية')}</span></div>
        <p className="mt-2 text-sm text-slate-700">{trip.machineNames.join(' · ')}</p>
        <p className="mt-3 text-sm font-semibold text-emerald-800">{t('Continue assigned trip →','متابعة الجولة المسندة ←')}</p>
      </Link>)}</div>
    </section>:null}

    {board?.dailyCoverage?<DailyCoveragePanel coverage={board.dailyCoverage} selected={selected} locale={locale}/>:null}

    <section className="space-y-3" aria-label={t('Machines needing service','الماكينات المحتاجة تعبئة')}>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('Choose this trip','اختار ماكينات هذه الجولة')}</h2><p className="mt-1 text-sm text-slate-500">{t('Start with one stop. Other machines stay on the board.','ابدأ بماكينة واحدة. باقي الماكينات تبقى في القائمة.')}</p></div>
        <span className="text-sm font-medium text-slate-600">{due.length} {t('need service','تحتاج خدمة')}</span></div>
      {!board && busy==='board'?<div className="rounded-xl border bg-white p-8 text-center text-slate-500" role="status">{t('Checking machine stock and current assignments…','جارٍ فحص المخزون والإسنادات الحالية…')}</div>:null}
      {board && !board.board.length?<div className="rounded-xl border bg-white p-8 text-center text-slate-500">{t('No active machines were returned. This does not mean every machine is full.','لم تظهر ماكينات فعّالة. هذا لا يعني أن كل الماكينات ممتلئة.')}</div>:null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{board?.board.map(machine=>{
        const checked=selected.includes(machine.machineId);
        const unavailable=!machine.openToday || machine.assignments.length>0;
        return <article key={machine.machineId} className={`rounded-xl border-2 bg-white p-4 transition ${checked?'border-emerald-700 shadow-sm':'border-slate-200'}`}>
          <div className="flex items-start gap-3"><input type="checkbox" aria-label={`${t('Select','اختر')} ${machine.name}`} checked={checked}
            disabled={Boolean(busy)||unavailable||(!checked&&selected.length>=6)} onChange={()=>toggle(machine.machineId)} className="mt-1 h-5 w-5 accent-emerald-700"/>
            <div className="min-w-0 flex-1"><h3 className="font-semibold text-slate-950">{machine.name}</h3>
              <span className={`mt-2 inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${badge[machine.priority]}`}>{labels[machine.priority][ar?1:0]}</span></div></div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-slate-50 py-2"><dd className="text-xl font-semibold">{machine.empty}</dd><dt className="text-xs text-slate-500">{t('Empty','فارغة')}</dt></div>
            <div className="rounded-lg bg-slate-50 py-2"><dd className="text-xl font-semibold">{machine.low}</dd><dt className="text-xs text-slate-500">{t('Low','منخفضة')}</dt></div>
            <div className="rounded-lg bg-slate-50 py-2"><dd className="text-xl font-semibold">{machine.meanFullness===null?'—':`${machine.meanFullness}%`}</dd><dt className="text-xs text-slate-500">{t('Lane fullness','امتلاء الفتحات')}</dt></div>
          </dl>
          {machine.unknown>0?<p className="mt-3 text-xs font-medium text-violet-800">{machine.unknown} {t('lanes need checking; unknown is not empty.','فتحات تحتاج تحقق؛ غير المؤكد لا يعني فارغاً.')}</p>:null}
          {!machine.openToday?<p className="mt-3 text-xs font-medium text-slate-600">{t('Closed today — priority is retained.','مغلق اليوم — الأولوية تبقى ظاهرة.')}</p>:null}
          {machine.assignments.map((a,i)=><p key={i} className="mt-3 text-xs font-medium text-emerald-900">{t('Being handled by','يتولاها')} {a.operatorName}{a.routeId?<Link className="ms-2 underline" href={`/operator/routes/${a.routeId}`}>{t('Open trip','فتح الجولة')}</Link>:null}</p>)}
          {!unavailable?<button disabled={Boolean(busy)} onClick={()=>{setSelected([machine.machineId]);setPreview(null);}} className="mt-3 min-h-10 w-full rounded-lg border border-slate-200 text-sm font-medium disabled:opacity-50">{t('Only this machine now','هذه الماكينة فقط توا')}</button>:null}
        </article>;
      })}</div>
    </section>

    <div ref={previewRef} className="scroll-mt-5">{preview?<section className="space-y-4 rounded-2xl border border-emerald-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t('Trip preview','معاينة الجولة')}</h2><p className="mt-1 text-sm text-slate-600">{preview.machines.map(m=>m.name).join(' · ')}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium">{t('Verified rules · no AI sales claims','قواعد محددة · بدون ادّعاء مبيعات ذكية')}</span></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
        [preview.plan.totalUnits,t('Units to take','وحدات مقترحة')],
        [preview.plan.emptyAfter,t('Still empty','تبقى فارغة')],
        [preview.plan.unknownAfter,t('Need verification','تحتاج تحقق')],
        [preview.plan.underfilled,t('Not fully filled','غير ممتلئة بالكامل')],
      ].map(([value,label])=><div key={label} className="rounded-xl bg-slate-50 p-3"><p className="text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-slate-600">{label}</p></div>)}</div>
      {(preview.plan.emptyAfter || preview.plan.unknownAfter || preview.plan.underfilled)?<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">{t('This is not a complete refill. Unavailable goods and unverified replacements stay visible; the planner will not invent stock or assume that a product fits.','هذه ليست تعبئة مكتملة. المنتجات غير المتوفرة والبدائل غير المؤكدة تبقى ظاهرة؛ النظام لا يخترع مخزوناً ولا يفترض ملاءمة المنتج.')}</p>:null}
      <h3 className="font-semibold">{t('Combined pickup list','قائمة الاستلام المجمّعة')}</h3>
      {preview.plan.pickup.length?<div className="divide-y rounded-xl border border-slate-200">{preview.plan.pickup.map(p=><div key={p.productId} className="flex items-center justify-between gap-4 px-4 py-3"><span className="text-sm">{p.productName}</span><strong className="rounded-lg bg-emerald-50 px-3 py-1 text-emerald-950">{p.quantity}</strong></div>)}</div>:<p className="text-sm text-slate-600">{t('No verified items can be allocated from storage.','لا توجد كميات مؤكدة يمكن تخصيصها من المخزن.')}</p>}
      <div className="flex flex-wrap gap-2"><button onClick={()=>void copyList()} className="min-h-11 rounded-xl border px-4 text-sm font-semibold">{copied?t('Copied','تم النسخ'):t('Copy preview','نسخ المعاينة')}</button>{board?.canManage?<Link href="/routes/new" className="inline-flex min-h-11 items-center rounded-xl bg-emerald-800 px-4 text-sm font-semibold text-white">{t('Open existing route builder','فتح إنشاء الجولات الحالي')}</Link>:null}</div>
      {preview.machines.map(m=><details key={m.id} className="rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer font-semibold">{m.name} · {t('Every lane','جميع الفتحات')}</summary><div className="mt-3 divide-y">{preview.plan.lanes.filter(l=>l.machineId===m.id).map(l=><div key={l.code} className="py-3 text-sm"><div className="flex justify-between gap-3"><strong>{t('Lane','الفتحة')} <bdi>{l.code}</bdi> · {l.productName}</strong><span className="shrink-0">+{l.take}</span></div><p className="mt-1 text-xs text-slate-600">{t('After visit','بعد الزيارة')}: {l.after??'?'}/{l.capacity??'?'}{l.remove?` · ${t('Count/remove old units','عدّ وأزل المنتج القديم')}: ${l.remove}`:''}</p><p className="mt-1 text-xs text-slate-500">{l.reason}</p></div>)}</div></details>)}
      <p className="text-xs leading-5 text-slate-500">{t('The preview uses stock available at generation time, minus current route reservations. Recheck before creating a real route. No goods have been reserved here.','المعاينة تستخدم المخزون المتاح وقت الإنشاء بعد خصم حجوزات الجولات. يجب إعادة التحقق عند إنشاء جولة فعلية. لم يتم حجز منتجات هنا.')}</p>
    </section>:null}</div>

    <div className="sticky bottom-3 z-10 rounded-2xl border border-emerald-200 bg-white p-3 shadow-lg sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{selected.length} {t('selected for this preview','محددة لهذه المعاينة')}</p><p className="mt-1 text-xs text-slate-500">{remaining.length} {t('other due machines remain on the board. Nothing is claimed.','ماكينات أخرى تحتاج خدمة تبقى في القائمة. لم يتم إسناد شيء.')}</p></div>
        <button onClick={()=>void generatePreview()} disabled={!selected.length||Boolean(busy)} className="min-h-12 rounded-xl bg-emerald-800 px-6 py-3 font-semibold text-white disabled:opacity-50">{busy==='preview'?t('Checking quantities…','جارٍ فحص الكميات…'):t(`Preview ${selected.length} stop${selected.length===1?'':'s'}`,`معاينة ${selected.length} ماكينات`)}</button></div>
    </div>
  </main>;
}
