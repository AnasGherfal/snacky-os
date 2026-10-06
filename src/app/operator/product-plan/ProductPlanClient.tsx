'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductPlan, PlanReason } from '@/lib/smart-work-product-plan';
type Choice={id:string;machineId:string;name:string;priority:string;dueAt:string|null;mine:boolean;state:string;unavailable:string|null};
type Preview={plan:ProductPlan;machines:{id:string;name:string}[];otherRequired:Choice[];higherPriorityRemaining:boolean;inputFingerprint:string;dispatchEnabled:false};
type DispatchAvailability={enabled:boolean;reason:string};
type StartedTrip={routeId:string;href:string;stopCount:number;reservedUnits:number;replayed:boolean};
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
  const [dispatch,setDispatch]=useState<DispatchAvailability>({enabled:false,reason:'checking'}),[starting,setStarting]=useState(false),[startError,setStartError]=useState('');
  const generation=useRef(0),pending=useRef<AbortController|null>(null),startRequest=useRef<{requestId:string;fingerprint:string;dutyIds:string[]}|null>(null);
  const load=useCallback(async()=>{
    const key=++generation.current;pending.current?.abort();const controller=new AbortController();pending.current=controller;
    setLoading(true);setBusy(false);setError('');setStartError('');setStarting(false);setResult(null);setSelected([]);startRequest.current=null;
    try{const r=await fetch('/api/operator/product-plan',{cache:'no-store',signal:controller.signal});const data=await r.json();
      if(!r.ok)throw new Error(data.error||'Could not load required stops.');if(key!==generation.current)return;setChoices(data.choices);
    }catch(e){if(key===generation.current && !(e instanceof Error&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Could not load.');}
    finally{if(key===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void load();return()=>{generation.current++;pending.current?.abort();};},[load]);
  useEffect(()=>{let live=true;void fetch('/api/operator/start-trip',{cache:'no-store'}).then(async r=>{const data=await r.json();if(live)setDispatch(r.ok&&typeof data?.enabled==='boolean'?data:{enabled:false,reason:'unavailable'});}).catch(()=>{if(live)setDispatch({enabled:false,reason:'unavailable'});});return()=>{live=false;};},[]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),15000);const focus=()=>setClock(Date.now());window.addEventListener('focus',focus);return()=>{clearInterval(timer);window.removeEventListener('focus',focus);};},[]);
  const toggle=(id:string)=>{generation.current++;pending.current?.abort();setBusy(false);setStarting(false);setResult(null);setError('');setStartError('');startRequest.current=null;setSelected(previous=>previous.includes(id)?previous.filter(x=>x!==id):previous.length<6?[...previous,id]:previous);};
  const generate=async()=>{
    const key=++generation.current;pending.current?.abort();const controller=new AbortController();pending.current=controller;
    setBusy(true);setStarting(false);setError('');setStartError('');setResult(null);startRequest.current=null;
    try{const r=await fetch('/api/operator/product-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dutyIds:selected}),signal:controller.signal,cache:'no-store'});
      const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not prepare a product plan.');if(key!==generation.current)return;setResult(data);setClock(Date.now());
    }catch(e){if(key===generation.current && !(e instanceof Error&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Planning failed.');}
    finally{if(key===generation.current)setBusy(false);}
  };
  const startTrip=async()=>{
    if(!result||starting)return;
    const dutyIds=[...selected],fingerprint=result.inputFingerprint;
    let request=startRequest.current;
    if(!request||request.fingerprint!==fingerprint||JSON.stringify(request.dutyIds)!==JSON.stringify(dutyIds)){
      request={requestId:crypto.randomUUID(),fingerprint,dutyIds};startRequest.current=request;
    }
    setStarting(true);setStartError('');
    try{
      const r=await fetch('/api/operator/start-trip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dutyIds:request.dutyIds,inputFingerprint:request.fingerprint,requestId:request.requestId}),cache:'no-store'});
      const data=await r.json() as StartedTrip&{error?:string;retryable?:boolean};
      if(!r.ok){
        if(!data.retryable)startRequest.current=null;
        throw new Error(data.error||t('Could not start this trip.','تعذر بدء هذه الجولة.'));
      }
      if(!data.href||!data.routeId)throw new Error(t('Trip saved but confirmation is incomplete. Retry with the same button.','تم حفظ الجولة لكن التأكيد غير مكتمل. أعد المحاولة بنفس الزر.'));
      window.location.assign(data.href);
    }catch(e){setStartError(e instanceof Error?e.message:t('Could not start this trip.','تعذر بدء هذه الجولة.'));setStarting(false);}
  };
  const time=(value:string|null)=>value?new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{timeZone:'Africa/Tripoli',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'—';
  const expired=!!result&&clock>=Date.parse(result.plan.expiresAt);
  const status=result?.plan.status;
  const selectedChoices=selected.map(id=>choices.find(c=>c.id===id)).filter((c):c is Choice=>Boolean(c));
  const allSelectedMine=selectedChoices.length===selected.length&&selectedChoices.every(c=>c.mine);
  const unsafeReasons=new Set<PlanReason>(['verify_lane','missing_mapping','restricted','stock_unknown']);
  const shortageSafe=Boolean(result&&['complete','partial'].includes(status||'')&&result.plan.unknownAfter===0&&!result.plan.errors.length
    &&result.plan.lanes.every(l=>l.after!==null&&l.action!=='exception'&&!unsafeReasons.has(l.reason)));
  const canStart=Boolean(result&&dispatch.enabled&&shortageSafe&&!expired&&!result.higherPriorityRemaining&&allSelectedMine&&result.plan.totalUnits>0);
  return <main dir={ar?'rtl':'ltr'} className="mx-auto max-w-5xl space-y-5 pb-10">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-slate-500">SNACKY · {t('Smart Work','العمل الذكي')}</p><h1 className="mt-1 text-3xl font-bold">{t('Plan products for my next trip','خطة منتجات الجولة القادمة')}</h1></div><Link href="/operator/daily-duties" className="btn-secondary">{t('Required refills','واجبات التعبئة')}</Link></header>
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950"><strong>{t('Preview first, then Start Trip.','عاين أولاً، ثم ابدأ الجولة.')}</strong>{' '}{t('Generating a preview changes nothing. When Start Trip is enabled and every safety check passes, starting creates the selected assigned route and reserves its products; pickup still happens through the normal route pickup flow.','إنشاء المعاينة لا يغيّر شيئاً. عند تفعيل بدء الجولة واجتياز كل فحوصات الأمان، يبدأ النظام الجولة المختارة ويحجز منتجاتها؛ ويبقى الاستلام عبر مسار استلام الجولة المعتاد.')}</div>
    <section className="rounded-2xl border bg-white p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">{t('Select the stops for this trip','اختر محطات هذه الجولة')}</h2><button type="button" className="btn-secondary" disabled={loading||busy} onClick={()=>void load()}>{t('Reload duties','إعادة تحميل الواجبات')}</button></div>
      <p className="my-3 text-sm font-medium text-slate-600">{selected.length} {t('selected for preview','مختارة للمعاينة')} · {choices.length-selected.length} {t('other duties remain required','واجبات أخرى تبقى مطلوبة')}</p>
      {loading?<p role="status">{t('Loading required stops…','جارٍ تحميل المحطات المطلوبة…')}</p>:!choices.length?<p className="text-sm leading-6">{t('No saved duties are available in your scope. Open Required refills to refresh them; missing coverage settings may leave machines unassigned.','لا توجد واجبات محفوظة متاحة لك. افتح واجبات التعبئة لتحديثها؛ قد تبقى الأجهزة دون مسؤول إذا لم تُحدد إعدادات التغطية.')}</p>:<div className="grid gap-2 sm:grid-cols-2">{choices.map(c=><label key={c.id} className={`flex min-h-20 items-start gap-3 rounded-xl border p-3 ${selected.includes(c.id)?'border-emerald-600 bg-emerald-50':'border-slate-200'} ${c.unavailable?'opacity-65':''}`}><input type="checkbox" className="mt-1 h-5 w-5" checked={selected.includes(c.id)} disabled={!!c.unavailable||(!selected.includes(c.id)&&selected.length>=6)} onChange={()=>toggle(c.id)}/><span className="min-w-0"><strong className="block break-words">{c.name}</strong><span className="mt-1 block text-xs text-slate-600">{c.priority==='immediate'?t('Immediate','فوري'):c.priority==='urgent'?t('Urgent','عاجل'):t('Today','اليوم')} · {time(c.dueAt)}</span>{c.unavailable?<span className="mt-1 block text-xs text-amber-900">{c.unavailable==='existing_route'?t('Already on a route — use that pickup list','على جولة حالية — استخدم قائمة تحميلها'):t('Resolve the current duty or machine issue first','عالج حالة الواجب أو الجهاز أولاً')}</span>:null}</span></label>)}</div>}
      <button type="button" onClick={()=>void generate()} disabled={!selected.length||loading||busy} className="btn-primary mt-4 min-h-12 w-full">{busy?t('Calculating verified quantities…','جارٍ حساب الكميات المؤكدة…'):t('Generate product preview','إنشاء معاينة المنتجات')}</button>
    </section>
    {error?<div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div>:null}
    {result?<>
      <section aria-live="polite" className={`rounded-2xl border p-4 ${status==='complete'&&!expired?'border-emerald-200 bg-emerald-50':'border-amber-200 bg-amber-50'}`}>
        <h2 className="font-bold">{expired?t('Preview expired — regenerate before using quantities','انتهت صلاحية المعاينة — أعد حساب الكميات'):status==='complete'?t('All lane targets covered in this preview','جميع أهداف الفتحات مغطاة في هذه المعاينة'):status==='partial'&&shortageSafe?t('Safe partial trip — known stock shortages remain visible','جولة جزئية آمنة — نواقص المخزون المعروفة ستبقى ظاهرة'):status==='nothing_to_load'?t('No products need loading from these readings','لا تحتاج هذه القراءات إلى تحميل منتجات'):t('Incomplete coverage — review the exceptions','التغطية غير مكتملة — راجع الاستثناءات')}</h2>
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
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
        <h2 className="font-bold">{t('Start this trip','ابدأ هذه الجولة')}</h2>
        {!dispatch.enabled?<p className="mt-2 text-sm text-slate-700">{t(dispatch.reason==='not_in_pilot'?'Start Trip is currently limited to the controlled pilot.':'Start Trip is still behind the release switch. This preview cannot create or reserve a route yet.','بدء الجولة متاح حالياً فقط ضمن الاختبار المحدود.')}</p>:expired?<p className="mt-2 text-sm text-amber-900">{t('The preview expired. Generate it again before starting.','انتهت صلاحية المعاينة. أعد إنشاءها قبل بدء الجولة.')}</p>:!shortageSafe?<p className="mt-2 text-sm text-amber-900">{t('Unknown, unmapped, restricted or unverifiable lanes must be resolved before starting. Known warehouse shortages may remain visible in a safe partial trip.','يجب حل الفتحات غير المعروفة أو غير المربوطة أو الممنوعة أو غير القابلة للتحقق قبل البدء. يمكن أن تبقى نواقص المخزون المعروفة ظاهرة في جولة جزئية آمنة.')}</p>:result.higherPriorityRemaining?<p className="mt-2 text-sm text-red-900">{t('Higher-priority required work remains. Select that work first or record why it cannot be handled.','ما زال هناك عمل مطلوب بأولوية أعلى. اختره أولاً أو سجّل سبب تعذر تنفيذه.')}</p>:!allSelectedMine?<p className="mt-2 text-sm text-amber-900">{t('Only the operator responsible for these duties can start this trip.','فقط المشغل المسؤول عن هذه الواجبات يمكنه بدء الجولة.')}</p>:status==='partial'?<p className="mt-2 text-sm font-medium text-amber-900">{t('This trip will reserve every safe available item. Lanes still short of stock stay listed in the route and the duty remains unresolved until the machine is actually healthy.','ستحجز الجولة كل المنتجات الآمنة المتاحة. الفتحات التي ينقصها مخزون ستبقى ظاهرة في الجولة، وسيظل الواجب مفتوحاً حتى تصبح الماكينة بحالة جيدة فعلياً.')}</p>:null}
        {startError?<div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{startError}</div>:null}
        <button type="button" onClick={()=>void startTrip()} disabled={!canStart||starting} className="btn-primary mt-4 min-h-12 w-full">
          {starting?t('Starting safely…','جارٍ بدء الجولة بأمان…'):t('Start Trip & reserve products','ابدأ الجولة واحجز المنتجات')}
        </button>
        <p className="mt-2 text-xs text-slate-600">{t('Starting reserves the planned stock but does not deduct it from storage. Stock is deducted only when pickup is confirmed in the route.','بدء الجولة يحجز المخزون المخطط ولا يخصمه من المخزن. يتم الخصم فقط عند تأكيد الاستلام داخل الجولة.')}</p>
      </section>
      <section className="rounded-xl border border-slate-200 p-4"><h2 className="font-bold">{t('Still required after this selected trip','ما زال مطلوباً بعد هذه الجولة المختارة')}: {result.otherRequired.length}</h2><p className="mt-2 text-sm">{result.otherRequired.map(d=>d.name).join(' · ')||t('No other saved duties in this view.','لا توجد واجبات محفوظة أخرى في هذا العرض.')}</p><p className="mt-2 text-xs text-slate-500">{t('No responsibilities or deadlines were changed. This is not a completed service record.','لم تتغير المسؤوليات أو المواعيد. هذه ليست وثيقة تعبئة مكتملة.')}</p></section>
    </>:null}
  </main>;
}
