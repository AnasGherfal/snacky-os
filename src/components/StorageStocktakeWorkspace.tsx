'use client';
import {useEffect,useMemo,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {useLanguage} from '@/components/I18nProvider';
import {stocktakeError,stocktakeReceiptMatches,validateStocktakeCommand,type StocktakeCommand,type StocktakeLine,type StocktakeWorkspace} from '@/lib/storage-stocktake';

const subscribe=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;
type Draft={cases:string;loose:string};

function splitCount(line:StocktakeLine):Draft{
 const total=Math.max(0,Number(line.counted_qty??0)),size=Math.max(1,Number(line.case_quantity||1));
 return line.counted_qty===null?{cases:'',loose:''}:{cases:String(Math.floor(total/size)),loose:String(total%size)};
}
function statusLabel(status:string,ar:boolean){
 const labels:Record<string,[string,string]>={
  assigned:['Assigned','مسند'],counting:['Counting','قيد الجرد'],submitted:['Awaiting review','بانتظار المراجعة'],
  needs_recount:['Recount requested','مطلوب إعادة الجرد'],approved:['Approved','معتمد'],cancelled:['Cancelled','ملغي']
 };
 return (labels[status]??[status,status])[ar?1:0];
}
function signed(value:number|null|undefined){const n=Number(value??0);return n>0?'+'+n:String(n);}

export function StorageStocktakeWorkspace({userId,initialId=null}:{userId:string;initialId?:string|null}){
 const hydrated=useSyncExternalStore(subscribe,clientSnapshot,serverSnapshot);
 const {locale}=useLanguage();
 if(!hydrated)return <p role="status">{locale==='ar'?'جارٍ تحميل جرد المخزن…':'Loading storage count…'}</p>;
 return <StorageStocktakeClient key={initialId??'list'} userId={userId} initialId={initialId}/>;
}

function StorageStocktakeClient({userId,initialId}:{userId:string;initialId:string|null}){
 const {locale}=useLanguage(),ar=locale==='ar';
 const [workspace,setWorkspace]=useState<StocktakeWorkspace|null>(null);
 const [selected,setSelected]=useState<string|null>(initialId);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const key='snacky:stocktake:pending:'+userId;
 const [pending,setPending]=useState<StocktakeCommand|null>(()=>{
  try{const raw=sessionStorage.getItem(key);return raw?validateStocktakeCommand(JSON.parse(raw)):null;}catch{return null;}
 });
 const [busy,setBusy]=useState(false);
 const [drafts,setDrafts]=useState<Record<string,Draft>>({});
 const [dirty,setDirty]=useState<Record<string,boolean>>({});
 const lock=useRef(false);

 function acceptWorkspace(data:StocktakeWorkspace){
  setWorkspace(data);
  const next:Record<string,Draft>={};for(const line of data.lines??[])next[line.product_id]=splitCount(line);
  setDrafts(next);setDirty({});
 }
 function load(id:string|null=selected){
  const url=id?'/api/storage-stocktake?id='+encodeURIComponent(id):'/api/storage-stocktake';
  return fetch(url,{cache:'no-store'}).then(async response=>{
    const body=await response.json();if(!response.ok||!body.ok)throw Error(body.code??'unavailable');
    acceptWorkspace(body.data);setError('');return body.data as StocktakeWorkspace;
  }).catch(reason=>{setError(stocktakeError(String(reason?.message??'unavailable'),ar));throw reason;}).finally(()=>setLoading(false));
 }
 useEffect(()=>{
  const url=selected?'/api/storage-stocktake?id='+encodeURIComponent(selected):'/api/storage-stocktake';
  const controller=new AbortController();
  fetch(url,{cache:'no-store',signal:controller.signal}).then(r=>r.json().then(body=>({r,body}))).then(({r,body})=>{
    if(!r.ok||!body.ok)throw Error(body.code??'unavailable');acceptWorkspace(body.data);setError('');setLoading(false);
  }).catch(e=>{if(e?.name!=='AbortError'){setError(stocktakeError(String(e?.message??'unavailable'),ar));setLoading(false);}});
  return()=>controller.abort();
 },[selected,ar]);

 async function send(command:StocktakeCommand,onSuccess?:(result:Record<string,unknown>)=>void){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  let saved=pending;
  try{
   if(!saved){saved=validateStocktakeCommand(command);sessionStorage.setItem(key,JSON.stringify(saved));setPending(saved);}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
   try{
    const response=await fetch('/api/storage-stocktake',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved),signal:controller.signal});
    const result=await response.json();
    if(response.ok&&stocktakeReceiptMatches(saved,result)){
     sessionStorage.removeItem(key);setPending(null);onSuccess?.(result);await load(saved.assignment_id);
    }else if(result.ok===false){
     setError(stocktakeError(result.code,ar));
     if(result.retryable===false){sessionStorage.removeItem(key);setPending(null);}
    }else throw Error('uncertain');
   }finally{clearTimeout(timer);}
  }catch{setError(stocktakeError('uncertain',ar));}finally{setBusy(false);lock.current=false;}
 }

 const record=workspace?.record??null,lines=workspace?.lines??[];
 const isOpen=Boolean(record&&['assigned','counting','needs_recount'].includes(record.status));
 const incomplete=lines.some(line=>line.counted_qty===null)||Object.keys(dirty).length>0;
 const counted=lines.filter(line=>line.counted_qty!==null).length;

 function updateDraft(line:StocktakeLine,part:keyof Draft,value:string){
  setDrafts(current=>({...current,[line.product_id]:{...(current[line.product_id]??splitCount(line)),[part]:value}}));
  setDirty(current=>({...current,[line.product_id]:true}));
 }
 async function saveDirty(){
  if(!record)return;
  const counts=lines.filter(line=>dirty[line.product_id]).map(line=>{
   const draft=drafts[line.product_id]??{cases:'',loose:''};
   const cases=Number(draft.cases),loose=Number(draft.loose),size=Math.max(1,line.case_quantity);
   if(!Number.isInteger(cases)||cases<0||!Number.isInteger(loose)||loose<0||loose>=size)throw Error('invalid');
   return {product_id:line.product_id,counted_qty:cases*size+loose};
  });
  if(!counts.length)return;
  await send({request_id:crypto.randomUUID(),assignment_id:record.id,action:'save',revision:record.revision,payload:{counts}});
 }

 if(loading&&!workspace)return <p role="status">{ar?'جارٍ التحميل…':'Loading…'}</p>;
 if(!workspace)return <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-800">{error||stocktakeError('unavailable',ar)}</p>;

 return <div className="space-y-6" dir={ar?'rtl':'ltr'}>
  <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
   <div><p className="text-sm font-semibold text-orange-600">{ar?'المخزون والمشتريات':'Stock & Purchasing'}</p><h1 className="text-2xl font-semibold text-slate-950">{ar?'جرد المخزن':'Storage Count'}</h1><p className="mt-1 max-w-3xl text-sm text-slate-600">{ar?'جرد فعلي مسند. الموظف يعدّ بدون رؤية كمية النظام، وأي فرق لا يغيّر المخزون إلا بعد اعتماد المالك.':'Assigned physical count. The counter works blind; no stock changes until owner approval.'}</p></div>
   {selected?<button className="btn-secondary" onClick={()=>{setSelected(null);setLoading(true);}}>{ar?'كل عمليات الجرد':'All stocktakes'}</button>:null}
  </header>

  {error?<p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>:null}
  {pending?<div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>{ar?'يوجد إجراء محفوظ لم نتأكد من نتيجته. أعد نفس الطلب قبل أي تغيير آخر.':'A saved action has an uncertain result. Retry the exact same action before doing anything else.'}</p><button className="btn-primary mt-3" disabled={busy} onClick={()=>void send(pending)}>{ar?'إعادة الطلب المحفوظ':'Retry saved action'}</button></div>:null}

  {!selected&&workspace.manager?<CreateStocktake workspace={workspace} ar={ar} disabled={busy||Boolean(pending)} create={command=>send(command,result=>{setSelected(String(result.assignment_id));setLoading(true);})}/>:null}

  {!selected?<section className="surface-card">
   <div className="mb-4"><h2 className="text-lg font-semibold">{ar?'عمليات الجرد':'Stocktakes'}</h2><p className="text-sm text-slate-500">{workspace.manager?(ar?'أنشئ جرداً لمخزن واحد وأسنده لموظف واحد.':'Assign one physical storage location to one employee.'):(ar?'تظهر هنا عمليات الجرد المسندة لك فقط.':'Only stocktakes assigned to you appear here.')}</p></div>
   {!workspace.rows.length?<p className="text-sm text-slate-500">{ar?'لا توجد عمليات جرد مسندة.':'No assigned stocktakes.'}</p>:<div className="grid gap-3 md:grid-cols-2">{workspace.rows.map(row=><button key={row.id} onClick={()=>{setSelected(row.id);setLoading(true);}} className="rounded-xl border border-slate-200 bg-white p-4 text-start hover:border-orange-300">
    <div className="flex items-start justify-between gap-3"><strong>{row.title}</strong><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{statusLabel(row.status,ar)}</span></div>
    <p className="mt-2 text-sm text-slate-600">{row.storage_name+' · '+row.assigned_name}</p>
    <p className="mt-1 text-xs text-slate-500">{row.counted_lines+'/'+row.total_lines+' '+(ar?'منتج تم عده':'products counted')+(row.due_on?' · '+row.due_on:'')}</p>
   </button>)}</div>}
  </section>:null}

  {selected&&record?<>
   <section className="surface-card">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-xl font-semibold">{record.title}</h2><p className="mt-1 text-sm text-slate-600">{record.storage_name+' · '+record.assigned_name}</p>{record.notes?<p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{record.notes}</p>:null}</div><span className="self-start rounded-full bg-slate-100 px-3 py-1 text-sm">{statusLabel(record.status,ar)}</span></div>
   </section>

   {!workspace.manager&&isOpen?<section className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><strong>{ar?'جرد أعمى':'Blind count'}</strong><p className="mt-1">{ar?'كمية النظام مخفية عمداً. عدّ الموجود فعلياً فقط. أدخل الصناديق والوحدات المفردة.':'System quantity is intentionally hidden. Count only what is physically present; enter cases and loose units.'}</p></section>:null}

   {!workspace.manager&&isOpen?<section className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="font-semibold">{ar?'المنتجات':'Products'}</h2><span className="text-sm text-slate-500">{counted+'/'+lines.length}</span></div>
    {lines.map(line=>{const d=drafts[line.product_id]??splitCount(line);return <div key={line.product_id} className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3"><strong>{line.name}</strong><div className="text-xs text-slate-500">{(line.sku??'')+(line.category?' · '+line.category:'')+' · '+(ar?'الصندوق ':'case ')+line.case_quantity}</div></div>
      <div className="grid grid-cols-2 gap-3"><label className="text-sm">{ar?'صناديق':'Cases'}<input className="field-input mt-1" type="number" inputMode="numeric" min={0} step={1} value={d.cases} onChange={e=>updateDraft(line,'cases',e.target.value)}/></label><label className="text-sm">{ar?'وحدات مفردة':'Loose units'}<input className="field-input mt-1" type="number" inputMode="numeric" min={0} max={Math.max(0,line.case_quantity-1)} step={1} value={d.loose} onChange={e=>updateDraft(line,'loose',e.target.value)}/></label></div>
      {line.counted_at&&!dirty[line.product_id]?<p className="mt-2 text-xs text-emerald-700">{ar?'تم حفظ هذا العد':'Count saved'}</p>:dirty[line.product_id]?<p className="mt-2 text-xs text-amber-700">{ar?'تغيير غير محفوظ':'Unsaved change'}</p>:null}
     </div>})}
    <AddProduct options={workspace.options} ar={ar} disabled={busy||Boolean(pending)} add={productId=>send({request_id:crypto.randomUUID(),assignment_id:record.id,action:'add_product',revision:record.revision,payload:{product_id:productId}})}/>
    <div className="sticky bottom-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur">
     <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={busy||Boolean(pending)||!Object.keys(dirty).length} onClick={()=>void saveDirty().catch(()=>setError(stocktakeError('invalid',ar)))}>{ar?'حفظ العد':'Save counts'}</button><button className="btn-secondary" disabled={busy||Boolean(pending)||incomplete} onClick={()=>{if(confirm(ar?'إرسال الجرد للمراجعة؟ لن يتغير المخزون الآن.':'Submit for owner review? Stock will not change yet.'))void send({request_id:crypto.randomUUID(),assignment_id:record.id,action:'submit',revision:record.revision,payload:{confirmed_empty:lines.length===0}});}}>{ar?'إرسال للمراجعة':'Submit for review'}</button></div>
     <p className="mt-2 text-xs text-slate-500">{ar?'الإرسال لا يعدّل المخزون. المالك يراجع الفرق أولاً.':'Submitting never adjusts inventory. Owner reviews the variance first.'}</p>
    </div>
   </section>:null}

   {workspace.manager?<ManagerReview record={record} lines={lines} ar={ar} disabled={busy||Boolean(pending)} send={send}/>:record.status==='submitted'?<section className="surface-card"><p className="text-sm text-slate-600">{ar?'تم إرسال الجرد. بانتظار مراجعة المالك.':'Count submitted. Waiting for owner review.'}</p></section>:record.status==='approved'?<section className="surface-card"><p className="text-sm text-emerald-700">{ar?'تم اعتماد الجرد.':'Stocktake approved.'}</p></section>:null}
  </>:null}
 </div>;
}

function CreateStocktake({workspace,ar,disabled,create}:{workspace:StocktakeWorkspace;ar:boolean;disabled:boolean;create:(c:StocktakeCommand)=>Promise<void>}){
 const [title,setTitle]=useState(ar?'جرد المخزن':'Storage stocktake'),[location,setLocation]=useState(''),[assignee,setAssignee]=useState(''),[due,setDue]=useState(workspace.today),[notes,setNotes]=useState('');
 async function submit(e:FormEvent){e.preventDefault();const id=crypto.randomUUID();await create({request_id:crypto.randomUUID(),assignment_id:id,action:'create',revision:0,payload:{title,storage_location_id:location,assigned_to:assignee,due_on:due,notes}});}
 return <details className="surface-card" open><summary className="cursor-pointer font-semibold">{ar?'إنشاء جرد مسند':'Create assigned stocktake'}</summary><form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}><fieldset disabled={disabled} className="contents">
  <label className="text-sm">{ar?'العنوان':'Title'}<input className="field-input mt-1" required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label>
  <label className="text-sm">{ar?'المخزن':'Storage'}<select className="field-input mt-1" required value={location} onChange={e=>setLocation(e.target.value)}><option value="">{ar?'اختر المخزن':'Choose storage'}</option>{workspace.locations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
  <label className="text-sm">{ar?'الموظف المسؤول':'Assigned employee'}<select className="field-input mt-1" required value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">{ar?'اختر الموظف':'Choose employee'}</option>{workspace.people.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
  <label className="text-sm">{ar?'موعد الجرد':'Due date'}<input className="field-input mt-1" type="date" required value={due} onChange={e=>setDue(e.target.value)}/></label>
  <label className="text-sm sm:col-span-2">{ar?'تعليمات':'Instructions'}<textarea className="field-input mt-1" rows={2} maxLength={2000} value={notes} onChange={e=>setNotes(e.target.value)}/></label>
 </fieldset><div className="sm:col-span-2"><button className="btn-primary" disabled={disabled}>{ar?'إنشاء وإسناد':'Create & assign'}</button></div></form></details>;
}

function AddProduct({options,ar,disabled,add}:{options:StocktakeWorkspace['options'];ar:boolean;disabled:boolean;add:(id:string)=>Promise<void>}){
 const [id,setId]=useState('');
 return <details className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4"><summary className="cursor-pointer font-semibold">{ar?'وجدت منتجاً غير موجود بالقائمة':'Found a product not listed'}</summary><div className="mt-3 flex flex-col gap-2 sm:flex-row"><select className="field-input flex-1" value={id} onChange={e=>setId(e.target.value)}><option value="">{ar?'اختر المنتج':'Choose product'}</option>{options.map(x=><option key={x.id} value={x.id}>{x.name+(x.sku?' · '+x.sku:'')}</option>)}</select><button className="btn-secondary" disabled={disabled||!id} onClick={()=>void add(id).then(()=>setId(''))}>{ar?'إضافة للجرد':'Add to count'}</button></div></details>;
}

function ManagerReview({record,lines,ar,disabled,send}:{record:NonNullable<StocktakeWorkspace['record']>;lines:StocktakeLine[];ar:boolean;disabled:boolean;send:(c:StocktakeCommand)=>Promise<void>}){
 const variance=useMemo(()=>lines.reduce((sum,l)=>sum+Math.abs(Number(l.variance_delta??0)),0),[lines]);
 return <section className="surface-card space-y-4"><div><h2 className="text-lg font-semibold">{ar?'مراجعة المالك':'Owner review'}</h2><p className="text-sm text-slate-500">{ar?'الفرق يقارن العد الفعلي بدفتر المخزون في لحظة عد كل منتج. الحركات التي حدثت بعد العد محفوظة.':'Variance compares the physical count with the ledger at each product’s count time. Later movements stay intact.'}</p></div>
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b text-slate-500"><th className="p-2 text-start">{ar?'المنتج':'Product'}</th><th className="p-2">{ar?'المتوقع وقت العد':'Ledger at count'}</th><th className="p-2">{ar?'الفعلي':'Physical'}</th><th className="p-2">{ar?'الفرق':'Variance'}</th><th className="p-2">{ar?'المخزون الآن':'Ledger now'}</th></tr></thead><tbody>{lines.map(l=><tr key={l.product_id} className="border-b"><td className="p-2 font-medium">{l.name}</td><td className="p-2 text-center">{l.expected_at_count??'—'}</td><td className="p-2 text-center">{l.counted_qty??'—'}</td><td className={'p-2 text-center font-semibold '+(Number(l.variance_delta??0)!==0?'text-rose-700':'')}>{l.counted_at?signed(l.variance_delta):'—'}</td><td className="p-2 text-center">{l.current_qty??'—'}</td></tr>)}</tbody></table></div>
  {record.status==='submitted'?<div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={disabled} onClick={()=>{if(confirm(ar?'اعتماد الجرد وتسجيل فروق المخزون؟ إجمالي الوحدات المختلفة: '+variance:'Approve and post ledger corrections? Total absolute variance: '+variance+' units'))void send({request_id:crypto.randomUUID(),assignment_id:record.id,action:'approve',revision:record.revision,payload:{note:''}});}}>{ar?'اعتماد وتسجيل الفرق':'Approve & post variance'}</button><button className="btn-secondary" disabled={disabled} onClick={()=>{const note=prompt(ar?'سبب إعادة الجرد':'Reason for recount')??'';if(note.trim())void send({request_id:crypto.randomUUID(),assignment_id:record.id,action:'recount',revision:record.revision,payload:{note}});}}>{ar?'طلب إعادة الجرد':'Request recount'}</button></div>:null}
  {!['approved','cancelled'].includes(record.status)?<button className="text-sm text-rose-700 underline" disabled={disabled} onClick={()=>{const note=prompt(ar?'سبب الإلغاء':'Cancellation reason')??'';if(note.trim())void send({request_id:crypto.randomUUID(),assignment_id:record.id,action:'cancel',revision:record.revision,payload:{note}});}}>{ar?'إلغاء الجرد':'Cancel stocktake'}</button>:null}
  {record.status==='approved'?<p className="text-sm text-emerald-700">{ar?'تم اعتماد الفروق كحركات مخزون منفصلة.':'Approved variances were posted as separate inventory movements.'}</p>:null}
 </section>;
}
