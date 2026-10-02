'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

type Person={id:string;name:string;role?:string};
type Props={
 obligationId:string;
 assignedTo:string;
 periodStart:string;
 periodEnd:string;
 version:string;
 directory:Person[];
 ar:boolean;
};

const monthValue=(value:string)=>/^\d{4}-\d{2}/.test(value)?value.slice(0,7):'';

export function CrmObligationAdminForm(props:Props){
 const router=useRouter();
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const tr=(en:string,arabic:string)=>props.ar?arabic:en;
 const people=props.directory.filter(person=>person.role!=='operator');

 async function submit(formData:FormData){
  if(busy)return;
  setBusy(true);setMessage('');
  const payload={
   obligation_id:props.obligationId,
   assigned_to:String(formData.get('assigned_to')||''),
   period_start:String(formData.get('period_start')||''),
   period_end:String(formData.get('period_end')||''),
   version:props.version,
  };
  try{
   const response=await fetch('/api/crm/obligation-admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const data=await response.json().catch(()=>({}));
   if(!response.ok||data.ok!==true)throw new Error(data.message||data.code||'save_failed');
   setMessage(tr('Saved. Responsibility and rent period are updated.','تم الحفظ. تم تحديث المسؤول وفترة الإيجار.'));
   router.refresh();
  }catch(error){
   setMessage(error instanceof Error&&error.message!=='save_failed'?error.message:tr('Could not save. Reload and try again.','تعذر الحفظ. أعد تحميل الصفحة وحاول مرة أخرى.'));
  }finally{setBusy(false);}
 }

 return <form action={submit} className="space-y-4">
  {message?<p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{message}</p>:null}
  <div className="grid gap-4 sm:grid-cols-3">
   <label className="text-sm">
    <span className="font-medium text-slate-800">{tr('Responsible employee','الموظف المسؤول')}</span>
    <select name="assigned_to" defaultValue={props.assignedTo} disabled={busy} required className="field-input mt-1 w-full">
     {people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
    </select>
   </label>
   <label className="text-sm">
    <span className="font-medium text-slate-800">{tr('Rent period from','فترة الإيجار من')}</span>
    <input name="period_start" type="month" defaultValue={monthValue(props.periodStart)} disabled={busy} required className="field-input mt-1 w-full"/>
   </label>
   <label className="text-sm">
    <span className="font-medium text-slate-800">{tr('Rent period through','فترة الإيجار إلى')}</span>
    <input name="period_end" type="month" defaultValue={monthValue(props.periodEnd)} disabled={busy} required className="field-input mt-1 w-full"/>
   </label>
  </div>
  <p className="text-xs leading-5 text-slate-500">{tr('This changes responsibility and the months this payment covers. It does not create or change a Finance transaction.','هذا يغيّر المسؤول والأشهر التي تغطيها الدفعة فقط، ولا ينشئ أو يغيّر أي حركة مالية.')}</p>
  <button disabled={busy} className="btn-secondary min-h-11">{busy?tr('Saving…','جارٍ الحفظ…'):tr('Save responsibility & rent period','حفظ المسؤول وفترة الإيجار')}</button>
 </form>;
}
