'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

type Pending={request_id:string;case_id:string;counted_qty:number;reason:string};

export function OperatorBagReconcileControl({caseId,currentQty,operatorName,productName}:{caseId:string;currentQty:number;operatorName:string;productName:string}){
 const router=useRouter();
 const key='snacky:data-health:operator-bag:'+caseId;
 const [open,setOpen]=useState(false);
 const [count,setCount]=useState('0');
 const [reason,setReason]=useState('Physical operator-bag count verified');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');

 async function submit(){
  const counted=Number(count);
  if(busy||!Number.isInteger(counted)||counted<0||reason.trim().length<3)return;
  setBusy(true);setError('');
  try{
   const stored=sessionStorage.getItem(key);
   const pending:Pending=stored?JSON.parse(stored):{request_id:crypto.randomUUID(),case_id:caseId,counted_qty:counted,reason:reason.trim()};
   if(pending.case_id!==caseId||pending.counted_qty!==counted||pending.reason!==reason.trim()){
    setError('A saved reconciliation is waiting to be retried. Restore the same count and reason first.');return;
   }
   sessionStorage.setItem(key,JSON.stringify(pending));
   const response=await fetch('/api/data-health/operator-bag-reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending)});
   const result=await response.json();
   if(!response.ok||result?.ok!==true){setError(result?.message||'Could not reconcile this operator bag.');return;}
   sessionStorage.removeItem(key);setOpen(false);router.refresh();
  }catch{setError('Result uncertain. Retry the exact same count and reason; do not create a second correction.');}
  finally{setBusy(false);}
 }

 return <div className="space-y-2">
  {!open?<button type="button" className="btn-primary" onClick={()=>{setError('');setOpen(true);}}>Enter physical count</button>:
  <div className="min-w-[20rem] rounded-xl border border-rose-200 bg-rose-50 p-3">
   <div className="text-xs font-semibold text-rose-900">{operatorName} · {productName}</div>
   <p className="mt-1 text-xs text-rose-800">Ledger now: {currentQty}. Enter what is physically in the operator bag. Snacky OS will post one audited stock-count correction to match it.</p>
   <label className="mt-3 block text-xs font-semibold">Physical count<input className="field-input mt-1" type="number" inputMode="numeric" min={0} step={1} value={count} onChange={e=>setCount(e.target.value)}/></label>
   <label className="mt-2 block text-xs font-semibold">Reason / evidence<textarea className="field-input mt-1" rows={2} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
   <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={busy||!/^\d+$/.test(count)||reason.trim().length<3} onClick={()=>void submit()}>{busy?'Reconciling…':'Confirm physical count'}</button><button type="button" className="btn-secondary" disabled={busy} onClick={()=>setOpen(false)}>Cancel</button></div>
  </div>}
  {error?<p role="alert" className="text-xs text-rose-700">{error}</p>:null}
 </div>;
}
