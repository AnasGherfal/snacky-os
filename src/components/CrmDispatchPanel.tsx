'use client';
import {useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useRouter} from 'next/navigation';

const subscribe=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;
import {
 crmDispatchAckOverdue,crmDispatchError,crmDispatchLabel,crmDispatchReceiptMatches,crmDispatchVersion,
 validateCrmDispatchCommand,type CrmDispatchCommand,type CrmDispatchTask
} from '@/lib/crm-dispatch';

function fmt(value:string|null|undefined,ar:boolean){
 if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return value;
 return new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Tripoli'}).format(date);
}
function tone(state:string|null){
 if(state==='fixed')return 'border-emerald-200 bg-emerald-50 text-emerald-900';
 if(state==='needs_technician'||state==='needs_part')return 'border-orange-200 bg-orange-50 text-orange-900';
 if(state==='machine_offline'||state==='blocked')return 'border-rose-200 bg-rose-50 text-rose-900';
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
    command=validateCrmDispatchCommand({request_id:crypto.randomUUID(),task_id:task.id,action,version:crmDispatchVersion(task),note:text});
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
 const maintenanceOutcome=['needs_technician','needs_part','machine_offline'].includes(String(state));
 const terminal=state==='fixed'||maintenanceOutcome;
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
  {maintenanceOutcome&&task.result?<div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-950"><strong>{ar?'تشخيص المشغّل':'Operator diagnosis'}</strong><p className="mt-1 whitespace-pre-wrap">{task.result}</p><p className="mt-2 text-xs">{ar?'انتهت زيارة المشغّل، لكن بلاغ العميل يبقى مفتوحاً حتى تتم الصيانة والمتابعة.':'The operator visit is complete, but the customer issue stays open until maintenance and follow-up are completed.'}</p></div>:null}
  {error?<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>:null}
  {pending?<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{ar?'يوجد إجراء محفوظ لم تتأكد نتيجته. أعد نفس الإجراء قبل أي خطوة أخرى.':'A saved action has an uncertain result. Retry it before doing anything else.'}</p><button className="btn-primary mt-2" disabled={busy} onClick={()=>void send(pending.action,pending.note??'')}>{ar?'إعادة الإجراء المحفوظ':'Retry saved action'}</button></div>:null}

  {canAct&&!terminal?<div className="space-y-3">
   <div className="flex flex-wrap gap-2">{next?<button className="btn-primary min-h-12" disabled={busy||Boolean(pending)} onClick={()=>void send(next)}>
    {next==='accept'?(ar?'قبول المهمة':'Accept task'):next==='en_route'?(ar?'أنا في الطريق':'On my way'):(ar?'بدء / استئناف العمل':'Start / resume work')}
   </button>:null}</div>
   {['accepted','en_route','working'].includes(String(state))?<div className="grid gap-2 sm:max-w-xl"><label className="text-sm font-medium">{ar?'إذا تعذر إكمال العمل':'If work is blocked'}<textarea className="field-input mt-1" rows={2} maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} placeholder={ar?'مثال: الكهرباء مفصولة، قطعة غيار مطلوبة…':'Example: power is off, part required…'}/></label><button className="btn-secondary justify-self-start" disabled={busy||Boolean(pending)||note.trim().length<3} onClick={()=>void send('block',note)}>{ar?'تسجيل عائق':'Mark blocked'}</button></div>:null}
   {state==='working'?<div className="grid gap-3 sm:max-w-2xl"><label className="text-sm font-medium">{ar?'نتيجة الزيارة / التشخيص':'Visit result / diagnosis'}<textarea className="field-input mt-1" rows={3} maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} required placeholder={ar?'اكتب ما وجدته، وما تم إصلاحه أو ما المطلوب':'Write what you found, what was fixed, or what is still required'}/></label><p className="text-xs text-slate-500">{proofImages>0?(ar?'الصورة الميدانية موجودة ويمكن تسجيل نتيجة الزيارة.':'Field photo is attached; you can record the visit outcome.'):(ar?'أرفق صورة ميدانية من قسم المستندات أدناه قبل إنهاء الزيارة.':'Attach a field photo in Documents & proof below before completing the visit.')}</p><div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={busy||Boolean(pending)||note.trim().length<3||proofImages<1} onClick={()=>void send('fix',note)}>{ar?'تم الإصلاح':'Fixed'}</button><button className="btn-secondary" disabled={busy||Boolean(pending)||note.trim().length<3||proofImages<1} onClick={()=>void send('needs_technician',note)}>{ar?'يحتاج فني':'Needs technician'}</button><button className="btn-secondary" disabled={busy||Boolean(pending)||note.trim().length<3||proofImages<1} onClick={()=>void send('needs_part',note)}>{ar?'يحتاج قطعة غيار':'Needs spare part'}</button><button className="btn-secondary" disabled={busy||Boolean(pending)||note.trim().length<3||proofImages<1} onClick={()=>void send('machine_offline',note)}>{ar?'الماكينة خارج الخدمة':'Machine offline'}</button></div>{proofImages<1?<a className="text-sm text-sky-800 underline" href="#crm-documents">{ar?'الذهاب لإرفاق الصورة':'Go to photo upload'}</a>:null}</div>:null}
  </div>:null}

  {state==='fixed'?<p className="text-sm text-slate-600">{ar?'إنهاء المهمة لا يغلق مشكلة العميل. تم إبلاغ مسؤول علاقات العملاء ليؤكد النتيجة مع العميل ثم يغلق الحالة.':'Finishing field work does not close the customer issue. Customer Relations is notified to verify the outcome and close the case.'}</p>:maintenanceOutcome?<p className="text-sm text-orange-800">{ar?'تم تسجيل احتياج صيانة. لا يُغلق بلاغ العميل، ويظهر الآن لعلاقات العملاء والإدارة للمتابعة.':'Maintenance is required. The customer issue stays open and is now surfaced to CRM and management for follow-up.'}</p>:null}
 </section>;
}

export function CrmIssueDispatchSummary({tasks,ar}:{tasks:Array<CrmDispatchTask&{assigned_name?:string|null;notification_readiness_known?:boolean;active_notification_devices?:number|null}>;ar:boolean}){
 const hydrated=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 if(!tasks.length)return null;
 if(!hydrated)return <section className="surface-card"><p role="status">{ar?'جارٍ تحميل حالة الإجراءات الميدانية…':'Loading field dispatch status…'}</p></section>;
 return <section className="surface-card space-y-3">
  <div><h2 className="font-semibold">{ar?'الإجراءات الميدانية':'Field dispatches'}</h2><p className="mt-1 text-xs text-slate-500">{ar?'إنهاء المشغّل للإجراء لا يغلق بلاغ العميل؛ يبقى التحقق والإغلاق لدى علاقات العملاء.':'Operator completion does not close the customer complaint; CRM still verifies and closes it.'}</p></div>
  {tasks.map(task=>{const overdue=crmDispatchAckOverdue(task);return <div key={task.id} className="rounded-xl border border-slate-200 p-3">
   <div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{task.title}</strong><p className="text-xs text-slate-500">{task.assigned_name??(ar?'غير معيّن':'Unassigned')}</p></div><span className={'rounded-full border px-2.5 py-1 text-xs font-semibold '+tone(task.dispatch_state)}>{crmDispatchLabel(task.dispatch_state,ar)}</span></div>
   <div className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-3"><p>{ar?'موعد القبول: ':'Accept by: '}{fmt(task.ack_due_at,ar)}{overdue?' · '+(ar?'متأخر':'overdue'):''}</p><p>{ar?'بدأ العمل: ':'Started: '}{fmt(task.work_started_at,ar)}</p><p>{ar?'الإصلاح: ':'Fixed: '}{fmt(task.fixed_at,ar)}</p></div>
   {task.dispatch_state==='available'?<p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs font-medium text-amber-900">{ar?'تم إشعار المشغّلين. أول مشغّل يستلم البلاغ يصبح مسؤولاً عن الزيارة والإصلاح.':'Operators were notified. The first operator to claim this issue owns the visit and repair.'}</p>:task.dispatch_state!=='fixed'?task.notification_readiness_known===false?<p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">{ar?'تعذر التحقق من جاهزية إشعارات هاتف المشغّل. تواصل معه مباشرة إذا كانت المهمة عاجلة.':'Could not verify the operator phone notification status. Contact them directly if the task is urgent.'}</p>:Number(task.active_notification_devices??0)>0?<p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">{ar?`إشعارات الهاتف مفعلة على ${task.active_notification_devices} جهاز. قبول خدمة الإشعار لا يعني أن المشغّل شاهد الرسالة.`:`Push is ready on ${task.active_notification_devices} registered device(s). Provider acceptance does not mean the operator saw it.`}</p>:<p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs font-medium text-amber-900">{ar?'لا يوجد جهاز مسجل للإشعارات لدى المشغّل — تواصل معه مباشرة.':'No active notification device — contact the operator directly.'}</p>:null}
   {overdue&&task.priority==='urgent'?<p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm font-semibold text-rose-900">{ar?'تأخر قبول المهمة العاجلة — تواصل مع المشغّل أو أعد إسنادها الآن.':'Urgent acceptance is overdue — contact or reassign the operator now.'}</p>:null}
   {task.dispatch_state==='blocked'&&task.blocked_reason?<p className="mt-2 rounded-lg bg-rose-50 p-2 text-sm">{task.blocked_reason}</p>:null}
   {task.dispatch_state==='fixed'&&task.result?<p className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm">{task.result}</p>:null}
  </div>})}
 </section>;
}
