'use client';
import { useEffect,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/components/I18nProvider';
import { type CrmField,uuidPattern } from '@/lib/crm-workspace';

type RequestReceipt={id:string;action:string;recordId:string|null;values:Record<string,string>};
type Props={action:string;recordId?:string|null;userId:string;fields:CrmField[];hidden?:Record<string,string>;submitLabel:string;stay?:boolean};
function savedRequest(raw:string,action:string,recordId:string|null):RequestReceipt{
 const saved=JSON.parse(raw);
 if(!saved||!uuidPattern.test(saved.id??'')||saved.action!==action||saved.recordId!==recordId||!saved.values||Array.isArray(saved.values)||Object.values(saved.values).some(v=>typeof v!=='string'))throw new Error('Invalid saved request');
 return saved;
}
export function CrmForm({action,recordId=null,userId,fields,hidden={},submitLabel,stay=false}:Props){
 const {locale}=useLanguage(),ar=locale==='ar',router=useRouter(),key=`snacky:crm-command:v1:${userId}:${action}:${recordId??'new'}`;
 const [values,setValues]=useState<Record<string,string>>(()=>({...hidden,...Object.fromEntries(fields.map(f=>[f.name,f.value??'']))}));
 const [saved,setSaved]=useState<RequestReceipt|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[blocked,setBlocked]=useState(false),[done,setDone]=useState(false),[message,setMessage]=useState('');
 const lock=useRef(false),storageAvailable=useRef(true);
 useEffect(()=>{
  let raw:string|null=null;try{raw=localStorage.getItem(key);}catch{storageAvailable.current=false;}
  if(raw){try{const receipt=savedRequest(raw,action,recordId);setSaved(receipt);setValues(receipt.values);}catch{setBlocked(true);setMessage(ar?'تعذر قراءة طلب محفوظ. راجع السجل قبل تكرار العملية.':'A saved request could not be read. Review the record before adding it again.');}}
  setReady(true);
 },[key,action,recordId]);
 async function submit(){
  if(lock.current||!ready||blocked||done)return;
  let receipt=saved;
  if(!receipt&&storageAvailable.current){try{const raw=localStorage.getItem(key);if(raw)receipt=savedRequest(raw,action,recordId);}catch{setBlocked(true);setMessage(ar?'راجع الطلب المحفوظ أولاً.':'Review the saved request first.');return;}}
  receipt=receipt??{id:crypto.randomUUID(),action,recordId,values};
  lock.current=true;setBusy(true);setSaved(receipt);setValues(receipt.values);setMessage('');
  try{localStorage.setItem(key,JSON.stringify(receipt));}catch{storageAvailable.current=false;}
  try{
   const response=await fetch('/api/crm/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(receipt)});
   const result=await response.json();
   if(result.ok){
    try{if(JSON.parse(localStorage.getItem(key)??'null')?.id===receipt.id)localStorage.removeItem(key);}catch{}
    setSaved(null);setDone(true);setMessage(ar?'تم الحفظ في سناكي.':'Saved in Snacky OS.');
    if(!stay&&typeof result.href==='string'&&result.href.startsWith('/')&&!result.href.startsWith('//'))router.push(result.href);
    router.refresh();
   }else{
    setMessage(String(result.message??(ar?'لم يتم تأكيد الحفظ. أعد نفس الطلب.':'Save not confirmed. Retry the same request.')));
    if(result.resetAllowed){try{localStorage.removeItem(key);}catch{}setSaved(null);}
   }
  }catch{setMessage(ar?'النتيجة غير مؤكدة. أعد نفس الطلب لتجنب التكرار.':'The result is uncertain. Retry this same request to avoid duplicates.');}
  finally{lock.current=false;setBusy(false);}
 }
 const field=(f:CrmField)=>{
  const disabled=busy||Boolean(saved)||blocked||done||!ready;
  const props={name:f.name,id:`${action}-${recordId??'new'}-${f.name}`,required:f.required,disabled,value:values[f.name]??'',className:'field-input mt-1 w-full min-w-0',onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setValues(current=>({...current,[f.name]:e.target.value}))};
  return <label className={`block min-w-0 text-sm ${f.type==='textarea'?'sm:col-span-2':''}`} key={f.name}>
   <span className="font-medium text-slate-800">{f.label}{f.required?<span aria-hidden="true"> *</span>:null}</span>
   {f.type==='textarea'?<textarea {...props} rows={3} maxLength={4000}/>:f.type==='select'?<select {...props}>{f.options?.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}</select>:f.type==='checkbox'?<input name={f.name} type="checkbox" disabled={disabled} checked={values[f.name]==='true'} className="ms-3 size-5 align-middle" onChange={e=>setValues(current=>({...current,[f.name]:String(e.target.checked)}))}/>:<input {...props} type={f.type??'text'} min={f.min} max={f.max} step={f.step??(f.type==='number'?'0.01':undefined)} maxLength={f.type==='text'?4000:undefined}/>} 
   {f.hint?<span className="mt-1 block text-xs leading-5 text-slate-500">{f.hint}</span>:null}
  </label>;
 };
 return <form action={submit} className="space-y-4" dir={ar?'rtl':'ltr'}>
  {message?<p role={done?'status':'alert'} className={`rounded-lg border p-3 text-sm ${done?'border-emerald-200 bg-emerald-50 text-emerald-900':'border-amber-200 bg-amber-50 text-amber-950'}`}>{message}</p>:null}
  {saved&&!done?<p className="text-sm text-amber-900">{ar?'التفاصيل محفوظة ومقفلة حتى تأكيد النتيجة.':'The submitted details are saved and locked until the result is confirmed.'}</p>:null}
  {!storageAvailable.current?<p className="text-xs text-amber-800">{ar?'أبقِ الصفحة مفتوحة حتى تأكيد الحفظ. تخزين المتصفح غير متاح.':'Keep this page open until saving is confirmed. Browser storage is unavailable.'}</p>:null}
  <div className="grid gap-4 sm:grid-cols-2">{fields.filter(f=>!f.advanced).map(field)}</div>
  {fields.some(f=>f.advanced)?<details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">{ar?'تفاصيل إضافية — اختيارية':'More details — optional'}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{fields.filter(f=>f.advanced).map(field)}</div></details>:null}
  <button disabled={!ready||busy||blocked||done} className="btn-primary min-h-11 w-full sm:w-auto">{busy?(ar?'جارٍ الحفظ…':'Saving…'):done?(ar?'تم الحفظ':'Saved'):saved?(ar?'إعادة محاولة الطلب المحفوظ':'Retry saved request'):submitLabel}</button>
 </form>;
}
