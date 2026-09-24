'use client';
import Link from 'next/link';
import {useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {buyingReceiptError,buyingReceiptResultMatches,receiptCents,receiptMoney,validateBuyingReceiptCommand,type BuyingReceiptCommand,type BuyingReceiptWorkspace,type ReceiptItem,type ReceiptLine,type ReceiptProof,type LinkedBuyingReceipt} from '@/lib/buying-purchase';
const subscribe=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;
export function BuyingPurchaseClient(props:{data:BuyingReceiptWorkspace;userId:string;ar:boolean}){
 const hydrated=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 if(!hydrated)return <p role="status">{props.ar?'جارٍ تحميل فواتير الشراء…':'Loading purchase receipts…'}</p>;
 return <ReceiptWorkspace key={props.userId+props.data.list_id+props.data.revision} {...props}/>;
}
function ReceiptWorkspace({data,userId,ar}:{data:BuyingReceiptWorkspace;userId:string;ar:boolean}){
 const router=useRouter(),lock=useRef(false),fileRef=useRef<File|null>(null);
 const key='snacky:buying-receipt:v1:'+userId+':'+data.list_id;
 const [initial]=useState(()=>{try{const raw=localStorage.getItem(key);return {command:raw?validateBuyingReceiptCommand(JSON.parse(raw)):null,error:''};}catch{return {command:null,error:'corrupt'};}});
 const [pending,setPending]=useState<BuyingReceiptCommand|null>(initial.command),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState(initial.error);
 const disabled=busy||saved||Boolean(pending)||initial.error==='corrupt';
 async function send(command:BuyingReceiptCommand,file?:File|null){
  if(lock.current||saved||initial.error==='corrupt')return;
  lock.current=true;setBusy(true);setError('');
  let request=pending;
  try{
   if(!request){request=validateBuyingReceiptCommand(command);localStorage.setItem(key,JSON.stringify(request));setPending(request);}
   if(file)fileRef.current=file;
   const form=new FormData();form.set('command',JSON.stringify(request));
   if(request.action==='create'&&fileRef.current)form.set('receipt_file',fileRef.current);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
   try{
    const response=await fetch('/api/buying-lists/purchases',{method:'POST',body:form,signal:controller.signal});
    const result=await response.json();
    if(response.ok&&buyingReceiptResultMatches(request,result)){
     localStorage.removeItem(key);setPending(null);setSaved(true);router.refresh();
    }else if(result.ok===false){
     setError(String(result.code??'uncertain'));
     if(result.retryable===false){localStorage.removeItem(key);setPending(null);}
    }else throw Error('uncertain');
   }finally{clearTimeout(timer);}
  }catch{setError('uncertain');}finally{setBusy(false);lock.current=false;}
 }
 const create=(payload:Record<string,unknown>,file:File|null)=>send({request_id:crypto.randomUUID(),list_id:data.list_id,revision:data.revision,action:'create',payload},file);
 return <div className="min-w-0 space-y-5" dir={ar?'rtl':'ltr'}>
  <section className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-slate-800">
   <strong>{ar?'نفس الشخص يشتري ويضع المنتجات في المخزن':'The same person buys and places the goods in storage'}</strong>
   <p className="mt-1">{ar?'سجّل فاتورة لكل متجر. لا تزيد الكمية في المخزن إلا عند تأكيد وضع الكميات الفعلية فيه. لا تحتاج استلاماً من موظف آخر.':'Record one receipt per store. Stock increases only when you confirm the actual quantities are in storage. No second employee is required.'}</p>
  </section>
  {error?<p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">{buyingReceiptError(error,ar)}</p>:null}
  {pending?<section className="rounded-xl border border-amber-300 p-4 text-sm"><p>{ar?'طلب محفوظ بانتظار تأكيد نتيجته. لن ننشئ طلباً ثانياً.':'A saved request needs confirmation. A second request will not be created.'}</p><button className="btn-primary mt-3" disabled={busy} onClick={()=>void send(pending)}>{ar?'إعادة نفس الطلب':'Retry same request'}</button></section>:null}
  {saved?<section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4" role="status"><p>{ar?'تم الحفظ. تُحمّل بيانات الفاتورة المحدّثة.':'Saved. Loading the updated receipt.'}</p><button className="btn-secondary mt-2" onClick={()=>window.location.reload()}>{ar?'تحميل أحدث البيانات':'Reload latest records'}</button></section>:null}
  {data.can_record?<NewReceipt data={data} ar={ar} disabled={disabled} initial={initial.command} create={create}/>:<p className="text-sm text-slate-600">{ar?'يمكنك مراجعة الفواتير هنا. تسجيل الشراء والاستلام متاح للمشتري المسند فقط.':'You can review receipts here. Only the assigned buyer records purchases and confirms storage.'}</p>}
  <section className="space-y-3">
   <h2 className="text-xl font-semibold">{ar?'الفواتير المرتبطة بالقائمة':'Receipts linked to this list'}</h2>
   {!data.receipts.length?<p className="text-sm text-slate-500">{ar?'لم تُسجل فاتورة بعد. علامة «تم الشراء» في القائمة وحدها لا تضيف مخزوناً.':'No receipt recorded yet. Checking “Bought” on the list alone does not add stock.'}</p>:null}
   {data.receipts.map(receipt=><ReceiptCard key={receipt.purchase_id} receipt={receipt} data={data} ar={ar} disabled={disabled} receive={payload=>send({request_id:crypto.randomUUID(),list_id:data.list_id,revision:data.revision,action:'receive',payload})}/>)}
  </section>
 </div>;
}
type DraftLine={include:boolean;boxes:string;loose:string;total:string};
function NewReceipt({data,ar,disabled,initial,create}:{data:BuyingReceiptWorkspace;ar:boolean;disabled:boolean;initial:BuyingReceiptCommand|null;create:(payload:Record<string,unknown>,file:File|null)=>Promise<void>}){
 const initialPayload=initial?.action==='create'?initial.payload:null;
 const storeMap=new Map<string,string>();
 for(const item of data.items.filter(i=>i.remaining_units>0))for(const store of [item.primary,item.alternative])if(store)storeMap.set(store.supplier_id,store.name);
 const [supplier,setSupplier]=useState(String(initialPayload?.supplier_id??''));
 const [date,setDate]=useState(String(initialPayload?.order_date??data.today)),[receiptNumber,setReceiptNumber]=useState(String(initialPayload?.receipt_number??'')),[note,setNote]=useState(String(initialPayload?.note??''));
 const [placed,setPlaced]=useState(initialPayload?.placed_in_storage===true),[storage,setStorage]=useState(String(initialPayload?.storage_id??''));
 const [file,setFile]=useState<File|null>(null),[proof,setProof]=useState<ReceiptProof|null>(initialPayload?{receipt_sha256:String(initialPayload.receipt_sha256),receipt_mime:String(initialPayload.receipt_mime),receipt_name:String(initialPayload.receipt_name)}:null);
 const [fileBusy,setFileBusy]=useState(false),[localError,setLocalError]=useState('');const sequence=useRef(0);
 const [drafts,setDrafts]=useState<Record<string,DraftLine>>(()=>{
  const previous=(initialPayload?.lines??[]) as ReceiptLine[];
  return Object.fromEntries(data.items.map(i=>{const line=previous.find(p=>p.product_id===i.product_id);return [i.product_id,{include:Boolean(line),boxes:String(line?.boxes??Math.floor(i.remaining_units/i.units_per_box)),loose:String(line?.loose??i.remaining_units%i.units_per_box),total:line?receiptMoney(line.line_total_cents):''}];}));
 });
 const items=data.items.filter(i=>i.remaining_units>0&&(i.primary?.supplier_id===supplier||i.alternative?.supplier_id===supplier));
 function change(item:ReceiptItem,field:keyof DraftLine,value:string|boolean){setDrafts(current=>({...current,[item.product_id]:{...current[item.product_id],[field]:value}}));}
 let total=0,higher=false;
 for(const i of items){const d=drafts[i.product_id];if(!d?.include)continue;try{const cents=receiptCents(d.total);total+=cents;const price=(i.primary?.supplier_id===supplier?i.primary:i.alternative)?.unit_cost_lyd;const units=Number(d.boxes)*i.units_per_box+Number(d.loose);if(price!==null&&price!==undefined&&cents/100>Number(price)*units+0.01)higher=true;}catch{/* Incomplete actual price stays blank, never copied from history. */}}
 async function chooseFile(next:File|null){
  const version=++sequence.current;setProof(null);setFile(next);setLocalError('');if(!next)return;
  if(next.size>5*1024*1024||!['image/jpeg','image/png','image/webp','application/pdf'].includes(next.type)){setLocalError(ar?'اختر صورة أو PDF لا يتجاوز 5 ميجابايت.':'Choose a JPG, PNG, WebP or PDF up to 5 MB.');return;}
  setFileBusy(true);
  try{const digest=await crypto.subtle.digest('SHA-256',await next.arrayBuffer());if(sequence.current===version)setProof({receipt_sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),receipt_mime:next.type,receipt_name:next.name.slice(0,200)});}catch{setLocalError(ar?'تعذر تجهيز الإيصال. أعد اختياره.':'Could not prepare the receipt. Select it again.');}finally{if(sequence.current===version)setFileBusy(false);}
 }
 async function submit(e:FormEvent){
  e.preventDefault();setLocalError('');
  try{
   if(!proof)throw Error('invalid');
   const lines=items.filter(i=>drafts[i.product_id]?.include).map(i=>{
    const d=drafts[i.product_id],boxes=Number(d.boxes),loose=Number(d.loose),units=boxes*i.units_per_box+loose;
    if(!Number.isSafeInteger(boxes)||!Number.isSafeInteger(loose)||boxes<0||loose<0||loose>=i.units_per_box||units<=0||units>i.remaining_units)throw Error('invalid');
    return {product_id:i.product_id,boxes,loose,line_total_cents:receiptCents(d.total)};
   });
   if(!lines.length||(higher&&!note.trim()))throw Error('invalid');
   await create({supplier_id:supplier,order_date:date,receipt_number:receiptNumber,lines,storage_id:storage||null,placed_in_storage:placed,note,...proof},file);
  }catch{setLocalError(ar?'حدد المنتجات والكميات والأسعار الفعلية والإيصال، وسبب أي زيادة سعر.':'Select products, exact quantities, actual prices and a receipt; explain any price increase.');}
 }
 if(!storeMap.size)return <section className="surface-card"><h2 className="font-semibold">{ar?'لا توجد كميات جاهزة للفوترة':'No bought quantities ready to invoice'}</h2><p className="mt-2 text-sm text-slate-600">{ar?'سجّل ما اشتريته في القائمة أولاً. يجب أن يحدد المالك المتجر أو البديل للمنتج. الكميات المفوترة سابقاً لا تظهر مرة أخرى.':'First record what you bought in the checklist. The owner must choose the store or alternative. Quantities already invoiced are excluded.'}</p></section>;
 return <section className="surface-card space-y-4">
  <h2 className="text-xl font-semibold">{ar?'تسجيل فاتورة متجر':'Record a store receipt'}</h2>
  <form onSubmit={submit} className="space-y-4"><fieldset disabled={disabled||fileBusy} className="space-y-4 min-w-0">
   <div className="grid gap-4 sm:grid-cols-3">
    <label className="text-sm font-medium">{ar?'المتجر الفعلي':'Actual store'}<select className="field-input mt-1 w-full" required value={supplier} onChange={e=>{const next=e.target.value;if(items.some(i=>drafts[i.product_id]?.include)&&!window.confirm(ar?'تغيير المتجر يمسح اختيار المنتجات وأسعار الإيصال غير المحفوظة. متابعة؟':'Changing store clears unsaved product selections and actual prices. Continue?'))return;setSupplier(next);setDrafts(current=>Object.fromEntries(Object.entries(current).map(([id,d])=>[id,{...d,include:false,total:''}])));}}><option value="">{ar?'اختر المتجر':'Choose store'}</option>{[...storeMap].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
    <label className="text-sm font-medium">{ar?'تاريخ الفاتورة':'Receipt date'}<input type="date" required max={data.today} className="field-input mt-1 w-full" value={date} onChange={e=>setDate(e.target.value)}/></label>
    <label className="text-sm font-medium">{ar?'رقم الإيصال إن وجد':'Receipt number, when present'}<input className="field-input mt-1 w-full" maxLength={100} value={receiptNumber} onChange={e=>setReceiptNumber(e.target.value)}/></label>
   </div>
   {supplier?<p className="text-sm text-slate-600">{ar?'حدد المنتجات الموجودة في هذا الإيصال فقط. الكميات المعروضة مما سجلته مشتَرى، وليس المطلوب أصلاً.':'Select only products on this receipt. Quantities come from what you marked bought, not the original plan.'}</p>:null}
   <div className="space-y-3">{items.map(item=>{const d=drafts[item.product_id],reference=item.primary?.supplier_id===supplier?item.primary:item.alternative;return <div key={item.product_id} className="rounded-xl border border-slate-200 p-4">
    <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={d.include} onChange={e=>change(item,'include',e.target.checked)}/><span><strong>{item.name}</strong><small className="mt-1 block text-slate-500">{item.units_per_box} {ar?'وحدة في الصندوق · المتبقي للفوترة: ':'units / box · left to invoice: '}{item.remaining_units}</small></span></label>
    <p className="mt-2 text-xs text-slate-600">{reference?.unit_cost_lyd?`${ar?'آخر سعر لهذا المتجر: ':'Last price at this store: '}${(Number(reference.unit_cost_lyd)*item.units_per_box).toFixed(2)} LYD / ${ar?'صندوق':'box'} · ${reference.purchased_on??'—'}`:(ar?'لا يوجد سعر سابق لهذا المتجر. أدخل السعر الفعلي.':'No recorded price at this store. Enter the actual price.')}</p>
    {d.include?<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
     <label className="text-sm">{ar?'صناديق مشتراة':'Boxes bought'}<input type="number" min={0} max={10000} step={1} inputMode="numeric" required className="field-input mt-1 w-full" value={d.boxes} onChange={e=>change(item,'boxes',e.target.value)}/></label>
     <label className="text-sm">{ar?'وحدات مفردة':'Loose units'}<input type="number" min={0} max={item.units_per_box-1} step={1} inputMode="numeric" required className="field-input mt-1 w-full" value={d.loose} onChange={e=>change(item,'loose',e.target.value)}/></label>
     <label className="col-span-2 text-sm sm:col-span-1">{ar?'إجمالي هذا المنتج (د.ل)':'Total for this product (LYD)'}<input type="text" inputMode="decimal" required className="field-input mt-1 w-full" placeholder="0.00" value={d.total} onChange={e=>change(item,'total',e.target.value)}/></label>
    </div>:null}
   </div>;})}</div>
   <div className="grid gap-4 sm:grid-cols-2">
    <label className="text-sm font-medium">{ar?'صورة الإيصال أو PDF':'Receipt image or PDF'}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="mt-2 block w-full text-sm" onChange={e=>void chooseFile(e.target.files?.[0]??null)}/><small className="mt-1 block text-slate-500">{proof?proof.receipt_name:(ar?'إيصال خاص، بحد أقصى 5 ميجابايت.':'Private receipt, up to 5 MB.')}</small></label>
    <label className="text-sm font-medium">{ar?'ملاحظة / سبب زيادة السعر':'Note / reason for a higher price'}<textarea required={higher} maxLength={2000} rows={2} className="field-input mt-1 w-full" value={note} onChange={e=>setNote(e.target.value)}/></label>
   </div>
   {higher?<p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{ar?'سعر فعلي أعلى من السعر السابق لهذا المتجر. سجّل السبب قبل الحفظ.':'An actual price is higher than the previous store price. Record the reason before saving.'}</p>:null}
   <div className="rounded-xl border border-slate-300 p-4 space-y-3">
    <label className="flex gap-3 text-sm font-semibold"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={placed} onChange={e=>setPlaced(e.target.checked)}/><span>{ar?'وضعتُ كل الكميات المدخلة فعلياً في المخزن':'I have physically placed all entered quantities in storage'}</span></label>
    {placed?<label className="block text-sm">{ar?'المخزن الفعلي':'Actual storage location'}<select required className="field-input mt-1 w-full" value={storage} onChange={e=>setStorage(e.target.value)}><option value="">{ar?'اختر المخزن':'Choose storage'}</option>{data.storage.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>:<p className="text-xs text-slate-600">{ar?'ستُحفظ الفاتورة دون إضافة مخزون. عند العودة للمخزن يمكنك تأكيدها بنفسك من الأسفل.':'The purchase will be saved without adding stock. You can confirm it yourself below after returning to storage.'}</p>}
   </div>
   <p className="text-lg font-semibold">{ar?'إجمالي الإيصال: ':'Receipt total: '}{receiptMoney(total)} LYD</p>
   <p className="text-sm text-slate-600">{ar?'تسجيل الفاتورة والاستلام لا يسجلان دفعة للمورد. تبقى الدفعات في إجراء الدفع الحالي، دون منحك لوحة المالية.':'Recording a receipt or receiving stock does not record a supplier payment. Payments remain in the existing payment workflow; this page does not grant Finance access.'}</p>
   {localError?<p role="alert" className="text-sm text-rose-700">{localError}</p>:null}
   <button className="btn-primary min-h-12 w-full sm:w-auto" disabled={disabled||fileBusy||!proof||!supplier}>{fileBusy?(ar?'تجهيز الإيصال…':'Preparing receipt…'):placed?(ar?'حفظ الفاتورة وإضافة المخزون':'Save receipt and add stock'):(ar?'حفظ الشراء — لم يوضع في المخزن':'Save purchase — not yet stored')}</button>
  </fieldset></form>
 </section>;
}
function ReceiptCard({receipt,data,ar,disabled,receive}:{receipt:LinkedBuyingReceipt;data:BuyingReceiptWorkspace;ar:boolean;disabled:boolean;receive:(payload:Record<string,unknown>)=>Promise<void>}){
 const [storage,setStorage]=useState(receipt.storage_id??''),[confirmed,setConfirmed]=useState(false);
 return <article className="surface-card space-y-3">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{receipt.supplier_name} · {receipt.receipt_number??receipt.purchase_id.slice(0,8).toUpperCase()}</h3><p className="text-sm text-slate-500">{receipt.order_date} · {Number(receipt.total_amount).toFixed(2)} LYD</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-sm">{receipt.status==='received'?(ar?'وُضع في المخزن':'Placed in storage'):receipt.status==='draft'?(ar?'مشتَرى — لم يوضع في المخزن':'Bought — not yet stored'):receipt.status}</span></div>
  <details><summary className="cursor-pointer text-sm font-medium">{ar?'عرض الكميات الفعلية':'View actual quantities'}</summary><div className="mt-2 space-y-2">{receipt.lines.map(line=><p key={line.product_id} className="text-sm">{line.name} — {line.quantity} {ar?'وحدة':'units'} · {receiptMoney(line.line_total_cents)} LYD</p>)}</div></details>
  <Link className="inline-block text-sm text-sky-800 underline" href={`/purchases/${receipt.purchase_id}`}>{ar?'فتح الفاتورة الأصلية / إجراء الدفع':'Open original purchase / payment workflow'}</Link>
  {receipt.can_receive?<fieldset disabled={disabled} className="rounded-lg border border-slate-200 p-3 space-y-3">
   <label className="block text-sm">{ar?'أين وضعت المنتجات؟':'Where did you place the goods?'}<select className="field-input mt-1 w-full" value={storage} onChange={e=>setStorage(e.target.value)}><option value="">{ar?'اختر المخزن':'Choose storage'}</option>{data.storage.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
   <label className="flex gap-3 text-sm"><input className="size-5 shrink-0" type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>{ar?'راجعت الكميات أعلاه ووضعتها كاملة في المخزن.':'I checked the quantities above and placed all of them in storage.'}</span></label>
   <p className="text-xs text-slate-600">{ar?'عند وجود نقص أو تلف، لا تؤكد الكمية كاملة. أبلغ المالك لمراجعة الفاتورة أولاً.':'For missing or damaged goods, do not confirm the full quantity. Ask the owner to review the receipt first.'}</p>
   <button className="btn-primary" disabled={disabled||!confirmed||!storage} onClick={()=>void receive({purchase_id:receipt.purchase_id,version:receipt.version,storage_id:storage,confirmed:true})}>{ar?'تأكيد الوضع في المخزن':'Confirm placement in storage'}</button>
  </fieldset>:null}
 </article>;
}
