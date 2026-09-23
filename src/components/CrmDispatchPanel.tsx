'use client';
import {useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useRouter} from 'next/navigation';

const subscribe=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;
import {
 crmDispatchAckOverdue,crmDispatchError,crmDispatchLabel,crmDispatchReceiptMatches,
 validateCrmDispatchCommand,type CrmDispatchCommand,type CrmDispatchTask
} from '@/lib/crm-dispatch';

function fmt(value:string|null|undefined,ar:boolean){
 if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return value;
 return new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Tripoli'}).format(date);
}
function tone(state:string|null){
 if(state==='fixed')return 'border-emerald-200 bg-emerald-50 text-emerald-900';
 if(state==='blocked')return 'border-rose-200 bg-rose-50 text-rose-900';
 if(state==='working'||state==='en_route')return 'border-sky-200 bg-sky-50 text-sky-900';
 if(state==='accepted')return 'border-violet-200 bg-violet-50 text-violet-900';
 return 'border-amber-200 bg-amber-50 text-amber-900';
}

export function CrmDispatchTaskPanel(props:{task:CrmDispatchTask;userId:string;ar:boolean;canAct:boolean;proofImages:number}){
 const hydrated=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 if(!hydrated)return <section className="surface-card"><p role="status">{props.ar?'جارٍ تحميل الإجراء الميداني…':'Loading field dispatch…'}</p></section>;
 return <CrmDispatchTaskPanelClient {...props}/>;
}

function CrmDispatchTaskPanelClient({task,userId,ar,canAct,proofImages}:{task:CrmDispatchTask;userId:string;ar:boolean;canAct:boolean;proofImages:number}){
 const router=useRouter(),key='snacky:crm-dispatch:v1:'+userId+':'+task.id,lock=useRef(false);
 const [pending,setPending]=useState<CrmDispatchCommand|null>(()=>{try{const raw=sessionStorage.getItem(key);return raw?validateCrmDispatchCommand(JSON.parse(raw)):null;}catch{return null;}});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 const ready=true;
 const ackOverdue=crmDispatchAckOverdue(task);

 async function send(action:CrmDispatchCommand['action'],text=''){
  if(lock.current||!ready)return;lock.current=true;setBusy(true);setError('');
  let command=pending;
  try{
   if(!command){
    command=validateCrmDispatchCommand({request_id:crypto.randomUUID(),task_id:task.id,action,version:task.updated_at,note:text});
    sessionStorage.setItem(key,JSON.stringify(command));setPending(command);
   }
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
   try{
    const response=await fetch('/api/crm/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:controller.signal});
    const result=await response.json();
    if(response.ok&&crmDispatchReceiptMatches(command,result)){
     sessionStorage.removeItem(key);setPending(null);setNote('');router.refresh();
    }else if(result.ok===false){
     setError(crmDispatchError(result.code,ar));
     if(result.retryable===false){sessionStorage.removeItem(key);setPending(null);}
    }else throw Error('receipt');
   }finally{clearTimeout(timer);}
  }catch{setError(crmDispatchError('uncertain',ar));}finally{setBusy(false);lock.current=false;}
 }

 const state=task.dispatch_state;
 const next=useMemo(()=>{
  if(state==='assigned')return 'accept';
  if(state==='accepted')return 'en_route';
  if(state==='en_route'||state==='blocked')return 'start';
  return null;
 },[state]);

 return <section className="surface-card space-y-4" id="field-dispatch">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{ar?'الإجراء الميداني':'Field dispatch'}</p><h2 className="mt-1 text-lg font-semibold">{task.title}</h2></div>
   <span className={'rounded-full border px-3 py-1 text-sm font-semibold '+tone(state)}>{crmDispatchLabel(state,ar)}</span>
  </div>

  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
   <div><span className="text-xs text-slate-500">{ar?'موعد القبول':'Accept by'}</span><p className={ackOverdue?'font-semibold text-rose-700':''}>{fmt(task.ack_due_at,ar)}{ackOverdue?' · '+(ar?'متأخر':'overdue'):''}</p></div>
   <div><span className="text-xs text-slate-500">{ar?'تم القبول':'Accepted'}</span><p>{fmt(task.acknowledged_at,ar)}</p></div>
   <div><span className="text-xs text-slate-500">{ar?'بدء العمل':'Work started'}</span><p>{fmt(task.work_started_at,ar)}</p></div>
   <div><span className="text-xs text-slate-500">{ar?'تم الإصلاح':'Fixed'}</span><p>{fmt(task.fixed_at,ar)}</p></div>
  </div>

  {task.dispatch_state==='blocked'&&task.blocked_reason?<div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm"><strong>{ar?'سبب التوقف':'Blocked by'}</strong><p className="mt-1 whitespace-pre-wrap">{task.blocked_reason}</p></div>:null}
  {task.dispatch_state==='fixed'&&task.result?<div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm"><strong>{ar?'تقرير المشغّل':'Operator report'}</strong><p className="mt-1 whitespace-pre-wrap">{task.result}</p></div>:null}
  {error?<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>:null}
  {pending?<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{ar?'يوجد إجراء محفوظ لم تتأكد نتيجته. أعد نفس الإجراء قبل أي خطوة أخرى.':'A saved action has an uncertain result. Retry it before doing anything else.'}</p><button className="btn-primary mt-2" disabled={busy} onClick={()=>void send(pending.action,pending.note??'')}>{ar?'إعادة الإجراء المحفوظ':'Retry saved action'}</button></div>:null}

  {canAct&&state!=='fixed'?<div className="space-y-3">
   {next?<button className="btn-primary min-h-12 w-full sm:w-auto" disabled={busy||Boolean(pending)} onClick={()=>void send(next)}>
    {next==='accept'?(ar?'قبول المهمة':'Accept task'):next==='en_route'?(ar?'أنا في الطريق':'On my way'):(ar?'بدء / استئناف العمل':'Start / resume work')}
   </button>:null}
   {['accepted','en_route','working'].includes(String(state))?<div className="grid gap-2 sm:max-w-xl"><label className="text-sm font-medium">{ar?'إذا تعذر إكمال العمل':'If work is blocked'}<textarea className="field-input mt-1" rows={2} maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} placeholder={ar?'مثال: الكهرباء مفصولة، قطعة غيار مطلوبة…':'Example: power is off, part required…'}/></label><button className="btn-secondary justify-self-start" disabled={busy||Boolean(pending)||note.trim().length<3} onClick={()=>void send('block',note)}>{ar?'تسجيل عائق':'Mark blocked'}</button></div>:null}
   {state==='working'?<div className="grid gap-2 sm:max-w-xl"><label className="text-sm font-medium">{ar?'ماذا أصلحت؟':'What did you fix?'}<textarea className="field-input mt-1" rows={3} maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} required/></label><p className="text-xs text-slate-500">{proofImages>0?(ar?'الصورة الميدانية موجودة ويمكن إكمال المهمة.':'Field photo is attached; the task can be completed.'):(ar?'أرفق صورة ميدانية من قسم المستندات أدناه قبل إنهاء المهمة.':'Attach a field photo in Documents & proof below before finishing.')}</p><button className="btn-primary justify-self-start" disabled={busy||Boolean(pending)||note.trim().length<3||proofImages<1} onClick={()=>void send('fix',note)}>{ar?'تم الإصلاح — إرسال التقرير':'Fixed — send report'}</button>{proofImages<1?<a className="text-sm text-sky-800 underline" href="#crm-documents">{ar?'الذهاب لإرفاق الصورة':'Go to photo upload'}</a>:null}</div>:null}
  </div>:null}

  {state==='fixed'?<p className="text-sm text-slate-600">{ar?'إنهاء المهمة لا يغلق مشكلة العميل. تم إبلاغ مسؤول علاقات العملاء ليؤكد النتيجة مع العميل ثم يغلق الحالة.':'Finishing field work does not close the customer issue. Customer Relations is notified to verify the outcome and close the case.'}</p>:null}
 </section>;
}

export function CrmIssueDispatchSummary({tasks,ar}:{tasks:Array<CrmDispatchTask&{assigned_name?:string|null}>;ar:boolean}){
 const hydrated=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 const now=hydrated?Date.now():null;
 if(!tasks.length)return null;
 return <section className="surface-card space-y-3">
  <div><h2 className="font-semibold">{ar?'الإجراءات الميدانية':'Field dispatches'}</h2><p className="mt-1 text-xs text-slate-500">{ar?'إنهاء المشغّل للإجراء لا يغلق بلاغ العميل؛ يبقى التحقق والإغلاق لدى علاقات العملاء.':'Operator completion does not close the customer complaint; CRM still verifies and closes it.'}</p></div>
  {tasks.map(task=>{const overdue=now!==null&&crmDispatchAckOverdue(task,now);return <div key={task.id} className="rounded-xl border border-slate-200 p-3">
   <div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{task.title}</strong><p className="text-xs text-slate-500">{task.assigned_name??(ar?'غير معيّن':'Unassigned')}</p></div><span className={'rounded-full border px-2.5 py-1 text-xs font-semibold '+tone(task.dispatch_state)}>{crmDispatchLabel(task.dispatch_state,ar)}</span></div>
   <div className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-3"><p>{ar?'موعد القبول: ':'Accept by: '}{fmt(task.ack_due_at,ar)}{overdue?' · '+(ar?'متأخر':'overdue'):''}</p><p>{ar?'بدأ العمل: ':'Started: '}{fmt(task.work_started_at,ar)}</p><p>{ar?'الإصلاح: ':'Fixed: '}{fmt(task.fixed_at,ar)}</p></div>
   {task.dispatch_state==='blocked'&&task.blocked_reason?<p className="mt-2 rounded-lg bg-rose-50 p-2 text-sm">{task.blocked_reason}</p>:null}
   {task.dispatch_state==='fixed'&&task.result?<p className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm">{task.result}</p>:null}
  </div>})}
 </section>;
}
