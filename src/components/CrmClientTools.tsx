'use client';
import { useEffect,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/components/I18nProvider';
import { type CrmKind,uuidPattern } from '@/lib/crm-workspace';

export function CrmRefresh(){
 const router=useRouter();
 useEffect(()=>{
  const refresh=()=>{if(document.visibilityState==='visible'&&!document.activeElement?.closest('form'))router.refresh();};
  const timer=setInterval(refresh,30000);window.addEventListener('focus',refresh);
  return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};
 },[router]);
 return null;
}
export function CrmWelcome({userId}:{userId:string}){
 const {locale}=useLanguage(),ar=locale==='ar';const [visible,setVisible]=useState(false);
 useEffect(()=>{try{setVisible(localStorage.getItem(`snacky:crm-welcome:${userId}`)!=='seen');}catch{setVisible(true);}},[userId]);
 if(!visible)return null;
 return <section className="rounded-2xl border border-orange-200 bg-orange-50 p-5" dir={ar?'rtl':'ltr'}>
  <h2 className="font-semibold">{ar?'أهلاً بك في سناكي':'Welcome to Snacky OS'}</h2>
  <p className="mt-2 text-sm leading-6">{ar?'ابدأ من «عملي اليوم». سجّل نتيجة كل مكالمة أو زيارة داخل الجهة أو المشكلة، وحدّد الخطوة القادمة ومسؤولها. العمل الميداني يظهر للمشغّل هنا، ونتيجته تظهر لك دون رسائل داخلية.':'Start with My Work. Record the outcome of each call or visit on its lead or issue, then set the next action and its owner. Assigned field work appears for the operator, and the result comes back here without internal messages.'}</p>
  <p className="mt-2 text-sm font-semibold">{ar?'إذا لم يُسجّل في سناكي، فلن يعرف الفريق أنه حدث.':'If it is not recorded in Snacky OS, the team cannot know it happened.'}</p>
  <button type="button" className="btn-secondary mt-3" onClick={()=>{try{localStorage.setItem(`snacky:crm-welcome:${userId}`,'seen');}catch{}setVisible(false);}}>{ar?'ابدأ العمل':'Start work'}</button>
 </section>;
}
export function CrmDocumentUpload({kind,recordId,userId}:{kind:CrmKind;recordId:string;userId:string}){
 const {locale}=useLanguage(),ar=locale==='ar',router=useRouter();
 const [file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const pending=useRef<string|null>(null),lock=useRef(false);
 async function upload(){
  if(!file||lock.current)return;
  if(file.size>10000000){setMessage(ar?'الحد الأقصى 10 ميجابايت.':'Maximum file size is 10 MB.');return;}
  lock.current=true;setBusy(true);setMessage('');
  let key='';
  try{
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('');
   key=`snacky:crm-upload:${userId}:${kind}:${recordId}:${digest}`;
   if(!pending.current){try{const saved=localStorage.getItem(key);pending.current=saved&&uuidPattern.test(saved)?saved:crypto.randomUUID();localStorage.setItem(key,pending.current);}catch{pending.current=crypto.randomUUID();}}
   const fd=new FormData();fd.set('file',file);fd.set('kind',kind);fd.set('record_id',recordId);fd.set('command_id',pending.current);
   const response=await fetch('/api/crm/documents',{method:'POST',body:fd}),result=await response.json();
   setMessage(result.ok?(ar?'تم إرفاق المستند الخاص.':'Private document attached.'):String(result.message));
   if(result.ok){try{localStorage.removeItem(key);}catch{}pending.current=null;setFile(null);router.refresh();}
  }catch{setMessage(ar?'لم تتأكد النتيجة. أعد رفع الملف نفسه.':'Upload not confirmed. Retry the same selected file.');}
  finally{lock.current=false;setBusy(false);}
 }
 return <form action={upload} className="space-y-3">
  <label className="block text-sm font-medium">{ar?'صورة أو PDF — خاص، حتى 10 ميجابايت':'Image or PDF — private, up to 10 MB'}<input type="file" required disabled={busy||Boolean(pending.current)} accept="image/jpeg,image/png,image/webp,application/pdf" className="mt-2 block w-full text-sm" onChange={e=>{setFile(e.target.files?.[0]??null);pending.current=null;}}/></label>
  {message?<p role="status" className="text-sm text-slate-700">{message}</p>:null}
  <button className="btn-secondary min-h-11" disabled={!file||busy}>{busy?(ar?'جارٍ الرفع…':'Uploading…'):ar?'إرفاق الملف':'Attach file'}</button>
 </form>;
}
