'use client';
import {useRef,useState,useSyncExternalStore} from 'react';
import {useRouter} from 'next/navigation';
import {useLanguage} from '@/components/I18nProvider';
import {crmFieldBroadcastReceiptMatches,validateCrmFieldBroadcast,type CrmFieldBroadcastRequest} from '@/lib/crm-field-broadcast';

const noSubscribe=()=>()=>{};
type Props={issueId:string;userId:string;today:string;priority:string;locationName?:string|null;machineName?:string|null};

export function CrmFieldBroadcastForm({issueId,userId,today,priority,locationName,machineName}:Props){
 const {locale}=useLanguage(),ar=locale==='ar',tr=(en:string,arabic:string)=>ar?arabic:en,router=useRouter();
 const key='snacky:crm-field-broadcast:v1:'+userId+':'+issueId,lock=useRef(false);
 const defaultTitle=tr(
  `Check machine issue${machineName?` — ${machineName}`:locationName?` — ${locationName}`:''}`,
  `فحص مشكلة الماكينة${machineName?` — ${machineName}`:locationName?` — ${locationName}`:''}`
 );
 const mappedPriority=priority==='critical'?'urgent':['low','normal','high','urgent'].includes(priority)?priority:'normal';
 const [title,setTitle]=useState(defaultTitle),[dueDate,setDueDate]=useState(today),[urgency,setUrgency]=useState(mappedPriority),[notes,setNotes]=useState('');
 const [pending,setPending]=useState<CrmFieldBroadcastRequest|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 const storedRaw=useSyncExternalStore(noSubscribe,()=>{try{return localStorage.getItem(key)??'';}catch{return '';}},()=> '');
 let storedPending:CrmFieldBroadcastRequest|null=null;
 if(storedRaw&&!done){try{storedPending=validateCrmFieldBroadcast(JSON.parse(storedRaw));}catch{}}
 const effectivePending=pending??storedPending;

 async function submit(){
  if(lock.current||done)return;lock.current=true;setBusy(true);setError('');
  let request=effectivePending;
  try{
   if(!request){
    request=validateCrmFieldBroadcast({request_id:crypto.randomUUID(),issue_id:issueId,title,due_date:dueDate,priority:urgency,notes});
    try{localStorage.setItem(key,JSON.stringify(request));}catch{}
    setPending(request);
   }
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
   try{
    const response=await fetch('/api/crm/field-broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal});
    const result=await response.json();
    if(response.ok&&crmFieldBroadcastReceiptMatches(request,result)){
     try{localStorage.removeItem(key);}catch{}
     setPending(null);setDone(true);router.refresh();return;
    }
    if(result?.retryable===false){
     try{localStorage.removeItem(key);}catch{}
     setPending(null);
    }
    setError(result?.code==='conflict'
      ?tr('A field visit is already active for this issue. Reload the issue.','يوجد بالفعل إجراء ميداني مفتوح لهذا البلاغ. أعد تحميل البلاغ.')
      :result?.code==='denied'
      ?tr('You cannot send this issue to operators.','لا تملك صلاحية إرسال هذا البلاغ للمشغّلين.')
      :result?.code==='invalid'
      ?tr('Check the visit details and try again.','راجع بيانات الزيارة وحاول مرة أخرى.')
      :tr('The result is uncertain. Retry the saved request.','النتيجة غير مؤكدة. أعد محاولة الطلب المحفوظ.'));
   }finally{clearTimeout(timer);}
  }catch{setError(tr('The result is uncertain. Retry the saved request.','النتيجة غير مؤكدة. أعد محاولة الطلب المحفوظ.'));}
  finally{setBusy(false);lock.current=false;}
 }

 return <div className="grid gap-4">
  <p className="text-sm text-slate-600">{tr('No operator is selected. All active operators will see this visit and receive an alert; the first one to claim it becomes responsible.','لا يتم اختيار مشغّل. ستظهر الزيارة لكل المشغّلين النشطين ويصلهم تنبيه؛ أول من يستلمها يصبح المسؤول عنها.')}</p>
  {error?<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>:null}
  {effectivePending&&!done?<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{tr('This request is saved in your browser until its result is confirmed.','تم حفظ هذا الطلب في المتصفح حتى يتم تأكيد نتيجته.')}</p>:null}
  <label className="text-sm"><span className="font-medium">{tr('Visit / repair task','مهمة الزيارة / الإصلاح')}</span><input className="field-input mt-1" value={title} onChange={e=>setTitle(e.target.value)} disabled={busy||Boolean(effectivePending)||done}/></label>
  <div className="grid gap-3 sm:grid-cols-2">
   <label className="text-sm"><span className="font-medium">{tr('Visit by','تنفيذ الزيارة قبل')}</span><input type="date" className="field-input mt-1" value={dueDate} onChange={e=>setDueDate(e.target.value)} disabled={busy||Boolean(effectivePending)||done}/></label>
   <label className="text-sm"><span className="font-medium">{tr('Urgency','الاستعجال')}</span><select className="field-input mt-1" value={urgency} onChange={e=>setUrgency(e.target.value)} disabled={busy||Boolean(effectivePending)||done}><option value="low">{tr('Low','منخفض')}</option><option value="normal">{tr('Normal','عادي')}</option><option value="high">{tr('High','عالٍ')}</option><option value="urgent">{tr('Urgent','عاجل')}</option></select></label>
  </div>
  <label className="text-sm"><span className="font-medium">{tr('Instructions / context','التعليمات / السياق')}</span><textarea className="field-input mt-1" rows={3} value={notes} onChange={e=>setNotes(e.target.value)} disabled={busy||Boolean(effectivePending)||done}/></label>
  <button type="button" className="btn-primary min-h-11 w-full sm:w-auto" disabled={busy||done||title.trim().length<3||!dueDate} onClick={()=>void submit()}>{busy?tr('Sending…','جارٍ الإرسال…'):done?tr('Sent to operators','تم الإرسال للمشغّلين'):effectivePending?tr('Retry saved request','إعادة محاولة الطلب المحفوظ'):tr('Notify all operators','تنبيه كل المشغّلين')}</button>
 </div>;
}
