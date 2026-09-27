'use client';
import {useRef,useState} from 'react';
import {collaborationMessage,validateCollaborationCommand,validCollaborationReceipt,type CollaborationCommand} from '@/lib/crm-collaboration';
export function useCrmCollaborationCommand(userId:string,scope:string,ar:boolean){
 const key='snacky:crm-collaboration:'+userId+':'+scope,lock=useRef(false);
 const [restored]=useState(()=>{try{const raw=sessionStorage.getItem(key);return {pending:raw?validateCollaborationCommand(JSON.parse(raw)):null,corrupt:false};}catch{return {pending:null,corrupt:true};}});
 const [pending,setPending]=useState<CollaborationCommand|null>(restored.pending),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[stale,setStale]=useState(false);
 async function send(next:CollaborationCommand):Promise<boolean>{
  if(lock.current||restored.corrupt||stale)return false;lock.current=true;setBusy(true);setMessage('');
  let command=pending;
  try{
   if(!command){command=validateCollaborationCommand(next);sessionStorage.setItem(key,JSON.stringify(command));setPending(command);}
   const response=await fetch('/api/crm/collaboration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(22000)});
   const body=await response.json();
   if(response.ok&&validCollaborationReceipt(command,body)){
    sessionStorage.removeItem(key);setPending(null);setMessage(ar?'تم الحفظ':'Saved');return true;
   }
   if(body.ok===false){setMessage(collaborationMessage(body.code,ar));if(body.retryable===false){sessionStorage.removeItem(key);setPending(null);if(body.code==='conflict')setStale(true);}return false;}
   throw Error('uncertain');
  }catch{setMessage(collaborationMessage('uncertain',ar));return false;}
  finally{setBusy(false);lock.current=false;}
 }
 return {pending,busy,stale,blocked:busy||Boolean(pending)||stale||restored.corrupt,message:restored.corrupt?(ar?'تعذر قراءة الطلب المحفوظ. لا تُكرر الإجراء؛ أعد تحميل الصفحة.':'Could not read the saved request. Do not repeat the action; reload the page.'):message,send,clearStale:()=>setStale(false)};
}
