'use client';
import {useRef,useState,useSyncExternalStore} from 'react';
import {useRouter} from 'next/navigation';
import {CrmLeadTable} from '@/components/CrmLeadTable';
import {focusDefaultEnd,focusMessage,validateLeadFocusCommand,confirmedFocusReceipt,type LeadFocusCommand,type FocusSelection} from '@/lib/crm-lead-focus';
import type {LeadRow} from '@/lib/crm-lead-list';
import styles from './CrmLeads.module.css';
type Props={labelsEnabled?:boolean;rows:LeadRow[];ar:boolean;userId:string;today:string;assignees:{id:string;name:string}[];manager:boolean};
const subscribe=()=>()=>{},clientSnapshot=()=>true,serverSnapshot=()=>false;
export function CrmLeadFocusList(props:Props){
 const hydrated=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 if(!hydrated)return <CrmLeadTable rows={props.rows} ar={props.ar} labelsEnabled={props.labelsEnabled} selection={props.manager?{items:[],locked:true,toggle(){}}:undefined}/>;
 return <FocusListClient key={props.userId+':'+props.manager} {...props}/>;
}
function FocusListClient({rows,ar,userId,today,assignees,manager,labelsEnabled=false}:Props){
 const key=`snacky:lead-focus:v1:${userId}`,tr=(en:string,arabic:string)=>ar?arabic:en;
 const [restored]=useState(()=>{if(!manager)return {saved:null,error:false};try{const raw=sessionStorage.getItem(key);return {saved:raw?validateLeadFocusCommand(JSON.parse(raw)):null,error:false};}catch{return {saved:null,error:true};}});
 const [items,setItems]=useState<FocusSelection[]>(restored.saved?.items??[]),[employee,setEmployee]=useState(restored.saved?.assigned_to??''),[until,setUntil]=useState(restored.saved?.until??focusDefaultEnd(today)),[nextAction,setNextAction]=useState(restored.saved?.next_action??'');
 const [pending,setPending]=useState<LeadFocusCommand|null>(restored.saved),[busy,setBusy]=useState(false),[message,setMessage]=useState(restored.error?tr('Browser storage or a saved request needs review. Reload before changing focus. Existing lead editing remains available.','يحتاج تخزين المتصفح أو الطلب المحفوظ إلى مراجعة. أعد التحميل قبل تعديل التركيز. يبقى تعديل الجهة المعتاد متاحاً.'):'');
 const [stale,setStale]=useState(restored.error),[done,setDone]=useState(false),ready=!restored.error;
 const lock=useRef(false),router=useRouter();
 function toggle(row:LeadRow){
  if(!ready||pending||busy||stale||done||!row.data?.version)return;
  setItems(current=>current.some(x=>x.id===row.id)?current.filter(x=>x.id!==row.id):current.length<20?[...current,{id:row.id,version:row.data!.version!,focus_revision:row.focus_revision??0}]:current);
 }
 async function submit(action:'set'|'clear'){
  if(lock.current||!ready||stale||done)return;
  let command=pending;
  if(!command){
   try{command=validateLeadFocusCommand({request_id:crypto.randomUUID(),action,items,assigned_to:action==='set'?employee:null,until:action==='set'?until:null,next_action:action==='set'?(nextAction.trim()||null):null});}
   catch{setMessage(focusMessage('invalid',ar));return;}
   const person=assignees.find(x=>x.id===employee)?.name??'';
   if(!window.confirm(action==='set'?tr(`Assign these ${items.length} places to ${person} and focus through ${until}? Existing follow-up dates are kept.`,`إسناد ${items.length} جهة إلى ${person} وتركيزها حتى ${until}؟ تبقى مواعيد المتابعة الحالية كما هي.`):tr('Remove focus only? Existing assignments, tasks and follow-up dates will stay.','إزالة التركيز فقط؟ يبقى الإسناد والمهام ومواعيد المتابعة كما هي.')))return;
   try{sessionStorage.setItem(key,JSON.stringify(command));}catch{setMessage(tr('Could not preserve a safe retry. Enable browser storage before saving focus.','تعذر حفظ بيانات إعادة المحاولة. فعّل تخزين المتصفح قبل حفظ التركيز.'));return;}
  }
  lock.current=true;setBusy(true);setPending(command);setMessage('');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  try{
   const response=await fetch('/api/crm/lead-focus',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:controller.signal});
   const reply=await response.json();
   if(response.ok&&confirmedFocusReceipt(command,reply)){
    sessionStorage.removeItem(key);setPending(null);setDone(true);setMessage(tr('Saved. Focus is shared in Snacky OS; no outreach or duplicate task was created.','تم الحفظ. يظهر التركيز داخل سناكي؛ لم تُرسل رسائل ولم تُنشأ مهام مكررة.'));router.refresh();
   }else if(reply.ok===false){
    setMessage(focusMessage(reply.code,ar));
    if(reply.retryable===false){sessionStorage.removeItem(key);setPending(null);if(reply.code==='conflict')setStale(true);}
   }else throw Error('Unconfirmed receipt');
  }catch{setMessage(focusMessage('uncertain',ar));}
  finally{clearTimeout(timer);lock.current=false;setBusy(false);}
 }
 const locked=!ready||busy||Boolean(pending)||stale||done;
 const selectedNames=items.map(x=>rows.find(r=>r.id===x.id)?.title).filter(Boolean);
 return <>
  {manager?<section className={styles.focusControls} aria-label={tr('Set lead focus','تحديد تركيز الجهات')}>
   <div className={styles.focusHeading}><strong>{items.length?tr(`${items.length} selected`,`تم تحديد ${items.length}`):tr('Choose this week’s places','اختر جهات التركيز')}</strong><span>{tr('Select up to 20 places. Focus is separate from stage.','حدّد حتى 20 جهة. التركيز مستقل عن المرحلة.')}</span></div>
   {items.length||pending?<form onSubmit={event=>{event.preventDefault();void submit(pending?.action??'set');}}>
    <p className={styles.selectionNames}>{selectedNames.join(ar?'، ':', ')}{selectedNames.length<items.length?tr(' · Includes records from the saved request',' · يشمل سجلات من الطلب المحفوظ'):''}</p>
    {pending?<p role="status">{tr('A save is awaiting confirmation. Retry the same request before changing the selection.','يوجد حفظ ينتظر التأكيد. أعد الطلب نفسه قبل تغيير الاختيار.')}</p>:null}
    <fieldset disabled={locked} className={styles.focusFields}>
     <label>{tr('Assign to employee','إسناد إلى الموظف')}<select value={employee} onChange={e=>setEmployee(e.target.value)} required={!pending||pending.action==='set'}><option value="">{tr('Choose employee','اختر الموظف')}</option>{assignees.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
     <label>{tr('Focus through (inclusive)','التركيز حتى (شاملاً)')}<input type="date" min={today} value={until} onChange={e=>setUntil(e.target.value)} required/></label>
     <label className={styles.focusStep}>{tr('Next action (optional; otherwise retain current)','الخطوة القادمة (اختياري؛ تُحفظ الحالية)')}<input value={nextAction} onChange={e=>setNextAction(e.target.value)} maxLength={1000} placeholder={tr('Research contact details and report back','جمع بيانات التواصل وتسجيل النتيجة')}/></label>
    </fieldset>
    <p className={styles.focusHint}>{tr('Existing follow-up dates stay unchanged. Undated places use the focus end date. A name-only place can be researched without inventing a phone number.','لا تتغير مواعيد المتابعة الحالية. تستخدم الجهة دون موعد تاريخ نهاية التركيز. يمكن البحث عن جهة باسمها فقط دون اختلاق رقم هاتف.')}</p>
    <div className={styles.filterActions}>
     <button className={styles.primary} type="submit" disabled={busy||!ready||stale||done}>{busy?tr('Saving…','جارٍ الحفظ…'):pending?tr('Retry saved request','إعادة الطلب المحفوظ'):tr('Assign & set focus','إسناد وتحديد التركيز')}</button>
     {!pending?<><button className={styles.secondary} type="button" disabled={locked||!items.every(x=>x.focus_revision>0)} onClick={()=>void submit('clear')}>{tr('Remove focus','إزالة التركيز')}</button><button className={styles.secondary} type="button" disabled={locked} onClick={()=>setItems([])}>{tr('Clear selection','مسح الاختيار')}</button></>:null}
    </div>
   </form>:null}
   {message?<p role="status" className={styles.focusHint}>{message}</p>:null}{stale?<button className={styles.secondary} onClick={()=>window.location.reload()}>{tr('Reload records','تحديث السجلات')}</button>:null}
  </section>:null}
  {rows.length?<CrmLeadTable rows={rows} ar={ar} labelsEnabled={labelsEnabled} selection={manager?{items,locked,toggle}:undefined}/>:null}
 </>;
}
