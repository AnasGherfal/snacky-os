'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';

export function CrmIssueFieldQueueForm({issueId,priority,ar}:{issueId:string;priority:string;ar:boolean}){
 const router=useRouter();
 const [notes,setNotes]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(){
  if(busy)return;setBusy(true);setError('');
  try{
   const response=await fetch('/api/crm/field-queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',issue_id:issueId,payload:{notes,priority}})});
   const result=await response.json();
   if(!response.ok||result?.ok!==true){setError(result?.message|| (ar?'تعذر إرسال البلاغ للمشغّلين.':'Could not send the issue to operators.'));return;}
   setNotes('');router.refresh();
  }catch{setError(ar?'تعذر الاتصال حالياً.':'Could not connect right now.');}
  finally{setBusy(false);}
 }
 return <section className="surface-card space-y-3">
  <div>
   <h2 className="font-semibold">{ar?'إرسال للمشغّلين':'Send to operator queue'}</h2>
   <p className="mt-1 text-sm text-slate-600">{ar?'لا تختار مشغّلاً. يصل البلاغ لكل المشغّلين المتاحين، وأول شخص يستلمه يصبح مسؤولاً عن الزيارة والإصلاح.':'Do not choose an operator. The issue is offered to all active operators; the first person to claim it owns the visit and repair.'}</p>
  </div>
  <label className="block text-sm font-medium">{ar?'تعليمات إضافية (اختياري)':'Extra instructions (optional)'}<textarea className="field-input mt-1" rows={3} maxLength={2000} value={notes} onChange={e=>setNotes(e.target.value)} /></label>
  {error?<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>:null}
  <button className="btn-primary" disabled={busy} onClick={()=>void submit()}>{busy?(ar?'جارٍ الإرسال…':'Sending…'):(ar?'إشعار المشغّلين':'Notify operators')}</button>
 </section>;
}

export function OperatorIssueClaimButton({taskId,ar=false}:{taskId:string;ar?:boolean}){
 const router=useRouter();
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function claim(){
  if(busy)return;setBusy(true);setError('');
  try{
   const response=await fetch('/api/crm/field-queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'claim',task_id:taskId,payload:{}})});
   const result=await response.json();
   if(!response.ok||result?.ok!==true){setError(result?.message|| (ar?'ربما استلمها مشغّل آخر.':'Another operator may have claimed it.'));return;}
   router.refresh();
  }catch{setError(ar?'تعذر الاتصال حالياً.':'Could not connect right now.');}
  finally{setBusy(false);}
 }
 return <div className="space-y-2"><button className="btn-primary min-h-11" disabled={busy} onClick={()=>void claim()}>{busy?(ar?'جارٍ الاستلام…':'Claiming…'):(ar?'استلام البلاغ':'Claim issue')}</button>{error?<p role="alert" className="text-xs text-rose-700">{error}</p>:null}</div>;
}
