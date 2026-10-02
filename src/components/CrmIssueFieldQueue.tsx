'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

type OperatorOption={id:string;name:string};

export function CrmIssueFieldQueueForm({
 issueId,
 priority,
 operators,
 ar,
}:{issueId:string;priority:string;operators:OperatorOption[];ar:boolean}){
 const router=useRouter();
 const [operatorId,setOperatorId]=useState(operators[0]?.id??'');
 const [notes,setNotes]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');

 async function submit(){
  if(busy||!operatorId)return;
  setBusy(true);setError('');
  try{
   const response=await fetch('/api/crm/field-queue',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
     action:'create',
     issue_id:issueId,
     payload:{notes,priority,operator_id:operatorId},
    }),
   });
   const result=await response.json();
   if(!response.ok||result?.ok!==true){
    setError(result?.message||(ar?'تعذر إسناد الإجراء الميداني.':'Could not assign the field action.'));
    return;
   }
   setNotes('');
   router.refresh();
  }catch{
   setError(ar?'تعذر الاتصال حالياً.':'Could not connect right now.');
  }finally{
   setBusy(false);
  }
 }

 return <section className="surface-card space-y-3">
  <div>
   <h2 className="font-semibold">{ar?'إسناد إجراء ميداني':'Assign field action'}</h2>
   <p className="mt-1 text-sm text-slate-600">
    {ar
     ?'اختر المشغّل الذي سيزور الماكينة. علاقات العملاء تبقى مسؤولة عن البلاغ والتواصل مع العميل والإغلاق.'
     :'Choose the operator who should visit the machine. Customer Relations keeps ownership of the complaint, customer communication, and closure.'}
   </p>
  </div>

  {operators.length?<>
   <label className="block text-sm font-medium">
    {ar?'المشغّل':'Operator'}
    <select className="field-input mt-1" value={operatorId} onChange={e=>setOperatorId(e.target.value)}>
     {operators.map(operator=><option key={operator.id} value={operator.id}>{operator.name}</option>)}
    </select>
   </label>
   <label className="block text-sm font-medium">
    {ar?'تعليمات للمشغّل (اختياري)':'Instructions for the operator (optional)'}
    <textarea className="field-input mt-1" rows={3} maxLength={2000} value={notes} onChange={e=>setNotes(e.target.value)} />
   </label>
   {error?<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>:null}
   <button className="btn-primary" disabled={busy||!operatorId} onClick={()=>void submit()}>
    {busy?(ar?'جارٍ الإسناد…':'Assigning…'):(ar?'إسناد للمشغّل':'Assign to operator')}
   </button>
  </>:<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
   {ar?'لا يوجد مشغّل نشط متاح للإسناد حالياً.':'No active operator is available for assignment right now.'}
  </p>}
 </section>;
}
