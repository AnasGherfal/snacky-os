'use client';

import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import type {MarketChecklistItem} from '@/lib/market-checklist';
import {buyingUuid} from '@/lib/buying-lists';
import {marketFlexibilityLabel, marketUnitLabel} from '@/lib/market-checklist-labels';
import styles from './MarketChecklist.module.css';

export type MarketProgressPayload = Pick<MarketChecklistItem, 'acquired_quantity'|'unavailable'|'note'> & {item_id:string};
export type MarketChecklistProps = {
 items:MarketChecklistItem[];
 disabled?:boolean;
 allowEdit?:boolean;
 draftKey:string;
 ar:boolean;
 onAdd:(item:MarketChecklistItem)=>Promise<boolean>;
 onEdit:(item:MarketChecklistItem)=>Promise<boolean>;
 onProgress:(payload:MarketProgressPayload)=>Promise<boolean>;
 onRemove:(itemId:string)=>Promise<boolean>;
};

type ItemDraft = {id:string|null;label:string;quantity:string;unit:MarketChecklistItem['unit'];flexibility:MarketChecklistItem['flexibility'];note:string};
type ProgressDraft = {acquired:string;unavailable:boolean;note:string};

function isItemDraft(value:unknown):value is ItemDraft {
 if(!value || typeof value!=='object')return false;
 const d=value as ItemDraft;
 return (d.id===null||(typeof d.id==='string'&&buyingUuid.test(d.id)))&&typeof d.label==='string'&&d.label.length<=160&&typeof d.quantity==='string'&&d.quantity.length<=8&&['boxes','packs','units'].includes(d.unit)&&['exact','any_flavour','any_brand'].includes(d.flexibility)&&typeof d.note==='string'&&d.note.length<=1000;
}
function isProgressDraft(value:unknown):value is ProgressDraft {
 if(!value || typeof value!=='object')return false;
 const d=value as ProgressDraft;
 return typeof d.acquired==='string'&&d.acquired.length<=8&&typeof d.unavailable==='boolean'&&typeof d.note==='string'&&d.note.length<=1000;
}

function foldMarketSearch(value:string) {
 return value.normalize('NFKC').toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').trim();
}

/** A quick check must never discard unfinished quantity or note edits. */
function hasUnsavedRowInput(item:MarketChecklistItem,draftKey:string) {
 try {
  const progressRaw=localStorage.getItem(`${draftKey}:${item.id}:progress`);
  if(progressRaw){
   const value:unknown=JSON.parse(progressRaw);
   if(!isProgressDraft(value)||value.acquired!==String(item.acquired_quantity)||value.unavailable!==item.unavailable||value.note!==item.note)return true;
  }
  const editRaw=localStorage.getItem(`${draftKey}:${item.id}:edit`);
  if(editRaw){
   const value:unknown=JSON.parse(editRaw);
   if(!isItemDraft(value)||value.id!==item.id||value.label.trim()!==item.label||Number(value.quantity)!==item.quantity||value.unit!==item.unit||value.flexibility!==item.flexibility||value.note!==item.note)return true;
  }
  return false;
 }catch{return true;}
}

/** These are input backups only. A server response remains the authority for shared progress. */
function useInputDraft<T>(key:string, initial:T, valid:(value:unknown)=>value is T, ar:boolean) {
 const [value,setValue]=useState(initial),[ready,setReady]=useState(false),[error,setError]=useState(''),[hasDraft,setHasDraft]=useState(false);
 useEffect(()=>{
  // Hydrate the browser-only backup after the server-rendered field has mounted.
  let active=true;
  queueMicrotask(()=>{
   if(!active)return;
   try {const raw=localStorage.getItem(key);if(raw!==null){const parsed:unknown=JSON.parse(raw);if(!valid(parsed))throw Error('invalid');setValue(parsed);setHasDraft(true);}setReady(true);}
   catch {setError(ar?'تعذر استعادة مسودة هذا الحقل. لم يتم تغيير القائمة المحفوظة.':'This input draft could not be restored. The saved checklist has not changed.');}
  });
  return()=>{active=false;};
 },[key,valid,ar]);
 const update=useCallback((next:T)=>{setValue(next);setHasDraft(true);try{localStorage.setItem(key,JSON.stringify(next));setError('');}catch{setError(ar?'تعذر حفظ المسودة على الجهاز. أبقِ الصفحة مفتوحة حتى تؤكد الحفظ.':'Could not back up this draft on the device. Keep this page open until saving is confirmed.');}},[key,ar]);
 const clear=useCallback((next:T)=>{try{localStorage.removeItem(key);}catch{/* A confirmed save remains authoritative. */}setValue(next);setHasDraft(false);setReady(true);setError('');},[key]);
 return {value,update,clear,ready,error,hasDraft};
}

function ItemForm({item,persistedItems=[],draftKey,ar,disabled,onSave}:{item?:MarketChecklistItem;persistedItems?:MarketChecklistItem[];draftKey:string;ar:boolean;disabled:boolean;onSave:(item:MarketChecklistItem)=>Promise<boolean>}) {
 const initial:ItemDraft={id:item?.id??null,label:item?.label??'',quantity:String(item?.quantity??1),unit:item?.unit??'boxes',flexibility:item?.flexibility??'exact',note:item?.note??''};
 const draft=useInputDraft(draftKey,initial,isItemDraft,ar),[error,setError]=useState(''),lock=useRef(false);
 const {value,ready,hasDraft,clear}=draft;
 useEffect(()=>{
  if(!ready||!hasDraft||!value.id)return;
  const saved=item??persistedItems.find(row=>row.id===value.id);
  if(saved&&saved.id===value.id&&saved.label===value.label.trim()&&saved.quantity===Number(value.quantity)&&saved.unit===value.unit&&saved.flexibility===value.flexibility&&(item||saved.note===value.note)){
   clear(item?value:{id:null,label:'',quantity:'1',unit:'boxes',flexibility:'exact',note:''});
  }
 },[item,persistedItems,value,ready,hasDraft,clear]);
 async function submit(event:FormEvent){
  event.preventDefault();if(disabled||!draft.ready||lock.current)return;
  const quantity=Number(draft.value.quantity);
  if(!draft.value.label.trim()||!Number.isSafeInteger(quantity)||quantity<1||quantity>10000||quantity<(item?.acquired_quantity??0)){setError(ar?'راجع الاسم والكمية. لا تقلل المطلوب عن الكمية التي حصلت عليها.':'Check the name and quantity. Requested quantity cannot be less than the amount already acquired.');return;}
  lock.current=true;setError('');
  try {
   const id=item?.id??draft.value.id??crypto.randomUUID();
   draft.update({...draft.value,id});
   const confirmed=await onSave({id,product_id:item?.product_id??null,label:draft.value.label.trim(),quantity,unit:draft.value.unit,flexibility:draft.value.flexibility,acquired_quantity:item?.acquired_quantity??0,unavailable:item?.unavailable??false,note:item?.note??draft.value.note});
   if(confirmed)draft.clear(item?{...draft.value,id}:{id:null,label:'',quantity:'1',unit:'boxes',flexibility:'exact',note:''});
  }catch{setError(ar?'لم يتأكد حفظ العنصر. مسودتك ما زالت هنا.':'The item save was not confirmed. Your draft is still here.');}
  finally{lock.current=false;}
 }
 return <form className={styles.form} onSubmit={submit}>
  {draft.error?<div className={styles.error} role="alert">{draft.error}{!draft.ready?<button type="button" className={styles.secondary} onClick={()=>{if(window.confirm(ar?'تجاهل المسودة غير المقروءة لهذا الحقل؟':'Discard this unreadable input draft?'))draft.clear(initial);}}>{ar?'تجاهل مسودة الحقل':'Discard input draft'}</button>:null}</div>:null}{error?<p className={styles.error} role="alert">{error}</p>:null}
  <fieldset className={styles.fields} disabled={disabled||!draft.ready}>
   <label className={styles.wide}>{ar?'ما الذي تحتاج شراءه؟':'What do you need?'}<input name="label" required maxLength={160} value={draft.value.label} placeholder={ar?'مثلاً: بيبيتو، مستر كرانش، أو شيبس':'e.g. Bebeto, Mr Crunch, or chips'} onChange={e=>draft.update({...draft.value,label:e.target.value})}/></label>
   <label>{ar?'الكمية المطلوبة':'Quantity needed'}<input name="quantity" required type="number" inputMode="numeric" min={Math.max(1,item?.acquired_quantity??0)} max={10000} step={1} value={draft.value.quantity} onChange={e=>draft.update({...draft.value,quantity:e.target.value})}/></label>
   <label>{ar?'وحدة الشراء':'Buying unit'}<select name="unit" disabled={(item?.acquired_quantity??0)>0} value={draft.value.unit} onChange={e=>draft.update({...draft.value,unit:e.target.value as ItemDraft['unit']})}>{(['boxes','packs','units'] as const).map(unit=><option key={unit} value={unit}>{marketUnitLabel(unit,ar)}</option>)}</select>{(item?.acquired_quantity??0)>0?<small className={styles.hint}>{ar?'صفّر الكمية التي حصلت عليها قبل تغيير وحدة الشراء.':'Reset acquired quantity before changing the buying unit.'}</small>:null}</label>
   <label className={styles.wide}>{ar?'البدائل المقبولة':'Acceptable alternatives'}<select name="flexibility" value={draft.value.flexibility} onChange={e=>draft.update({...draft.value,flexibility:e.target.value as ItemDraft['flexibility']})}>{(['exact','any_flavour','any_brand'] as const).map(value=><option key={value} value={value}>{marketFlexibilityLabel(value,ar)}</option>)}</select></label>
   {!item?<label className={styles.wide}>{ar?'ملاحظة للمشتري':'Shopping note'}<textarea name="note" rows={2} maxLength={1000} value={draft.value.note} placeholder={ar?'مثلاً: الأهم الحصول على الشيبس؛ النكهة حسب المتوفر':'e.g. Chips are the priority; choose an available flavour'} onChange={e=>draft.update({...draft.value,note:e.target.value})}/></label>:<p className={styles.hint}>{ar?'لتعديل الملاحظة، افتح «تحديث الكمية أو الملاحظة».':'To change a note, use Update quantity or note.'}</p>
  </fieldset>
  <div className={styles.formActions}><button type="submit" className={styles.primary} disabled={disabled||!draft.ready}>{item?(ar?'حفظ التعديل':'Save changes'):(ar?'إضافة للقائمة':'Add to checklist')}</button><span className={styles.hint}>{ar?'هذه حاجة للشراء. سجّل الصنف الفعلي في الإيصال لاحقاً.':'This describes a shopping need. Record the actual product on the receipt later.'}</span></div>
 </form>;
}

function ProgressForm({item,draftKey,ar,disabled,onSave}:{item:MarketChecklistItem;draftKey:string;ar:boolean;disabled:boolean;onSave:(payload:MarketProgressPayload)=>Promise<boolean>}) {
 const draft=useInputDraft(draftKey,{acquired:String(item.acquired_quantity),unavailable:item.unavailable,note:item.note},isProgressDraft,ar),[error,setError]=useState(''),lock=useRef(false);
 const {value,ready,hasDraft,clear}=draft;
 useEffect(()=>{if(ready&&hasDraft&&Number(value.acquired)===item.acquired_quantity&&value.unavailable===item.unavailable&&value.note===item.note)clear(value);},[item,value,ready,hasDraft,clear]);
 async function submit(event:FormEvent){
  event.preventDefault();if(disabled||!draft.ready||lock.current)return;
  const acquired=draft.value.unavailable?0:Number(draft.value.acquired);
  if(!Number.isSafeInteger(acquired)||acquired<0||acquired>item.quantity){setError(ar?'أدخل كمية بين صفر والكمية المطلوبة.':'Enter a quantity from zero to the requested amount.');return;}
  lock.current=true;setError('');
  try{if(await onSave({item_id:item.id,acquired_quantity:acquired,unavailable:draft.value.unavailable,note:draft.value.note}))draft.clear({...draft.value,acquired:String(acquired)});}
  catch{setError(ar?'لم يتأكد تحديث التقدم. مسودتك ما زالت هنا.':'Progress was not confirmed. Your draft is still here.');}
  finally{lock.current=false;}
 }
 return <form className={styles.form} onSubmit={submit}>
  {draft.error?<div className={styles.error} role="alert">{draft.error}{!draft.ready?<button type="button" className={styles.secondary} onClick={()=>{if(window.confirm(ar?'تجاهل المسودة غير المقروءة لهذا الحقل؟':'Discard this unreadable input draft?'))draft.clear({acquired:String(item.acquired_quantity),unavailable:item.unavailable,note:item.note});}}>{ar?'تجاهل مسودة الحقل':'Discard input draft'}</button>:null}</div>:null}{error?<p className={styles.error} role="alert">{error}</p>:null}
  <fieldset className={styles.fields} disabled={disabled||!draft.ready}>
   <label>{ar?'الكمية التي حصلت عليها':'Quantity acquired'}<input type="number" inputMode="numeric" min={0} max={item.quantity} step={1} required disabled={draft.value.unavailable} value={draft.value.acquired} onChange={e=>draft.update({...draft.value,acquired:e.target.value})}/></label>
   <label className={styles.checkboxLabel}><input type="checkbox" checked={draft.value.unavailable} disabled={Number(draft.value.acquired)>0&&!draft.value.unavailable} onChange={e=>draft.update({...draft.value,unavailable:e.target.checked})}/>{ar?'لم أجد أي كمية':'None found'}</label>
   <label className={styles.wide}>{ar?'ملاحظة / ما الذي وجدته؟':'Note / what did you find?'}<textarea rows={2} maxLength={1000} value={draft.value.note} onChange={e=>draft.update({...draft.value,note:e.target.value})}/></label>
  </fieldset>
  <div className={styles.formActions}><button type="submit" className={styles.primary} disabled={disabled||!draft.ready}>{ar?'حفظ التقدم':'Save progress'}</button><p className={styles.hint}>{ar?'يبقى النقص ظاهراً في «المتبقي» حتى تحصل عليه.':'Any shortfall stays visible in Remaining until you get it.'}</p></div>
 </form>;
}

export function MarketChecklist({items,disabled=false,allowEdit=true,draftKey,ar,onAdd,onEdit,onProgress,onRemove}:MarketChecklistProps) {
 const [filter,setFilter]=useState<'remaining'|'got'|'all'>('remaining'),[search,setSearch]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),lock=useRef(false);
 const acquired=items.filter(item=>item.acquired_quantity===item.quantity).length;
 const remaining=items.length-acquired,unavailable=items.filter(item=>item.unavailable).length;
 const statusItems=items.filter(item=>filter==='all'||(filter==='got'?item.acquired_quantity===item.quantity:item.acquired_quantity<item.quantity));
 const query=foldMarketSearch(search);
 const visible=statusItems.filter(item=>foldMarketSearch(`${item.label} ${item.note}`).includes(query));
 const locked=disabled||busy;
 async function run(action:()=>Promise<boolean>){if(lock.current||disabled)return false;lock.current=true;setBusy(true);setError('');try{return await action();}catch{setError(ar?'لم يتأكد الحفظ. تحقق من اتصالك وحاول مجدداً.':'Save was not confirmed. Check your connection and retry.');return false;}finally{lock.current=false;setBusy(false);}}
 return <section className={styles.checklist} dir={ar?'rtl':'ltr'} aria-label={ar?'قائمة السوق':'Market checklist'}>
  <div className={styles.summary}><div aria-live="polite"><strong>{remaining} {ar?'متبقٍ للشراء':'left to get'}</strong><p>{acquired} / {items.length} {ar?'تم الحصول عليها':'needs acquired'}{unavailable?` · ${unavailable} ${ar?'غير متوفر':'not found'}`:''}</p></div><div className={styles.filters} aria-label={ar?'عرض العناصر':'Show items'}>{(['remaining','got','all'] as const).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value==='remaining'?(ar?'المتبقي':'Remaining'):value==='got'?(ar?'حصلت عليه':'Got'):ar?'الكل':'All'}</button>)}</div></div>
  <div className={styles.searchBar}><label className={styles.searchLabel}>{ar?'ابحث عن منتج أو ملاحظة':'Find a product or note'}<input type="search" value={search} placeholder={ar?'بحث في العرض المحدد…':'Search this view…'} onChange={event=>setSearch(event.target.value)}/></label>{search?<button type="button" onClick={()=>setSearch('')}>{ar?'مسح البحث':'Clear search'}</button>:null}</div>
  {query?<p className={styles.hint} role="status">{ar?`تظهر ${visible.length} من ${statusItems.length} في العرض المحدد`:`Showing ${visible.length} of ${statusItems.length} in this view`}</p>:null}
  {error?<p className={styles.error} role="alert">{error}</p>:null}
  {busy?<p role="status" className={styles.hint}>{ar?'جارٍ حفظ التغيير…':'Saving change…'}</p>:null}
  {allowEdit?<details className={styles.add}><summary>+ {ar?'إضافة شيء للقائمة':'Add something to the list'}</summary><ItemForm persistedItems={items} draftKey={`${draftKey}:add`} ar={ar} disabled={locked||items.length>=200} onSave={item=>run(()=>onAdd(item))}/>{items.length>=200?<p className={styles.hint}>{ar?'تحتوي القائمة على الحد الأقصى: 200 عنصر.':'This checklist has reached its 200-item limit.'}</p>:null}</details>:null}
  <div className={styles.cards}>{visible.map(item=>{
   const got=item.acquired_quantity===item.quantity,left=item.quantity-item.acquired_quantity;
   return <article key={item.id} className={`${styles.card} ${got?styles.acquired:''}`}>
    <label className={styles.checkRow}><input type="checkbox" checked={got} disabled={locked||!allowEdit} aria-label={`${ar?'حصلت على':'Got'} ${item.label}`} onChange={e=>{if(hasUnsavedRowInput(item,draftKey)){setError(ar?'يوجد تعديل غير محفوظ لهذا العنصر. احفظه أولاً قبل وضع علامة الإنجاز.':'This item has unsaved edits. Save them before ticking it off.');return;}const checked=e.target.checked;void run(()=>onProgress({item_id:item.id,acquired_quantity:checked?item.quantity:0,unavailable:false,note:item.note}));}}/><span className={styles.itemText}><strong>{item.label}</strong><span className={styles.quantity}>{item.acquired_quantity} / {item.quantity} {marketUnitLabel(item.unit,ar)}{!got?` · ${left} ${ar?'متبقٍ':'left'}`:''}</span><span className={styles.flexibility}>{marketFlexibilityLabel(item.flexibility,ar)}</span><span className={`${styles.status} ${item.unavailable?styles.missing:''}`}>{got?(ar?'حصلت عليه':'Got it'):item.unavailable?(ar?'غير متوفر — ما زال مطلوباً':'Not found — still needed'):item.acquired_quantity>0?(ar?'تم الحصول على جزء':'Partly acquired'):(ar?'ما زال مطلوباً':'Still needed')}</span></span></label>
    {item.note?<p className={styles.note}>{item.note}</p>:null}
    {allowEdit?<><details className={styles.details}><summary>{ar?'تحديث الكمية أو الملاحظة':'Update quantity or note'}</summary><ProgressForm key={`${item.id}:${item.acquired_quantity}:${item.unavailable}:${item.note}`} item={item} draftKey={`${draftKey}:${item.id}:progress`} ar={ar} disabled={locked} onSave={payload=>run(()=>onProgress(payload))}/></details><details className={styles.details}><summary>{ar?'تعديل الحاجة للشراء':'Edit shopping need'}</summary><ItemForm key={`${item.id}:${item.label}:${item.quantity}:${item.unit}:${item.flexibility}`} item={item} draftKey={`${draftKey}:${item.id}:edit`} ar={ar} disabled={locked} onSave={next=>run(()=>onEdit(next))}/><button type="button" className={styles.remove} disabled={locked} onClick={()=>{if(window.confirm(ar?`إزالة «${item.label}» من هذه القائمة؟`:`Remove “${item.label}” from this checklist?`))void run(()=>onRemove(item.id));}}>{ar?'إزالة من القائمة':'Remove from checklist'}</button></details></>:null}
   </article>;
  })}</div>
  {!visible.length?<div className={styles.empty}>{query?(ar?'لا توجد نتائج في هذا العرض. جرّب «الكل» أو امسح البحث.':'No matches in this view. Try All or clear the search.'):!items.length?(ar?'أضف ما تحتاجه، أو ابدأ من اقتراحات الشراء.':'Add what you need, or start with purchase suggestions.'):filter==='remaining'?(ar?'حصلت على كل ما في القائمة. يمكنك تسجيل الإيصال بشكل منفصل.':'You have everything on this checklist. You can record the receipt separately.'):filter==='got'?(ar?'لم يتم تحديد أي عنصر كمكتمل بعد.':'Nothing has been marked acquired yet.'):(ar?'لا توجد عناصر.':'No items.')}</div>:null}
 </section>;
}
