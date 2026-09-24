'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {useLanguage} from '@/components/I18nProvider';
import {buyingError,buyingReceiptMatches,validateBuyingCommand,buyingOutcomeLabels,type BuyingCommand,type BuyingItem,type BuyingList,type BuyingWorkspace} from '@/lib/buying-lists';
import {buyingStoreGroups,type BuyingSources,type BuyingSource} from '@/lib/buying-sources';
import {BuyingSourceDetails,BuyingSourceEditor} from './BuyingSourceEditor';
import type {RestockShoppingListItem} from '@/lib/restock-shopping-list';
import styles from './BuyingLists.module.css';

function useBuyingCommand(userId:string,identity:string,onSaved?:(c:BuyingCommand)=>void){
 const {locale}=useLanguage(),ar=locale==='ar',router=useRouter();const key=`snacky:buying:v1:${userId}:${identity}`,lock=useRef(false);
 const [pending,setPending]=useState<BuyingCommand|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false);
 useEffect(()=>{try{const raw=sessionStorage.getItem(key);if(raw){const c=validateBuyingCommand(JSON.parse(raw));if(identity!=='publish'&&c.list_id!==identity)throw Error('invalid');setPending(c);}setReady(true);}catch{setError(ar?'تعذر قراءة طلب محفوظ. لا تُنشئ نسخة مكررة؛ أعد فتح هذا التبويب بعد التحقق من تخزين المتصفح.':'A saved request could not be read. Do not create a duplicate; check browser storage and reload.');}},[key,identity,ar]);
 async function send(c:BuyingCommand){
  if(lock.current||!ready||stale)return;lock.current=true;
  let command=pending;
  try{if(!command){command=validateBuyingCommand(c);sessionStorage.setItem(key,JSON.stringify(command));}}
  catch{setError(buyingError('invalid',ar));lock.current=false;return;}
  setPending(command);setBusy(true);setError('');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  try{
   const response=await fetch('/api/buying-lists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:controller.signal});const result=await response.json();
   if(response.ok&&buyingReceiptMatches(command,result)){
    try{sessionStorage.removeItem(key);}catch{/* A confirmed receipt remains authoritative. */}
    setPending(null);onSaved?.(command);router.refresh();
   }else if(result.ok===false){setError(buyingError(result.code,ar));if(result.retryable===false){sessionStorage.removeItem(key);setPending(null);if(result.code==='conflict'||result.code==='denied')setStale(true);}}
   else throw Error('receipt');
  }catch{setError(buyingError('uncertain',ar));}finally{clearTimeout(timer);setBusy(false);lock.current=false;}
 }
 const status=<>{error?<p className={styles.error} role="alert">{error}</p>:null}{pending?<div className={styles.notice}><p>{ar?'يوجد طلب محفوظ لم يتأكد. أعد الطلب نفسه قبل أي تغيير آخر.':'A saved request is awaiting confirmation. Retry it before making another change.'}</p><button type="button" className={styles.primary} disabled={busy||stale} onClick={()=>void send(pending)}>{ar?'إعادة الطلب المحفوظ':'Retry saved request'}</button></div>:null}{stale?<button type="button" className={styles.secondary} onClick={()=>window.location.reload()}>{ar?'تحميل أحدث قائمة':'Reload latest list'}</button>:null}</>;
 return {send,status,locked:!ready||busy||Boolean(pending)||stale,pending,busy,ready};
}
export function ShareBuyingList({items,blocked,userId}:{items:RestockShoppingListItem[];blocked:boolean;userId:string}){
 const {locale}=useLanguage(),ar=locale==='ar',router=useRouter();const [context,setContext]=useState<BuyingWorkspace|null>(null),[failed,setFailed]=useState(false),[title,setTitle]=useState(ar?'شراء منتجات للمخزن':'Storage buying list'),[buyer,setBuyer]=useState(''),[date,setDate]=useState(''),[notes,setNotes]=useState('');
 const command=useBuyingCommand(userId,'publish',c=>router.push(`/buying-lists/${c.list_id}`));
 useEffect(()=>{let alive=true;const abort=new AbortController();fetch('/api/buying-lists',{cache:'no-store',signal:abort.signal}).then(r=>r.json()).then(r=>{if(!alive)return;if(!r.ok)throw Error('load');setContext(r.data);setDate(r.data.today);}).catch(()=>{if(alive)setFailed(true);});return()=>{alive=false;abort.abort();};},[]);
 async function submit(event:FormEvent){event.preventDefault();if(blocked||!items.length)return;await command.send({request_id:crypto.randomUUID(),list_id:crypto.randomUUID(),action:'create',revision:0,payload:{title,instructions:notes,assigned_to:buyer,due_on:date,items:items.map(i=>({product_id:i.productId,boxes:i.boxesQty,units_per_box:i.unitsPerBox}))}});}
 return <section className={`${styles.workspace} ${styles.share}`} dir={ar?'rtl':'ltr'}>
  <div className={styles.header}><div><h2>{ar?'أرسل القائمة إلى المشتري':'Share with the buyer'}</h2><p>{ar?'القائمة أعلاه مسودة على جهازك. الإسناد يحفظ نسخة مشتركة يفتحها المشتري بحسابه.':'The list above is a draft on this device. Assigning it saves a shared copy the buyer opens with their own account.'}</p></div><Link className={styles.secondary} href="/buying-lists">{ar?'القوائم المشتركة':'Shared lists'}</Link></div>
  {command.status}
  {failed?<p role="alert" className={styles.error}>{buyingError('unavailable',ar)} <button type="button" onClick={()=>window.location.reload()}>{ar?'إعادة التحميل':'Reload'}</button></p>:!context?<p role="status">{ar?'جارٍ التحقق من الموظفين…':'Checking staff access…'}</p>:!context.planner?<p>{ar?'مشاركة الخطط متاحة لمسؤول الشراء.':'A purchasing planner can share this list.'}</p>:items.length?<form onSubmit={submit}>
   <fieldset disabled={command.locked||blocked} className={styles.fields}>
    <label>{ar?'اسم القائمة':'List title'}<input value={title} onChange={e=>setTitle(e.target.value)} required maxLength={160}/></label>
    <label>{ar?'المشتري المسؤول':'Assigned buyer'}<select value={buyer} onChange={e=>setBuyer(e.target.value)} required><option value="">{ar?'اختر الموظف':'Choose employee'}</option>{context.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>{ar?'موعد الشراء':'Due date'}<input type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label>
    <label className={styles.wide}>{ar?'تعليمات للمشتري':'Buyer instructions'}<textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2} maxLength={3000}/></label>
   </fieldset>
   <p className={styles.hint}>{ar?'راجع الصناديق قبل الإسناد. النسخة المشتركة تحتفظ بهذه الكميات؛ لا تنشئ عملية شراء أو حركة مخزون أو دفعة مالية.':'Review the boxes before assigning. The shared copy keeps these quantities; it creates no purchase, stock movement or payment.'}</p>
   <button className={styles.primary} type="submit" disabled={command.locked||blocked}>{command.busy?(ar?'جارٍ الحفظ…':'Saving…'):(ar?'حفظ وإسناد القائمة':'Save & assign list')}</button>
  </form>:<p>{ar?'أضف منتجات للقائمة المحلية أولاً.':'Add products to the local planning list first.'}</p>}
 </section>;
}
export function BuyingProgress({list,userId,planner,people,sources=null}:{list:BuyingList;userId:string;planner:boolean;people:BuyingWorkspace['people'];sources?:BuyingSources|null}){
 const {locale}=useLanguage(),ar=locale==='ar';const command=useBuyingCommand(userId,list.id);const [buyer,setBuyer]=useState(list.assigned_to);
 const make=(action:BuyingCommand['action'],payload:Record<string,unknown>={})=>({request_id:crypto.randomUUID(),list_id:list.id,action,revision:list.revision,payload});
 return <div className={styles.progress}>
  {command.status}
  {list.status==='open'?<>
   <h2>{ar?'تحديث نتائج الشراء':'Record buying progress'}</h2><p className={styles.hint}>{ar?'سجّل الكمية التي اشتريتها فعلياً. الكمية غير المتوفرة تحتاج سبباً. شراء المنتجات لا يعني استلامها في مخزن النظام.':'Record what you actually bought. Explain any missing products. Bought does not mean received into system stock.'}</p>
   <div className={styles.itemCards}>{buyingStoreGroups(list.items,sources).map(group=><section className={styles.storeGroup} key={group.id}>
    {sources?<h3 className={styles.storeHeading}>{group.name??(ar?'المورد غير محدد':'Store not assigned')} <small>{group.items.length} {ar?'منتج':'products'}</small></h3>:null}
    {group.items.map(item=><BuyingItemForm key={`${item.product_id}:${list.revision}`} item={item} ar={ar} disabled={command.locked}
     source={sources?.sources.find(source=>source.product_id===item.product_id)} sources={sources}
     saveSource={p=>command.send(make('source',p))} save={p=>command.send(make('item',p))}/>)}</section>)}</div>
   <div className={styles.actions}><button className={styles.primary} disabled={command.locked||list.items.some(i=>i.outcome==='pending')} onClick={()=>{if(window.confirm(ar?'إنهاء مراجعة القائمة؟ يبقى تسجيل المشتريات والاستلام والدفع منفصلاً.':'Finish checking this list? Purchase recording, receiving and payment remain separate.'))void command.send(make('complete'));}}>{ar?'إنهاء قائمة الشراء':'Finish buying list'}</button><span className={styles.hint}>{ar?'راجع كل منتج أولاً، بما فيه غير المتوفر.':'Check every product first, including unavailable items.'}</span></div>
   {planner?<details className={styles.admin}><summary>{ar?'الإسناد وإلغاء القائمة':'Assignment and cancellation'}</summary><div className={styles.actions}><label>{ar?'تغيير المشتري':'Change buyer'}<select value={buyer} onChange={e=>setBuyer(e.target.value)} disabled={command.locked}>{people.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label><button className={styles.secondary} disabled={command.locked||buyer===list.assigned_to} onClick={()=>void command.send(make('assign',{assigned_to:buyer}))}>{ar?'حفظ الإسناد':'Save assignment'}</button><button className={styles.secondary} disabled={command.locked} onClick={()=>{const reason=window.prompt(ar?'سبب إلغاء القائمة:':'Reason for cancellation:');if(reason?.trim())void command.send(make('cancel',{reason}));}}>{ar?'إلغاء القائمة':'Cancel list'}</button></div></details>:null}
  </>:<div className={styles.notice}><h2>{list.status==='completed'?(ar?'انتهت مراجعة القائمة':'Buying list checked'):(ar?'قائمة ملغاة':'Cancelled list')}</h2><p>{ar?'هذه نتيجة قائمة شراء فقط، وليست إيصالاً أو قيداً مالياً.':'This is a buying checklist result, not a receipt or accounting entry.'}</p>{planner&&list.status==='completed'?<button className={styles.secondary} disabled={command.locked} onClick={()=>void command.send(make('reopen'))}>{ar?'إعادة فتح للتصحيح':'Reopen for correction'}</button>:null}</div>}
 </div>;
}
function BuyingItemForm({item,ar,disabled,save,source,sources,saveSource}:{item:BuyingItem;ar:boolean;disabled:boolean;save:(payload:Record<string,unknown>)=>Promise<void>;source?:BuyingSource;sources:BuyingSources|null;saveSource:(payload:Record<string,unknown>)=>Promise<void>}){
 const defaultSupplier=item.actual_supplier_id??source?.primary.supplier_id??'';
 const [outcome,setOutcome]=useState(item.outcome),[boxes,setBoxes]=useState(String(item.bought_boxes)),[note,setNote]=useState(item.note),[actualSupplier,setActualSupplier]=useState(defaultSupplier);
 const bought=outcome==='bought'||outcome==='partial';
 const supplierOptions=source?[source.primary,...(source.alternative?[source.alternative]:[])]:[];
 const actualStore=supplierOptions.find(option=>option.supplier_id===item.actual_supplier_id)?.name??null;
 async function submit(event:FormEvent){
  event.preventDefault();
  if(bought&&!source)return;
  await save({
   product_id:item.product_id,
   outcome,
   bought_boxes:outcome==='bought'?item.planned_boxes:outcome==='partial'?Number(boxes):0,
   note,
   actual_supplier_id:bought?actualSupplier:null,
  });
 }
 return <details className={styles.itemCard}>
  <summary><span><strong>{item.name}</strong><small>{item.planned_boxes} {ar?'صندوق ×':'boxes ×'} {item.units_per_box} {ar?'وحدة':'units'}{actualStore?` · ${ar?'اشتري من':'bought at'} ${actualStore}`:''}</small></span><span className={styles[`outcome_${item.outcome}`]}>{buyingOutcomeLabels[item.outcome][ar?1:0]}{item.bought_boxes?` · ${item.bought_boxes}`:''}</span></summary>
  {source?<BuyingSourceDetails source={source} item={item} ar={ar}/>:sources?<p className={styles.hint}>{ar?'المورد غير محدد لهذا المنتج. لا تسجل المنتج كمشترى حتى تحدد الإدارة المورد.':'No store chosen for this item. Do not mark it bought until management sets the store.'}</p>:null}
  {sources?.can_edit&&item.outcome==='pending'?<BuyingSourceEditor item={item} source={source} sources={sources} ar={ar} disabled={disabled} save={saveSource}/>:null}
  <form onSubmit={submit}><fieldset disabled={disabled} className={styles.fields}>
   <label>{ar?'نتيجة المنتج':'Item result'}<select value={outcome} onChange={e=>{const next=e.target.value as BuyingItem['outcome'];setOutcome(next);if((next==='bought'||next==='partial')&&!actualSupplier&&source)setActualSupplier(source.primary.supplier_id);}}>{Object.entries(buyingOutcomeLabels).map(([value,labels])=><option key={value} value={value}>{labels[ar?1:0]}</option>)}</select></label>
   {outcome==='partial'?<label>{ar?'صناديق اشتريتها':'Boxes actually bought'}<input type="number" min={1} max={item.planned_boxes-1} step={1} inputMode="numeric" required value={boxes} onChange={e=>setBoxes(e.target.value)}/></label>:null}
   {bought&&source?<label>{ar?'المتجر الذي اشتريت منه فعلياً':'Store actually used'}<select value={actualSupplier} onChange={e=>setActualSupplier(e.target.value)} required><option value="">{ar?'اختر المتجر':'Choose store'}</option>{supplierOptions.map(store=><option key={store.supplier_id} value={store.supplier_id}>{store.name}{store.supplier_id===source.primary.supplier_id?(ar?' · المطلوب':' · required'):(ar?' · البديل':' · alternative')}</option>)}</select></label>:null}
   <label className={styles.wide}>{ar?'ملاحظة أو سبب النقص':'Note or shortage reason'}<textarea maxLength={1000} rows={2} required={outcome==='partial'||outcome==='unavailable'} value={note} onChange={e=>setNote(e.target.value)}/></label>
  </fieldset><button className={styles.primary} disabled={disabled||(bought&&(!source||!actualSupplier))} type="submit">{ar?'حفظ نتيجة المنتج':'Save item result'}</button></form>
 </details>;
}
export function BuyingPrintButton({ar}:{ar:boolean}){return <button type="button" className={styles.primary} onClick={()=>window.print()}>{ar?'طباعة / حفظ PDF':'Print / Save PDF'}</button>;}
export function BuyingCopyLink({ar}:{ar:boolean}){const [result,setResult]=useState('');return <span><button className={styles.secondary} type="button" onClick={async()=>{try{await navigator.clipboard.writeText(window.location.href);setResult(ar?'تم النسخ — يحتاج المستلم حساباً مخوّلاً':'Copied — recipient needs an authorized account');}catch{setResult(ar?'انسخ رابط الصفحة من المتصفح.':'Copy the page address from your browser.');}}}>{ar?'نسخ الرابط الخاص':'Copy private link'}</button>{result?<small role="status">{result}</small>:null}</span>;}
