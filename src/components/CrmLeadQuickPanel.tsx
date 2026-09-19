'use client';
import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {leadStatuses,crmStatus} from '@/lib/crm-workspace';
import {buildLeadQuick,readLeadQuick,quickReceiptMatches,quickDefaults,quickLabels,quickModes,leadIsClosed,type LeadQuickContext,type LeadQuickMode,type SavedLeadQuick} from '@/lib/crm-lead-quick';
import styles from './CrmLeadQuick.module.css';

/** Outside result rows: a decline/reassignment can remove a row without losing its receipt. */
export function CrmLeadQuickPanel({id,returnHref,initialMode='log',ar}:{id:string;returnHref:string;initialMode?:string;ar:boolean}){
 const router=useRouter(),dialog=useRef<HTMLDialogElement>(null),heading=useId();
 const [context,setContext]=useState<LeadQuickContext|null>(null),[mode,setMode]=useState<LeadQuickMode>(quickModes.includes(initialMode as LeadQuickMode)?initialMode as LeadQuickMode:'log');
 const [values,setValues]=useState<Record<string,string>>({}),[pending,setPending]=useState<SavedLeadQuick|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[blocked,setBlocked]=useState(false),[stale,setStale]=useState(false),[done,setDone]=useState(false),[message,setMessage]=useState('');
 const lock=useRef(false),key=useRef('');const tr=(en:string,arabic:string)=>ar?arabic:en;const initial=useRef(mode);
 function close(){
  if(lock.current)return;
  if(!pending&&!done&&Object.keys(values).length&&context&&JSON.stringify(values)!==JSON.stringify(quickDefaults(mode,context))&&!window.confirm(tr('Discard these unsaved edits?','تجاهل هذه التعديلات غير المحفوظة؟')))return;
  if(pending&&!window.confirm(tr('The result is unconfirmed. Your exact request is preserved. Open Quick update for this place to retry it. Close for now?','لم يتأكد الحفظ. الطلب نفسه محفوظ. افتح التحديث السريع لهذه الجهة لإعادة المحاولة. إغلاق الآن؟')))return;
  dialog.current?.close();router.replace(returnHref,{scroll:false});router.refresh();
 }
 useEffect(()=>{
  dialog.current?.showModal();let alive=true;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  (async()=>{
   try{
    const response=await fetch(`/api/crm/leads/${id}/quick`,{cache:'no-store',signal:abort.signal});const data=await response.json();
    if(!response.ok||data.ok!==true||data.context?.row?.id!==id)throw Error(response.status===403?'denied':'load');
    if(!alive)return;const c=data.context as LeadQuickContext;setContext(c);key.current=`snacky:lead-quick:v1:${c.userId}:${id}`;
    let raw:string|null;try{raw=localStorage.getItem(key.current);}catch{throw Error('storage');}
    if(raw){const saved=readLeadQuick(raw,id);setPending(saved);setMode(saved.mode);setValues(saved.request.values);}
    else {const selected=initial.current==='next'&&leadIsClosed(c.row.status)?'log':initial.current;setMode(selected);setValues(quickDefaults(selected,c));}
   }catch(error){if(alive){setBlocked(true);setMessage(error instanceof Error&&error.message==='denied'?tr('You cannot access this place.','لا يمكنك الوصول إلى هذه الجهة.'):tr('Could not verify this record or a saved request. Nothing was changed. Reload to try again.','تعذر التحقق من السجل أو الطلب المحفوظ. لم يتغير شيء. أعد التحميل للمحاولة.'));}}
   finally{clearTimeout(timer);if(alive)setLoading(false);}
  })();
  return()=>{alive=false;abort.abort();};
  // URL identity, not refreshed defaults, controls a pending command.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[id]);
 function choose(next:LeadQuickMode){
  if(!context||pending||busy||blocked||stale)return;
  if(!done&&JSON.stringify(values)!==JSON.stringify(quickDefaults(mode,context))&&!window.confirm(tr('Discard the unsaved edits before switching action?','تجاهل التعديلات غير المحفوظة قبل تغيير الإجراء؟')))return;
  setMode(next);setValues(quickDefaults(next,context));setDone(false);setMessage('');
 }
 function errorText(code:string){const errors:Record<string,string>={
  denied:tr('You cannot make this change.','لا تملك صلاحية هذا التغيير.'),required:tr('Enter the result or the next action and a valid date.','اكتب النتيجة أو الخطوة القادمة وموعداً صحيحاً.'),
  reason:tr('Record why the stage changed.','اكتب سبب تغيير المرحلة.'),confirm:tr('Confirm the actual outcome before saving this change.','أكّد النتيجة الفعلية قبل حفظ هذا التغيير.'),
  no_change:tr('Choose a different stage.','اختر مرحلة مختلفة.'),notes_full:tr('Existing notes are too long to append safely. Use the full record instead.','الملاحظات الحالية طويلة؛ استخدم السجل الكامل حتى لا تضيع المعلومات.'),
  closed:tr('Reopen the opportunity before setting prospecting follow-ups.','أعد فتح الفرصة قبل تحديد متابعة مبيعات.'),email:tr('Enter a valid email, or leave it blank.','اكتب بريداً صحيحاً أو اتركه فارغاً.')};return errors[code]??tr('Check the fields and browser storage before saving.','راجع الحقول وتخزين المتصفح قبل الحفظ.');}
 async function submit(event:FormEvent){
  event.preventDefault();if(lock.current||!context||blocked||stale||done)return;let saved=pending;
  if(!saved){try{
   const prior=localStorage.getItem(key.current);if(prior){const recovered=readLeadQuick(prior,id);setPending(recovered);setMode(recovered.mode);setValues(recovered.request.values);setMessage(tr('Review the existing saved request, then retry it.','راجع الطلب المحفوظ ثم أعد المحاولة.'));return;}
   saved={mode,request:buildLeadQuick(mode,context,values,crypto.randomUUID())};localStorage.setItem(key.current,JSON.stringify(saved));
  }catch(error){setMessage(errorText(error instanceof Error?error.message:''));return;}}
  lock.current=true;setBusy(true);setPending(saved);setMessage('');const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),25000);
  try{
   const response=await fetch('/api/crm/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved.request),signal:abort.signal});const result=await response.json();
   if(response.ok&&quickReceiptMatches(saved.request,result)){
    try{if(JSON.parse(localStorage.getItem(key.current)||'null')?.request?.id===saved.request.id)localStorage.removeItem(key.current);}catch{/* Cleanup failure cannot undo a confirmed database receipt. */}
    const v=saved.request.values;setContext(c=>c?{...c,row:{...c.row,status:v.status??c.row.status,nextAction:v.next_action??c.row.nextAction,dueDate:v.next_action_date??c.row.dueDate,contactName:v.contact_person_name??c.row.contactName,phone:v.contact_phone??c.row.phone,whatsapp:v.contact_whatsapp??c.row.whatsapp,email:v.contact_email??c.row.email,assignedTo:v.assigned_to??c.row.assignedTo,assignedName:v.assigned_to?(c.people.find(p=>p.id===v.assigned_to)?.name??null):c.row.assignedName}}:c);
    setPending(null);setDone(true);setMessage(tr('Saved in Snacky OS. Close to return to the refreshed list.','تم الحفظ في سناكي. أغلق للعودة إلى القائمة المحدثة.'));
   }else if(result.ok===false){
    setMessage(result.resetAllowed===true?tr('The change was not saved. Check the latest record and try again.','لم يُحفظ التغيير. راجع أحدث سجل ثم أعد المحاولة.'):tr('Save is unconfirmed. Retry the same saved request.','لم يتأكد الحفظ. أعد الطلب المحفوظ نفسه.'));
    if(result.resetAllowed===true){localStorage.removeItem(key.current);setPending(null);}if(result.refreshRequired===true)setStale(true);
   }else throw Error('receipt');
  }catch{setMessage(tr('Save is unconfirmed. Retry the same saved request.','لم يتأكد الحفظ. أعد الطلب المحفوظ نفسه.'));}
  finally{clearTimeout(timer);lock.current=false;setBusy(false);}
 }
 const locked=loading||busy||Boolean(pending)||blocked||stale||done;const set=(name:string,value:string)=>setValues(v=>({...v,[name]:value}));
 function input(name:string,en:string,arabic:string,type='text',required=false){return <label>{tr(en,arabic)}<input name={name} type={type} value={values[name]||''} onChange={e=>set(name,e.target.value)} required={required} maxLength={type==='text'?1000:undefined} dir={['tel','email','date'].includes(type)?'ltr':undefined}/></label>;}
 const closed=context&&leadIsClosed(context.row.status);
 return <dialog ref={dialog} aria-labelledby={heading} className={styles.dialog} dir={ar?'rtl':'ltr'} data-crm-lead-quick onCancel={e=>{e.preventDefault();close();}}>
  <header className={styles.header}><div><p>{tr('Quick update','تحديث سريع')}</p><h2 id={heading}>{context?.row.title||tr('Loading place…','جارٍ تحميل الجهة…')}</h2></div><button type="button" className={styles.close} onClick={close} disabled={busy} aria-label={tr('Close quick update','إغلاق التحديث السريع')}>×</button></header>
  {context?<div className={styles.snapshot}><span>{crmStatus(context.row.status,ar)}</span><span>{tr('Assigned to','الموظف المسؤول')}: {context.row.assignedName||tr('Unassigned','غير مسند')}</span><Link prefetch={false} href={`/locations-pipeline/${id}`}>{tr('Full record','السجل الكامل')}</Link></div>:null}
  {closed?<p className={styles.closed}>{context?.row.status==='rejected'?tr('Declined — retained for history, not active outreach.','رفض التعاون — محفوظ في السجل، وليس ضمن التواصل النشط.'):tr('Installed — manage ongoing service from its location record.','تم التركيب — تابع الخدمة من سجل الموقع.')}</p>:null}
  {context&&context.canEdit?<>
   <div className={styles.actions} role="group" aria-label={tr('Choose quick action','اختر إجراءً سريعاً')}>{quickModes.filter(m=>(m!=='assign'||context.manager)&&(m!=='next'||!closed)).map(m=><button key={m} type="button" aria-pressed={mode===m} onClick={()=>choose(m)} disabled={Boolean(pending)||busy||blocked||stale||done}>{quickLabels[m][ar?1:0]}</button>)}</div>
   <form onSubmit={submit} className={styles.form}>
    {pending?<p className={styles.notice}>{tr('Saved request awaiting confirmation. Retry it unchanged; do not submit another copy.','طلب محفوظ ينتظر التأكيد. أعده دون تعديل؛ لا ترسل نسخة أخرى.')}</p>:null}
    {message?<p role={done?'status':'alert'} className={styles.notice}>{message}</p>:null}
    {pending?<details className={styles.saved}><summary>{tr('Review submitted details','مراجعة التفاصيل المرسلة')}</summary><dl>{Object.entries(pending.request.values).filter(([k])=>!['version','kind'].includes(k)).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></details>:null}
    <fieldset disabled={locked}>
     {mode==='log'?<><label>{tr('How did you communicate?','كيف تم التواصل؟')}<select name="activity_type" value={values.activity_type||'call'} onChange={e=>set('activity_type',e.target.value)}>{[['call','Call','مكالمة'],['whatsapp','WhatsApp','واتساب'],['email','Email','بريد إلكتروني'],['visit','Visit','زيارة'],['meeting','Meeting','اجتماع'],['proposal','Proposal sent','إرسال عرض'],['note','Internal note','ملاحظة داخلية']].map(([v,en,arabic])=><option value={v} key={v}>{tr(en,arabic)}</option>)}</select></label><label>{tr('What happened and what was the outcome?','ماذا حدث وما النتيجة؟')}<textarea name="summary" value={values.summary||''} onChange={e=>set('summary',e.target.value)} required maxLength={4000} rows={4}/></label><p>{tr('Records an interaction only. It does not send a message, change the stage or complete a task.','يسجّل التواصل فقط. لا يرسل رسالة ولا يغيّر المرحلة ولا يُنهي مهمة.')}</p></>:null}
     {mode==='next'?<>{input('next_action','Next action','الخطوة القادمة','text',true)}{input('next_action_date','Follow-up date','موعد المتابعة','date',true)}<p>{tr('Updates the original lead deadline. No duplicate task or appointment is created.','يحدّث موعد الجهة الأصلي. لا يُنشئ مهمة أو موعداً مكرراً.')}</p></>:null}
     {mode==='contact'?<>{input('contact_person_name','Contact at the place','الشخص المسؤول في الجهة')}{input('contact_phone','Phone','الهاتف','tel')}{input('contact_whatsapp','WhatsApp','واتساب','tel')}{input('contact_email','Email','البريد الإلكتروني','email')}<p>{tr('Keep unknown details blank. This edits the current lead, not a second contact record.','اترك البيانات غير المعروفة فارغة. يعدّل هذا الجهة الحالية ولا ينشئ سجلاً مكرراً.')}</p></>:null}
     {mode==='assign'?<label>{tr('Assigned employee','الموظف المسؤول')}<select name="assigned_to" required value={values.assigned_to||''} onChange={e=>set('assigned_to',e.target.value)}><option value="">{tr('Choose employee','اختر الموظف')}</option>{context.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:null}
     {mode==='stage'?<><label>{tr('Stage','المرحلة')}<select name="status" value={values.status||context.row.status} onChange={e=>set('status',e.target.value)}>{leadStatuses.map(([v,en,arabic])=><option key={v} value={v}>{tr(en,arabic)}</option>)}{context.row.locationId?<option value="machine_placed">{tr('Installed / operating','تم التركيب / التشغيل')}</option>:null}</select></label><label>{tr('Reason / outcome','السبب / النتيجة')}<textarea name="reason" value={values.reason||''} onChange={e=>set('reason',e.target.value)} required maxLength={2000} rows={3}/></label><p>{tr('The reason is appended to existing lead notes and the audited change history. Agreed is not installed.','يُضاف السبب إلى ملاحظات الجهة وسجل التغييرات. الاتفاق لا يعني التركيب.')}</p>{leadIsClosed(values.status)||closed||values.status==='accepted'?<label className={styles.confirm}><input type="checkbox" name="confirm" checked={values.confirm==='true'} onChange={e=>set('confirm',String(e.target.checked))} required/>{tr('I confirm this is the actual outcome, not just a planned next step.','أؤكد أن هذه هي النتيجة الفعلية، وليست مجرد خطوة مخطط لها.')}</label>:null}</>:null}
    </fieldset>
    <footer className={styles.footer}>{done?<button type="button" className={styles.primary} onClick={close}>{tr('Done — return to work','تم — العودة للعمل')}</button>:stale?<button type="button" className={styles.primary} onClick={()=>window.location.reload()}>{tr('Reload latest record','تحميل أحدث سجل')}</button>:<button type="submit" className={styles.primary} disabled={loading||busy||blocked}>{busy?tr('Saving…','جارٍ الحفظ…'):pending?tr('Retry saved request','إعادة الطلب المحفوظ'):mode==='log'?tr('Save activity','حفظ النشاط'):tr('Save changes','حفظ التغييرات')}</button>}<button type="button" className={styles.secondary} disabled={busy} onClick={close}>{tr('Close','إغلاق')}</button></footer>
   </form>
  </>:!loading&&context?<div className={styles.form}><p>{tr('Read-only access. Open the full record or ask the assigned employee to update it.','للاطلاع فقط. افتح السجل الكامل أو اطلب من الموظف المسؤول تحديثه.')}</p></div>:null}
  {loading?<p role="status" className={styles.form}>{tr('Checking the latest record and permissions…','جارٍ التحقق من أحدث سجل والصلاحيات…')}</p>:blocked?<div className={styles.form}><p role="alert">{message}</p><button type="button" className={styles.primary} onClick={()=>window.location.reload()}>{tr('Retry loading','إعادة التحميل')}</button></div>:null}
 </dialog>;
}
