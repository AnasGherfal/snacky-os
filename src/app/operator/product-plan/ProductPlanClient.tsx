'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductPlan, PlanReason } from '@/lib/smart-work-product-plan';
type Choice={id:string;machineId:string;name:string;priority:string;dueAt:string|null;mine:boolean;state:string;unavailable:string|null};
type Preview={plan:ProductPlan;machines:{id:string;name:string}[];otherRequired:Choice[];higherPriorityRemaining:boolean;dispatchEnabled:false};
const reasons:Record<PlanReason,[string,string]>={
  stocked:['Already at target','ممتلئة حسب الهدف'],top_up:['Refill the current product','تعبئة المنتج الحالي'],
  approved_replacement:['Approved replacement; count/remove old units, record custody, update XY, then refill. Do not mix products.','بديل معتمد؛ عدّ الوحدات القديمة وأزلها وسجّل عهدتها، ثم حدّث المنتج في XY وعبّئ البديل. لا تخلط المنتجين.'],
  verify_lane:['Verify lane, quantity and capacity','تحقق من الفتحة والكمية والسعة'],missing_mapping:['Product mapping needs review','ربط المنتج يحتاج مراجعة'],
  restricted:['Current product is restricted; no safe replacement allocated','المنتج الحالي ممنوع؛ لم يُخصص بديل آمن'],stock_unknown:['Warehouse quantity could not be verified','لم تُؤكد كمية المخزن'],
  no_compatible_stock:['No available approved product for this lane','لا يوجد منتج معتمد متاح لهذه الفتحة'],insufficient_stock:['Available stock does not reach target','المخزون المتاح لا يكفي للكمية المستهدفة'],
  keep_remaining:['Keep remaining units; no safe complete replacement/top-up available','اترك الوحدات المتبقية؛ لا تتوفر تعبئة أو استبدال كامل آمن'],
};
export default function ProductPlanClient({ar}:{ar:boolean}){
  const t=(en:string,arabic:string)=>ar?arabic:en;
  const [choices,setChoices]=useState<Choice[]>([]),[selected,setSelected]=useState<string[]>([]),[result,setResult]=useState<Preview|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[clock,setClock]=useState(Date.now());
  const generation=useRef(0),pending=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    const key=++generation.current;pending.current?.abort();const controller=new AbortController();pending.current=controller;
    setLoading(true);setBusy(false);setError('');setResult(null);setSelected([]);
    try{const r=await fetch('/api/operator/product-plan',{cache:'no-store',signal:controller.signal});const data=await r.json();
      if(!r.ok)throw new Error(data.error||'Could not load required stops.');if(key!==generation.current)return;setChoices(data.choices);
    }catch(e){if(key===generation.current && !(e instanceof Error&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Could not load.');}
    finally{if(key===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void load();return()=>{generation.current++;pending.current?.abort();};},[load]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),15000);const focus=()=>setClock(Date.now());window.addEventListener('focus',focus);return()=>{clearInterval(timer);window.removeEventListener('focus',focus);};},[]);
  const toggle=(id:string)=>{generation.current++;pending.current?.abort();setBusy(false);setResult(null);setError('');setSelected(previous=>previous.includes(id)?previous.filter(x=>x!==id):previous.length<6?[...previous,id]:previous);};
  const generate=async()=>{
    const key=++generation.current;pending.current?.abort();const controller=new AbortController();pending.current=controller;
    setBusy(true);setError('');setResult(null);
    try{const r=await fetch('/api/operator/product-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dutyIds:selected}),signal:controller.signal,cache:'no-store'});
      const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not prepare a product plan.');if(key!==generation.current)return;setResult(data);setClock(Date.now());
    }catch(e){if(key===generation.current && !(e instanceof Error&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Planning failed.');}
    finally{if(key===generation.current)setBusy(false);}
  };
  const time=(value:string|null)=>value?new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{timeZone:'Africa/Tripoli',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'—';
  const expired=!!result&&clock>=Date.parse(result.plan.expiresAt);
  const status=result?.plan.status;
  return <main dir={ar?'rtl':'ltr'} className="mx-auto max-w-5xl space-y-5 pb-10">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-slate-500">SNACKY · {t('Smart Work','العمل الذكي')}</p><h1 className="mt-1 text-3xl font-bold">{t('Plan products for my next trip','خطة منتجات الجولة القادمة')}</h1></div><Link href="/operator/daily-duties" className="btn-secondary">{t('Required refills','واجبات التعبئة')}</Link></header>
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950"><strong>{t('Product preview only — not pickup permission.','معاينة المنتجات فقط — ليست إذناً بالاستلام.')}</strong>{' '}{t('This does not start a route, reserve goods or change daily responsibilities. Use your existing assigned route for collection.','لا تبدأ هذه الخطوة جولة ولا تحجز منتجات ولا تغيّر المسؤوليات اليومية. استلم المنتجات عبر جولتك المسندة الحالية.')}</div>
    <section className="rounded-2xl border bg-white p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">{t('Select the stops for this trip','اختر محطات هذه الجولة')}</h2><button type="button" className="btn-secondary" disabled={loading||busy} onClick={()=>void load()}>{t('Reload duties','إعادة تحميل الواجبات')}</button></div>
      <p className="my-3 text-sm font-medium text-slate-600">{selected.length} {t('selected for preview','مختارة للمعاينة')} · {choices.length-selected.length} {t('other duties remain required','واجبات أخرى تبقى مطلوبة')}</p>
      {loading?<p role="status">{t('Loading required stops…','جارٍ تحميل المحطات المطلوبة…')}</p>:!choices.length?<p className="text-sm leading-6">{t('No saved duties are available in your scope. Open Required refills to refresh them; missing coverage settings may leave machines unassigned.','لا توجد واجبات محفوظة متاحة لك. افتح واجبات التعبئة لتحديثها؛ قد تبقى الأجهزة دون مسؤول إذا لم تُحدد إعدادات التغطية.')}</p>:<div className="grid gap-2 sm:grid-cols-2">{choices.map(c=><label key={c.id} className={`flex min-h-20 items-start gap-3 rounded-xl border p-3 ${selected.includes(c.id)?'border-emerald-600 bg-emerald-50':'border-slate-200'} ${c.unavailable?'opacity-65':''}`}><input type="checkbox" className="mt-1 h-5 w-5" checked={selected.includes(c.id)} disabled={!!c.unavailable||(!selected.includes(c.id)&&selected.length>=6)} onChange={()=>toggle(c.id)}/><span className="min-w-0"><strong className="block break-words">{c.name}</strong><span className="mt-1 block text-xs text-slate-600">{c.priority==='immediate'?t('Immediate','فوري'):c.priority==='urgent'?t('Urgent','عاجل'):t('Today','اليوم')} · {time(c.dueAt)}</span>{c.unavailable?<span className="mt-1 block text-xs text-amber-900">{c.unavailable==='existing_route'?t('Already on a route — use that pickup list','على جولة حالية — استخدم قائمة تحميلها'):t('Resolve the current duty or machine issue first','عالج حالة الواجب أو الجهاز أولاً')}</span>:null}</span></label>)}</div>}
      <button type="button" onClick={()=>void generate()} disabled={!selected.length||loading||busy} className="btn-primary mt-4 min-h-12 w-full">{busy?t('Calculating verified quantities…','جارٍ حساب الكميات المؤكدة…'):t('Generate product preview','إنشاء معاينة المنتجات')}</button>
    </section>
    {error?<div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div>:null}
    {result?<>
      <section aria-live="polite" className={`rounded-2xl border p-4 ${status==='complete'&&!expired?'border-emerald-200 bg-emerald-50':'border-amber-200 bg-amber-50'}`}>
        <h2 className="font-bold">{expired?t('Preview expired — regenerate before using quantities','انتهت صلاحية المعاينة — أعد حساب الكميات'):status==='complete'?t('All lane targets covered in this preview','جميع أهداف الفتحات مغطاة في هذه المعاينة'):status==='nothing_to_load'?t('No products need loading from these readings','لا تحتاج هذه القراءات إلى تحميل منتجات'):t('Incomplete coverage — review the exceptions','التغطية غير مكتملة — راجع الاستثناءات')}</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{[[result.plan.totalUnits,t('Units to prepare','وحدات للتجهيز')],[result.plan.emptyAfter,t('Still empty','ستبقى فارغة')],[result.plan.underfilled,t('Below target','أقل من الهدف')],[result.plan.unknownAfter,t('Need verification','تحتاج تحقق')]].map(([n,label])=><div key={label}><strong className="text-2xl tabular-nums">{n}</strong><div className="text-xs">{label}</div></div>)}</div>
        <p className="mt-3 text-xs">{t('Calculated','حُسبت')}: {time(result.plan.generatedAt)} · {t('Latest validity','صالحة حتى')}: {time(result.plan.expiresAt)}</p>
        {result.higherPriorityRemaining?<p className="mt-2 font-semibold text-red-900">{t('Higher-priority work remains outside this preview. It has not been waived or reassigned.','توجد أعمال أعلى أولوية خارج هذه المعاينة. لم تُلغَ ولم تُنقل مسؤوليتها.')}</p>:null}
      </section>
      <section className="rounded-2xl border bg-white p-4"><h2 className="font-bold">{t('Combined product list','قائمة المنتجات المجمعة')}</h2><p className="mt-1 text-xs text-slate-500">{t('Chips → Chocolate → Candy → Drinks → Water. Availability is a snapshot after active route reservations.','تشيبس ← شوكولاتة ← حلويات ← مشروبات ← مياه. المتاح لقطة بعد حجوزات الجولات النشطة.')}</p>
        <div className="mt-3 divide-y">{result.plan.pickup.map(p=><div key={p.productId} className="flex items-center justify-between gap-4 py-3"><div><strong>{p.productName}</strong><div className="text-xs text-slate-500">{t('Available at calculation','المتاح عند الحساب')}: {p.available}</div></div><strong className="text-xl tabular-nums">× {p.quantity}</strong></div>)}</div>
        {!result.plan.pickup.length?<p className="mt-3 text-sm">{t('No verified products allocated. Review lane exceptions below.','لم تُخصص منتجات مؤكدة. راجع استثناءات الفتحات أدناه.')}</p>:null}
      </section>
      {result.machines.map(m=><details key={m.id} open className="rounded-2xl border bg-white p-4"><summary className="cursor-pointer text-lg font-bold">{m.name} · {result.plan.lanes.filter(l=>l.machineId===m.id).length} {t('lanes','فتحات')}</summary><div className="mt-3 grid gap-2 sm:grid-cols-2">{result.plan.lanes.filter(l=>l.machineId===m.id).map(l=><div key={l.code} className={`rounded-xl border p-3 text-sm ${l.action==='exception'||l.after===0?'border-amber-300 bg-amber-50':'border-slate-200'}`}><div className="flex justify-between gap-2"><strong>{t('Lane','الفتحة')} {l.code}</strong><strong>+{l.take}</strong></div><p className="mt-1 break-words">{l.productName||t('Unmapped product','منتج غير مربوط')}</p><p className="mt-1 text-xs text-slate-600">{t('Now','الآن')}: {l.current??'—'} · {t('After planned visit','بعد الزيارة المخططة')}: {l.after??'—'} / {l.target??'—'}</p>
        {l.action==='replace'?<p className="mt-2 font-medium text-amber-900">{l.originalName} → {l.productName}{l.removeExpected>0?` · ${t('Expected old units to remove','وحدات قديمة متوقع إزالتها')}: ${l.removeExpected}`:''}</p>:null}
        <p className="mt-2 text-xs leading-5">{reasons[l.reason][ar?1:0]}</p></div>)}</div></details>)}
      {result.plan.errors.length?<div className="rounded-xl bg-red-50 p-4 text-sm text-red-900">{result.plan.errors.map(e=><p key={e}>{e}</p>)}</div>:null}
      <section className="rounded-xl border border-slate-200 p-4"><h2 className="font-bold">{t('Still required after this selected trip','ما زال مطلوباً بعد هذه الجولة المختارة')}: {result.otherRequired.length}</h2><p className="mt-2 text-sm">{result.otherRequired.map(d=>d.name).join(' · ')||t('No other saved duties in this view.','لا توجد واجبات محفوظة أخرى في هذا العرض.')}</p><p className="mt-2 text-xs text-slate-500">{t('No responsibilities or deadlines were changed. This is not a completed service record.','لم تتغير المسؤوليات أو المواعيد. هذه ليست وثيقة تعبئة مكتملة.')}</p></section>
    </>:null}
  </main>;
}
