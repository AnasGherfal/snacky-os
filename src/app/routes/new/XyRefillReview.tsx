'use client';

import { useState } from 'react';
import { useLanguage } from '@/components/I18nProvider';
import type { XyEvidencePlan, XyRefillResult } from '@/lib/xy-refill-evidence';

type Result = { audit: XyRefillResult; machineNames: Record<string,string> };
type Props = {
 machineIds: string[];
 plannedItems: XyEvidencePlan[];
 fingerprint: string;
 smartPlanRequired: boolean;
 approvedFingerprint: string | null;
 onApprove: (fingerprint:string)=>void;
 onUsePrior: (machineId:string,productId:string,quantity:number)=>void;
 disabled?: boolean;
};
export function XyRefillReview({machineIds,plannedItems,fingerprint,smartPlanRequired,approvedFingerprint,onApprove,onUsePrior,disabled}:Props){
 const {locale}=useLanguage();const ar=locale==='ar';
 const [working,setWorking]=useState(false);
 const [error,setError]=useState('');
 const [result,setResult]=useState<Result|null>(null);
 const [evidenceFingerprint,setEvidenceFingerprint]=useState('');
 const same=result!==null&&fingerprint===evidenceFingerprint;
 const approved=same&&approvedFingerprint===fingerprint;
 const blocked=result?.audit.machines.some(m=>m.status==='blocked')??false;
 const canApprove=same&&!blocked&&machineIds.length>0;
 const reload=async()=>{
  if(working||!machineIds.length)return;
  setWorking(true);setError('');setResult(null);setEvidenceFingerprint('');
  const requested=fingerprint;
  try{
   const response=await fetch('/api/routes/xy-review',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({machineIds,plannedItems}),cache:'no-store',signal:AbortSignal.timeout(20000)});
   const body=await response.json().catch(()=>({error:'Invalid XY audit response.'}));
   if(!response.ok||!body.audit)throw new Error(body.error??'XY evidence unavailable.');
   setResult(body as Result);setEvidenceFingerprint(requested);
  }catch(e){setError(e instanceof Error?e.message:'Could not verify XY.');}
  finally{setWorking(false)};
 };
 const total=result?.audit.machines.reduce((s,m)=>s+m.plannedTotal,0)??0;
 return <section className="rounded-2xl border border-sky-200 bg-white p-4 shadow-sm" aria-label="XY evidence and owner's plan comparison">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div>
    <h3 className="text-base font-semibold text-slate-950">{ar?'مراجعة XY: الناقص والإضافي':'XY check: missing vs extra'}</h3>
    <p className="mt-1 max-w-3xl text-sm text-slate-600">
     {ar?'XY يعرض الناقص الحقيقي حسب الفتحات. نعرض الإضافي اللي اخترته منفصل، وآخر كمية خططتها لنفس الجهاز. الكمية السابقة مش دليل أن المنتج ركب فعلاً. لا يتغير المخزون عند المراجعة.':'See exact missing units in the latest XY slots, then compare what you selected, any additional units and your previous route quantity. Historical plans do not prove physical fit. This check never moves stock.'}
    </p>
   </div>
   <button type="button" className="btn-secondary" onClick={()=>void reload()} disabled={working||disabled||!machineIds.length}>
     {working?(ar?'جاري فحص XY…':'Checking XY…'):(ar?'تحقق من XY الآن':'Check latest saved XY')}
   </button>
  </div>
  {error?<p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{error} {ar?'لا تعتمد على كميات ناقصة.':'No partial quantities are used.'}</p>:null}
  {result&&!same?<div role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    {ar?'غيّرت المنتجات أو الكميات بعد الفحص؛ اضغط تحقق مرة ثانية قبل اعتماد الخطة.':'You changed the products or quantities since the check. Recheck XY before approving this plan.'}
   </div>:null}
  {result&&same?<div className="mt-4 space-y-4">
    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-700"><strong>{ar?`مخطط: ${total} قطعة`:`Planned: ${total} units`}</strong>
     <span>{ar?`آخر فحص: ${new Date(result.audit.generatedAt).toLocaleString('ar-LY')}`:`Checked: ${new Date(result.audit.generatedAt).toLocaleString()}`}</span>
     <span className={`rounded-full px-2 py-1 font-semibold ${blocked?'bg-rose-100 text-rose-800':'bg-sky-100 text-sky-900'}`}>
      {blocked?(ar?'بيانات ناقصة — لا تعتمد آلياً':'Incomplete evidence — do not auto-approve'):(ar?'قابل للمراجعة':'Reviewable')}
     </span>
    </div>
    {result.audit.machines.map(m=><div key={m.machineId} className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
       <div className="font-semibold text-slate-900">{result.machineNames[m.machineId]??m.machineId}</div>
       <div className="text-xs text-slate-600">
        {ar?`الناقص من XY: ${m.totalMissing??'غير مؤكد'} · المختار: ${m.plannedTotal}`:`XY missing: ${m.totalMissing??'unverified'} · selected: ${m.plannedTotal}`} · {m.ageHours===null?'—':`${m.ageHours}h`}
       </div>
      </div>
      {m.warnings.length?<div className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" role="status">
        {m.warnings.join(' • ')}
      </div>:null}
      <div className="mt-3 overflow-x-auto"><table className="min-w-[650px] w-full text-start text-xs">
       <thead><tr className="border-b border-slate-200 text-slate-600">
        <th className="px-2 py-2 text-start">{ar?'المنتج':'Product'}</th><th className="px-2 py-2 text-end">{ar?'داخل XY':'XY current'}</th>
        <th className="px-2 py-2 text-end">{ar?'السعة':'XY capacity'}</th><th className="px-2 py-2 text-end">{ar?'الناقص':'Missing'}</th>
        <th className="px-2 py-2 text-end">{ar?'مخطط':'Selected'}</th><th className="px-2 py-2 text-end">{ar?'إضافي':'Extra'}</th>
        <th className="px-2 py-2 text-end">{ar?'آخر خطة':'Prior plan'}</th><th className="px-2 py-2 text-end">{ar?'المخزن المتاح':'MAIN available'}</th>
       </tr></thead>
       <tbody>{m.lines.filter(row=>row.selectedQty>0||(row.xyMissing??0)>0||row.issues.length).map(row=><tr key={row.productId} className="border-b border-slate-100 align-top">
        <td className="px-2 py-2 font-medium text-slate-900">{row.productName}<div className="font-normal text-[10px] text-slate-500">{row.laneCodes.join(', ')||'No mapped lane'}</div>
         {row.issues.length?<div className="mt-1 text-[11px] text-amber-800">{row.issues.join(' • ')}</div>:null}</td>
        {[row.xyCurrent,row.xyCapacity,row.xyMissing,row.selectedQty,row.extraAboveXy].map((v,i)=><td key={i} className={`px-2 py-2 text-end tabular-nums ${i===4&&(v??0)>0?'font-semibold text-amber-800':''}`}>{v??'—'}</td>)}
        <td className="px-2 py-2 text-end tabular-nums">{row.previousPlanned??'—'}
         {row.previousPlanned!==null&&row.previousPlanned>0&&row.previousEdited&&row.previousPlanned!==row.selectedQty&&row.stockAvailable!==null&&row.previousPlanned<=row.stockAvailable?
           <button type="button" className="mt-1 block ms-auto rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-700 disabled:opacity-40" disabled={disabled} onClick={()=>onUsePrior(m.machineId,row.productId,row.previousPlanned!)}>{ar?'استخدم السابق':'Use prior'}</button>:null}
         {row.previousPlanned!==null?<div className="text-[10px] text-slate-500">{row.previousIsCompleted?(ar?'الجولة اكتملت':'Completed route'):(ar?'خطة غير منفذة':'Not confirmed filled')}</div>:null}
        </td>
        <td className="px-2 py-2 text-end tabular-nums">{row.stockAvailable??'—'}</td>
       </tr>)}</tbody>
      </table></div>
     </div>)}
     <p className="text-xs text-slate-600">{ar?'أي كمية أعلى من الناقص في XY تتطلب مكاناً فعلياً مؤكداً أو موافقة واعية؛ لا تعني أن الفتحة تستوعبها.':'Above-XY quantities require a physically confirmed lane or explicit owner decision; a historical planned quantity does not establish machine capacity.'}</p>
     {smartPlanRequired?<div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
       <button type="button" onClick={()=>onApprove(fingerprint)} disabled={!canApprove||disabled||approved} className="btn-primary">
         {approved?(ar?'تم اعتماد المراجعة':'Review acknowledged'):(ar?'راجعت الناقص والإضافي وأؤكد الخطة':'I reviewed missing and extra quantities')}
       </button>
       {blocked?<p className="mt-2 text-xs text-rose-800">{ar?'فيه بيانات XY أو مخزون غير مؤكدة. حدّثها أو استخدم تخطيط يدوي واضح بدل تخطيط آلي.':'XY/stock evidence is incomplete. Refresh it, or deliberately switch to manual planning instead of approving AI blindly.'}</p>:null}
     </div>:null}
  </div>:null}
  {!result&&smartPlanRequired?<p className="mt-3 text-xs font-medium text-amber-800">{ar?'يجب مراجعة فحص XY قبل اعتماد مسودة الذكاء الاصطناعي.':'AI drafts require this XY check before you can create the route.'}</p>:null}
 </section>;
}
