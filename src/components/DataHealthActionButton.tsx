'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

type ActionName='scan_negative_inventory'|'cancel_stale_refill'|'archive_vms_batch'|'classify_legacy_cash'|'unclassify_legacy_cash'|'resolve_inventory_case';

export function DataHealthActionButton({action,targetId,label,defaultReason='',requiresReason=true,tone='secondary'}:{
 action:ActionName;targetId?:string|null;label:string;defaultReason?:string;requiresReason?:boolean;tone?:'primary'|'secondary';
}){
 const router=useRouter();
 const [open,setOpen]=useState(false),[reason,setReason]=useState(defaultReason),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function run(){
  if(busy||(requiresReason&&reason.trim().length<3))return;
  setBusy(true);setError('');
  try{
   const response=await fetch('/api/data-health/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,target_id:targetId??null,reason:requiresReason?reason.trim():null})});
   const result=await response.json();
   if(!response.ok||result?.ok!==true){setError(result?.message||'Could not complete this cleanup action.');return;}
   setOpen(false);router.refresh();
  }catch{setError('Could not connect right now.');}
  finally{setBusy(false);}
 }
 if(!requiresReason)return <div className="space-y-1"><button type="button" className={tone==='primary'?'btn-primary':'btn-secondary'} disabled={busy} onClick={()=>void run()}>{busy?'Working…':label}</button>{error?<p className="text-xs text-rose-700" role="alert">{error}</p>:null}</div>;
 return <div className="space-y-2">
  {!open?<button type="button" className={tone==='primary'?'btn-primary':'btn-secondary'} disabled={busy} onClick={()=>{setError('');setOpen(true);}}>{label}</button>:
   <div className="min-w-[18rem] rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
    <label className="block text-xs font-semibold text-slate-700">Reason / audit note<textarea className="field-input mt-1" rows={2} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={busy||reason.trim().length<3} onClick={()=>void run()}>{busy?'Saving…':'Confirm'}</button><button type="button" className="btn-secondary" disabled={busy} onClick={()=>{setOpen(false);setReason(defaultReason);setError('');}}>Cancel</button></div>
   </div>}
  {error?<p className="text-xs text-rose-700" role="alert">{error}</p>:null}
 </div>;
}
