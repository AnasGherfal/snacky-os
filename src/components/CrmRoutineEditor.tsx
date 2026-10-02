'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {routinePreview,validateRoutineCommand,routineError,type RoutineInput,type RoutineCommand,type RoutineData,type Routine} from '@/lib/crm-recurring';
export function useRoutineCommand(userId:string,id:string,action:RoutineCommand['action'],revision:number,ar:boolean){
 const router=useRouter();const key=`snacky:crm-routine:v1:${userId}:${id}:${action}:${revision}`;
 const [saved,setSaved]=useState<RoutineCommand|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[done,setDone]=useState(false),[blocked,setBlocked]=useState(false),[message,setMessage]=useState('');
 const lock=useRef(false);
 useEffect(()=>{try{const raw=sessionStorage.getItem(key);if(raw){const c=validateRoutineCommand(JSON.parse(raw));if(c.id!==id||c.action!==action||c.revision!==revision)throw Error('conflict');setSaved(c);}}catch{setBlocked(true);setMessage(routineError('conflict',ar));}setReady(true);},[key,id,action,revision,ar]);
 async function submit(payload?:RoutineInput){
  if(lock.current||!ready||blocked||done)return;lock.current=true;setBusy(true);setMessage('');
  let c=saved;
  try{
   if(!c){c=validateRoutineCommand({request_id:crypto.randomUUID(),id,action,revision,payload});sessionStorage.setItem(key,JSON.stringify(c));setSaved(c);}
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);let reply;
   try{reply=await (await fetch('/api/crm/routines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c),signal:controller.signal})).json();}finally{clearTimeout(timer);}
   if(reply.ok){if(reply.id!==id||reply.request_id!==c.request_id)throw Error('uncertain');sessionStorage.removeItem(key);setDone(true);setSaved(null);setMessage(ar?'تم الحفظ.':'Saved.');router.refresh();}
   else{setMessage(routineError(reply.code,ar));if(reply.retryable===false){sessionStorage.removeItem(key);setSaved(null);if(reply.code==='conflict')setBlocked(true);}}
  }catch{setMessage(routineError(c?'uncertain':'invalid',ar));}finally{lock.current=false;setBusy(false);}
 }
 return {submit,saved,ready,busy,done,blocked,message};
}
export function CrmRoutineAction({userId,id,action,revision,label,ar}:{userId:string;id:string;action:RoutineCommand['action'];revision:number;label:string;ar:boolean}){
 const c=useRoutineCommand(userId,id,action,revision,ar);
 return <div><button className="btn-secondary min-h-11" disabled={!c.ready||c.busy||c.done||c.blocked} onClick={()=>{if(c.saved||window.confirm(ar?'تأكيد الإجراء؟ لن تتغير المهام الموجودة.':'Confirm? Existing tasks will not be changed.'))void c.submit();}}>{c.busy?(ar?'جارٍ الحفظ…':'Saving…'):c.saved?(ar?'إعادة الطلب المحفوظ':'Retry saved request'):label}</button>{c.message?<p role="status" className="mt-2 max-w-lg text-sm">{c.message}</p>:null}</div>;
}
export function CrmRoutineEditor({data,initial,id,userId,ar}:{data:RoutineData;initial?:Routine;id:string;userId:string;ar:boolean}){
 const [form,setForm]=useState<RoutineInput>(initial?{title:initial.title,instructions:initial.instructions,target_kind:initial.target_kind,target_id:initial.target_id??'',assigned_to:initial.assigned_to,cadence:initial.cadence,every:initial.every,start_on:initial.start_on,end_on:initial.end_on??'',notice_days:initial.notice_days}:{title:'',instructions:'',target_kind:'none',target_id:'',assigned_to:'',cadence:'weeks',every:1,start_on:data.today,end_on:'',notice_days:0});
 const c=useRoutineCommand(userId,id,'save',initial?.revision??0,ar);const tr=(en:string,a:string)=>ar?a:en;
 const p=c.saved?.payload??form;let dates:string[]=[];try{dates=routinePreview(p);}catch{}
 const lockedSchedule=Boolean(initial?.recent_work?.length);
 function field<K extends keyof RoutineInput>(key:K,v:RoutineInput[K]){setForm(f=>({...f,[key]:v}));}
 const selectedTarget=p.target_kind==='none'?'':`${p.target_kind}:${p.target_id}`;
 return <form className="space-y-5" dir={ar?'rtl':'ltr'} onSubmit={(e:FormEvent)=>{e.preventDefault();void c.submit(form);}}>
  <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6">{tr('New routines are paused. Review the first dates and assignee, then activate deliberately. Changes affect future tasks only.','تُحفظ المسؤولية الجديدة متوقفة. راجع المواعيد والمسؤول ثم فعّلها. التعديلات تخص المهام القادمة فقط.')}</p>
  <fieldset disabled={!c.ready||c.busy||Boolean(c.saved)||c.done||c.blocked} className="grid min-w-0 gap-4 sm:grid-cols-2">
   <label className="min-w-0 text-sm font-medium sm:col-span-2">{tr('Responsibility','المسؤولية')}<input required maxLength={240} className="field-input mt-1 w-full min-w-0" value={p.title} onChange={e=>field('title',e.target.value)}/></label>
   <label className="min-w-0 text-sm font-medium">{tr('Responsible employee','الموظف المسؤول')}<select required className="field-input mt-1 w-full min-w-0" value={p.assigned_to} onChange={e=>field('assigned_to',e.target.value)}><option value="">{tr('Choose an active employee','اختر موظفاً نشطاً')}</option>{data.directory.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
   <label className="min-w-0 text-sm font-medium">{tr('Linked record','السجل المرتبط')}<select disabled={lockedSchedule} className="field-input mt-1 w-full min-w-0" value={selectedTarget} onChange={e=>{const [kind,target]=e.target.value.split(':');setForm(f=>({...f,target_kind:(kind||'none') as RoutineInput['target_kind'],target_id:target||''}));}}><option value="">{tr('General responsibility','مسؤولية عامة')}</option>{initial?.target_id&&!data.targets.some(t=>t.id===initial.target_id)?<option value={`${initial.target_kind}:${initial.target_id}`}>{initial.target_title??tr('Source no longer available','السجل غير متاح')}</option>:null}{data.targets.map(t=><option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>{t.title}</option>)}</select></label>
   <label className="min-w-0 text-sm font-medium">{tr('Repeat every','تتكرر كل')}<input disabled={lockedSchedule} required className="field-input mt-1 w-full min-w-0" type="number" min={1} max={365} step={1} value={p.every} onChange={e=>field('every',Number(e.target.value))}/></label>
   <label className="min-w-0 text-sm font-medium">{tr('Period','الفترة')}<select disabled={lockedSchedule} className="field-input mt-1 w-full min-w-0" value={p.cadence} onChange={e=>field('cadence',e.target.value as RoutineInput['cadence'])}>{[['days','Days','أيام'],['weeks','Weeks','أسابيع'],['months','Months','أشهر']].map(([v,en,a])=><option key={v} value={v}>{tr(en,a)}</option>)}</select></label>
   <label className="min-w-0 text-sm font-medium">{tr('First due date','أول تاريخ استحقاق')}<input disabled={lockedSchedule} required className="field-input mt-1 w-full min-w-0" type="date" min={initial?undefined:data.today} max="2100-12-31" value={p.start_on} onChange={e=>field('start_on',e.target.value)}/></label>
   <label className="min-w-0 text-sm font-medium">{tr('End date (optional)','تاريخ الانتهاء (اختياري)')}<input className="field-input mt-1 w-full min-w-0" type="date" min={p.start_on} max="2100-12-31" value={p.end_on} onChange={e=>field('end_on',e.target.value)}/></label>
   <label className="min-w-0 text-sm font-medium">{tr('Create the task this many days early','إنشاء المهمة قبل الاستحقاق بعدد أيام')}<input required className="field-input mt-1 w-full min-w-0" type="number" min={0} max={30} step={1} value={p.notice_days} onChange={e=>field('notice_days',Number(e.target.value))}/></label>
   <label className="min-w-0 text-sm font-medium sm:col-span-2">{tr('Instructions / expected result','التعليمات والنتيجة المطلوبة')}<textarea maxLength={4000} rows={4} className="field-input mt-1 w-full min-w-0" value={p.instructions} onChange={e=>field('instructions',e.target.value)}/></label>
  </fieldset>
  <div className="rounded-xl border p-4 text-sm"><strong>{tr('Schedule preview','معاينة الجدول')}</strong><p className="mt-2" dir="ltr">{dates.join(' · ')||'—'}</p><p className="mt-2 text-slate-600">{tr('Future tasks are available through All or This week in My Work. Only one unfinished task at a time. Month-end dates return to the original day in longer months. Pausing never completes or deletes work.','تظهر المهام القادمة بمرشح الكل أو هذا الأسبوع في عملي اليوم. مهمة غير مكتملة واحدة في كل مرة. تعود مواعيد نهاية الشهر إلى اليوم الأصلي في الأشهر الأطول. الإيقاف لا يُنهي العمل أو يحذفه.')}</p>{lockedSchedule?<p className="mt-2">{tr('To change the source or cadence, pause this routine and create another; its history stays intact.','لتغيير السجل أو التكرار، أوقف المسؤولية وأنشئ أخرى مع الاحتفاظ بالتاريخ.')}</p>:null}</div>
  {c.message?<p role="status" className="text-sm">{c.message}</p>:null}
  <button className="btn-primary min-h-11" disabled={!c.ready||c.busy||c.done||c.blocked}>{c.busy?tr('Saving…','جارٍ الحفظ…'):c.done?tr('Saved','تم الحفظ'):c.saved?tr('Retry saved request','إعادة الطلب المحفوظ'):tr('Save routine','حفظ المسؤولية')}</button>
 </form>;
}
