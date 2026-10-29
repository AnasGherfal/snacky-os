'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {useLanguage} from '@/components/I18nProvider';
import {MarketChecklist} from '@/components/MarketChecklist';
import {marketError, marketReceiptMatches, validateMarketCommand, type MarketCommand} from '@/lib/market-checklist';
import type {BuyingList, BuyingWorkspace} from '@/lib/buying-lists';
import styles from './MarketChecklist.module.css';
import buyingStyles from './BuyingLists.module.css';

/** The pending request is immutable until its matching server receipt is verified. */
export function useMarketCommand({userId,identity,revision,onSaved}:{userId:string;identity:string;revision?:number;onSaved?:(command:MarketCommand)=>void}) {
 const {locale}=useLanguage(),ar=locale==='ar',router=useRouter(),lock=useRef(false);
 const key=`snacky:market-command:v1:${userId}:${identity}`;
 const [pending,setPending]=useState<MarketCommand|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false),[confirmedRevision,setConfirmedRevision]=useState<number|null>(null);
 useEffect(()=>{
  let active=true;
  queueMicrotask(()=>{
   if(!active)return;
   try {const raw=sessionStorage.getItem(key);if(raw){const c=validateMarketCommand(JSON.parse(raw));if(identity!=='publish'&&c.list_id!==identity)throw Error('identity');setPending(c);}setReady(true);}
   catch {setError(ar?'تعذر استعادة طلب حفظ سابق. تحقق من القائمة المحفوظة قبل البدء من جديد.':'An interrupted save could not be restored. Check your saved checklist before starting again.');}
  });
  return()=>{active=false;};
 },[key,identity,ar]);
 const waiting=confirmedRevision!==null&&revision!==undefined&&revision<confirmedRevision;
 async function send(next:MarketCommand):Promise<boolean>{
  if(lock.current||!ready||stale||waiting)return false;
  lock.current=true;
  let command=pending;
  try {
   if(command&&JSON.stringify(command)!==JSON.stringify(next)){lock.current=false;return false;}
   if(!command){command=validateMarketCommand(next);sessionStorage.setItem(key,JSON.stringify(command));}
  }catch{lock.current=false;setError(ar?'تعذر حفظ طلب التعديل على الجهاز. لم يتم إرساله.':'Could not preserve the change on this device. It was not sent.');return false;}
  if(!command){lock.current=false;return false;}
  setPending(command);setBusy(true);setError('');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  try {
   const response=await fetch('/api/buying-lists/checklist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:controller.signal});
   const result=await response.json();
   if(response.ok&&marketReceiptMatches(command,result)){
    try{sessionStorage.removeItem(key);}catch{/* Replaying a confirmed identity remains safe. */}
    setPending(null);
    if(revision!==undefined)setConfirmedRevision(result.revision);
    try{if(onSaved)onSaved(command);else router.refresh();}catch{setError(ar?'تم الحفظ. أعد تحميل الصفحة لعرضه.':'Saved. Reload the page to see the result.');}
    return true;
   }
   if(result.ok===false&&result.retryable===false){
    setError(marketError(result.code,ar));
    try{sessionStorage.removeItem(key);}catch{/* The same request is still safe to restore. */}
    setPending(null);
    if(result.code==='conflict'||result.code==='denied')setStale(true);
    return false;
   }
   setError(marketError(result.code??'uncertain',ar));
   return false;
  }catch{setError(marketError('uncertain',ar));return false;}
  finally{clearTimeout(timer);setBusy(false);lock.current=false;}
 }
 const status=<>
  {error?<p className={styles.error} role="alert">{error}</p>:null}
  {pending?<div className={styles.notice}><p>{ar?'يوجد تعديل محفوظ ينتظر التأكيد. أعد نفس التعديل قبل متابعة التسوق.':'A saved change is waiting for confirmation. Retry that same change before continuing.'}</p><button type="button" className={styles.primary} disabled={busy||stale} onClick={()=>void send(pending)}>{ar?'إعادة الحفظ':'Retry saved change'}</button></div>:null}
  {stale||waiting?<div className={styles.notice}><p role="status">{waiting?(ar?'تم الحفظ. جارٍ تحميل آخر نسخة…':'Saved. Loading the latest checklist…'):(ar?'حمّل آخر نسخة قبل المتابعة.':'Load the latest checklist to continue.')}</p><button type="button" className={styles.secondary} onClick={()=>window.location.reload()}>{ar?'تحميل آخر نسخة':'Reload latest checklist'}</button></div>:null}
  {!ready&&error?<div className={styles.notice}><Link href="/buying-lists">{ar?'مراجعة القوائم المحفوظة':'Check saved lists'}</Link><p>{ar?'بعد التحقق من أن التعديل السابق لم يُحفظ، يمكنك بدء طلب جديد.':'After checking that the earlier change was not saved, you can start a new request.'}</p><button type="button" className={styles.secondary} onClick={()=>{
   if(!window.confirm(ar?'هل تحققت من القوائم وتأكدت أن التعديل السابق لم يُحفظ؟ بدء طلب جديد قد يكرر التعديل إذا كان قد حُفظ.':'Have you checked the saved lists and confirmed the earlier change was not saved? Starting again could duplicate it if it was saved.'))return;
   try{sessionStorage.removeItem(key);setPending(null);setReady(true);setStale(false);setError('');lock.current=false;}
   catch{setError(ar?'تعذر تحديث الطلب المحفوظ على الجهاز. أبقِ الصفحة مفتوحة وحاول مجدداً.':'Could not update the saved request on this device. Keep this page open and retry.');}
  }}>{ar?'بدء طلب جديد بعد التحقق':'Start again after checking'}</button></div>:null}
 </>;
 return {send,status,locked:!ready||busy||Boolean(pending)||stale||waiting,busy,ready};
}

export function SharedMarketChecklist({list,userId,memberId,planner,people}:{list:BuyingList;userId:string;memberId:string;planner:boolean;people:BuyingWorkspace['people']}) {
 const {locale}=useLanguage(),ar=locale==='ar',command=useMarketCommand({userId,identity:list.id,revision:list.revision});
 const [buyer,setBuyer]=useState<string|null>(null),selectedBuyer=buyer??list.assigned_to;
 const items=list.checklist_items??[];
 const canEdit=list.status==='open'&&(planner||list.assigned_to===memberId);
 const resolved=items.length>0&&items.every(item=>item.acquired_quantity===item.quantity||item.unavailable);
 const missing=items.filter(item=>item.acquired_quantity<item.quantity).length;
 const make=(action:MarketCommand['action'],payload:Record<string,unknown>={}):MarketCommand=>({request_id:crypto.randomUUID(),list_id:list.id,revision:list.revision,action,payload});
 return <div className={buyingStyles.progress}>
  <h2>{ar?'أثناء التسوق':'While you shop'}</h2>
  <p className={buyingStyles.hint}>{ar?'أضف ما تحتاجه وحدد البدائل المقبولة، ثم ضع علامة على ما حصلت عليه. تبقى تفاصيل الإيصال والمخزون منفصلة.':'Add what you need, choose acceptable alternatives, then tick what you find. Receipt details and stock receiving stay separate.'}</p>
  {command.status}
  {list.status!=='open'?<p className={styles.notice}>{list.status==='completed'?(ar?'انتهت مراجعة القائمة. قد تبقى عناصر غير متوفرة؛ راجعها في «المتبقي».':'Shopping review is finished. Unavailable needs may remain; find them under Remaining.'):(ar?'هذه القائمة ملغاة.':'This checklist is cancelled.')}</p>:null}
  <MarketChecklist items={items} ar={ar} draftKey={`snacky:market-input:${userId}:${list.id}`} disabled={command.locked} allowEdit={canEdit}
   onAdd={item=>command.send(make('add',{item}))}
   onEdit={item=>command.send(make('edit',{item}))}
   onProgress={payload=>command.send(make('progress',payload))}
   onRemove={item_id=>command.send(make('remove',{item_id}))}/>
  {canEdit?<div className={buyingStyles.actions}><button type="button" className={styles.primary} disabled={command.locked||!resolved} onClick={()=>{if(!missing||window.confirm(ar?'ستُنهي المراجعة مع وجود عناصر غير متوفرة. ستبقى ظاهرة كمتبقية. متابعة؟':'Finish reviewing with unavailable needs? They will remain visible as still needed.'))void command.send(make('complete'));}}>{ar?'إنهاء التسوق':'Finish shopping'}</button><span className={styles.hint}>{ar?'راجع كل حاجة، بما فيها ما لم تجده. لا يُنشئ هذا الزر إيصالاً أو حركة مخزون.':'Review every need, including anything not found. Finishing does not create a receipt or stock movement.'}</span></div>:null}
  {planner&&list.status==='completed'?<button type="button" className={styles.secondary} disabled={command.locked} onClick={()=>void command.send(make('reopen'))}>{ar?'إعادة فتح القائمة':'Reopen checklist'}</button>:null}
  {planner&&list.status==='open'?<details className={buyingStyles.admin}><summary>{ar?'إسناد القائمة أو إلغاؤها':'Assignment and cancellation'}</summary><div className={buyingStyles.actions}><label>{ar?'المشتري':'Buyer'}<select value={selectedBuyer} onChange={e=>setBuyer(e.target.value)} disabled={command.locked}>{people.map(person=><option value={person.id} key={person.id}>{person.name}</option>)}</select></label><button type="button" className={styles.secondary} disabled={command.locked||selectedBuyer===list.assigned_to} onClick={async()=>{if(await command.send(make('assign',{assigned_to:selectedBuyer})))setBuyer(null);}}>{ar?'حفظ الإسناد':'Save assignment'}</button><button type="button" className={styles.remove} disabled={command.locked} onClick={()=>{const reason=window.prompt(ar?'سبب إلغاء القائمة:':'Reason for cancelling the checklist:');if(reason?.trim())void command.send(make('cancel',{reason}));}}>{ar?'إلغاء القائمة':'Cancel checklist'}</button></div></details>:null}
 </div>;
}
