"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { recordInvestorCommand } from "@/lib/investor-money-actions";

export type InvestorFundingReceipt = {id:string;transaction_date:string;description:string|null;amount:number|string;currency:string;account_id:string;exchange_rate_usd_to_lyd?:number|string|null};
type Props={kind:'contribution'|'payout';entityId:string;userId:string;remaining?:number;receipts?:InvestorFundingReceipt[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseSaved(raw:string,kind:string,entityId:string):Record<string,string> {
 const value=JSON.parse(raw);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>typeof v!=='string')||value.kind!==kind||value.entity_id!==entityId||!uuid.test(value.client_submission_id??''))throw new Error('Invalid saved request');
 return value;
}
function today() {
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 return ['year','month','day'].map(part=>parts.find(p=>p.type===part)?.value).join('-');
}
export function InvestorMoneyForm({kind,entityId,userId,remaining,receipts=[]}:Props) {
 const router=useRouter(),{locale}=useLanguage(),ar=locale==='ar';
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const key=`snacky:investor-money:v1:${userId}:${kind}:${entityId}`;
 const [draft,setDraft]=useState<Record<string,string>>({kind,entity_id:entityId,amount:remaining?.toFixed(2)??'',date:kind==='payout'?today():'',currency:'LYD',rate:'1',account:'snacky_lyd',method:'cash',reference:'',notes:'',funding_mode:'',existing_finance_id:'',confirm:''});
 const [saved,setSaved]=useState<Record<string,string>|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[blocked,setBlocked]=useState(false),[notice,setNotice]=useState(''),[success,setSuccess]=useState(false),[storageWarning,setStorageWarning]=useState(false);
 const inFlight=useRef(false);
 useEffect(()=>{
  let raw:string|null=null;
  try{raw=localStorage.getItem(key);}catch{setStorageWarning(true);}
  if(raw){try{const parsed=parseSaved(raw,kind,entityId);setSaved(parsed);setDraft(parsed);}catch{setBlocked(true);setNotice(tr('A saved money request could not be read. Review investor history before recording another one.','تعذر قراءة طلب مالي محفوظ. راجع سجل المستثمر قبل تسجيل عملية جديدة.'));}}
  setReady(true);
 },[key,entityId,kind]);
 const change=(field:string,value:string)=>setDraft(current=>({...current,[field]:value}));
 const clearSaved=(command:string)=>{try{const raw=localStorage.getItem(key);if(raw&&JSON.parse(raw).client_submission_id===command)localStorage.removeItem(key);}catch{setStorageWarning(true);}};
 const submit=async()=>{
  if(inFlight.current||blocked||!ready)return;
  let request=saved;
  if(!request){
   let raw:string|null=null;
   // Storage policy failures use the in-memory request. Corrupt stored data,
   // unlike unavailable storage, must block minting another payment identity.
   try{raw=localStorage.getItem(key);}catch{setStorageWarning(true);}
   if(raw){try{request=parseSaved(raw,kind,entityId);setDraft(request);}catch{setBlocked(true);setNotice(tr('Check the saved request and history before retrying.','راجع الطلب المحفوظ والسجل قبل إعادة المحاولة.'));return;}}
  }
  request=request??{...draft,client_submission_id:globalThis.crypto?.randomUUID?.()??''};
  if(!uuid.test(request.client_submission_id)){setNotice(tr('Could not prepare a safe request.','تعذر تجهيز طلب آمن.'));return;}
  inFlight.current=true;setBusy(true);setSaved(request);setNotice('');setSuccess(false);
  try{localStorage.setItem(key,JSON.stringify(request));}catch{setStorageWarning(true);}
  const fd=new FormData();Object.entries(request).forEach(([name,value])=>fd.set(name,value));
  try{
   const result=await recordInvestorCommand(fd);setNotice(result.message);
   if(result.ok){clearSaved(request.client_submission_id);setSaved(null);setSuccess(true);setDraft(current=>({...current,amount:'',confirm:''}));router.refresh();}
   else if(result.resetAllowed){clearSaved(request.client_submission_id);setSaved(null);router.refresh();}
  }catch{setNotice(tr('Result unknown. Retry the same saved request; do not record the money again.','النتيجة غير مؤكدة. أعد الطلب المحفوظ نفسه ولا تسجّل المبلغ مرة أخرى.'));}
  finally{inFlight.current=false;setBusy(false);}
 };
 return <form action={submit} className="space-y-3" dir={ar?'rtl':'ltr'}>
  <p className="text-sm text-slate-600">{kind==='payout'?tr('Record money already paid to the investor. This settles this month and creates one Finance cash-out; it does not send money.','سجّل المبلغ المدفوع فعلياً للمستثمر. تُحدَّث مستحقات الشهر وتُسجّل حركة صرف واحدة؛ لا يتم إرسال أموال.'):tr('Record actual capital received, separately from profit. Link an existing Finance receipt instead of recording that cash twice.','سجّل رأس المال المستلم فعلياً، منفصلاً عن الربح. اربط الحركة المالية الموجودة لتجنب تكرار النقدية.')}</p>
  {notice?<p role={success?'status':'alert'} className={`rounded-lg p-3 text-sm ${success?'bg-emerald-50 text-emerald-900':'bg-amber-50 text-amber-950'}`}>{notice}</p>:null}
  {saved?<p className="text-sm font-medium text-amber-900">{tr('Saved request: details are locked for a safe retry.','طلب محفوظ: التفاصيل مقفلة لإعادة المحاولة بأمان.')}</p>:null}
  {storageWarning?<p className="text-xs text-amber-900">{tr('Browser storage is unavailable. Keep this page open until the result is confirmed.','تخزين المتصفح غير متاح. أبقِ الصفحة مفتوحة حتى تتأكد النتيجة.')}</p>:null}
  <fieldset disabled={!ready||busy||Boolean(saved)||blocked} className="grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-2">
   {kind==='contribution'?<>
    <label className="text-sm sm:col-span-2">{tr('Was this capital already entered in Finance?','هل تم تسجيل رأس المال في المالية؟')}<select required className="field-input mt-1" value={draft.funding_mode} onChange={e=>change('funding_mode',e.target.value)}><option value="">{tr('Choose explicitly','اختر طريقة التسجيل')}</option><option value="link">{tr('Yes — link the existing money-in','نعم — ربط حركة القبض الموجودة')}</option><option value="new">{tr('No — record a new money-in','لا — تسجيل حركة قبض جديدة')}</option></select></label>
    {draft.funding_mode==='link'?<label className="text-sm sm:col-span-2">{tr('Existing Finance receipt','حركة القبض الموجودة')}<select required className="field-input mt-1" value={draft.existing_finance_id} onChange={e=>{const row=receipts.find(r=>r.id===e.target.value);if(row)setDraft(current=>({...current,existing_finance_id:row.id,amount:Number(row.amount).toFixed(2),date:row.transaction_date,currency:row.currency,account:row.account_id,rate:row.currency==='LYD'?'1':String(row.exchange_rate_usd_to_lyd??'')}));else change('existing_finance_id','');}}><option value="">{tr('Select the investor’s actual capital receipt','اختر حركة استلام رأس المال الفعلية')}</option>{receipts.map(row=><option key={row.id} value={row.id}>{row.transaction_date} · {row.amount} {row.currency} · {row.description??row.id}</option>)}</select></label>:null}
   </>:null}
   <label className="text-sm">{tr('Amount','المبلغ')}<input required type="number" min="0.01" step="0.01" max={remaining} className="field-input mt-1" value={draft.amount} onChange={e=>change('amount',e.target.value)}/></label>
   <label className="text-sm">{kind==='payout'?tr('Actual payout date','تاريخ الدفع الفعلي'):tr('Actual capital receipt date','تاريخ استلام رأس المال')}<input required type="date" className="field-input mt-1" value={draft.date} onChange={e=>change('date',e.target.value)}/></label>
   {kind==='contribution'?<label className="text-sm">{tr('Currency','العملة')}<select className="field-input mt-1" value={draft.currency} onChange={e=>setDraft(current=>({...current,currency:e.target.value,rate:e.target.value==='LYD'?'1':'',account:`${current.account.startsWith('owner')?'owner':'snacky'}_${e.target.value.toLowerCase()}`}))}><option value="LYD">LYD</option><option value="USD">USD</option></select></label>:null}
   {kind==='contribution'&&draft.currency==='USD'?<label className="text-sm">{tr('Historical LYD value per USD','القيمة المعتمدة بالدينار لكل دولار وقت الاستلام')}<input type="number" required min="0.000001" step="0.000001" className="field-input mt-1" value={draft.rate} onChange={e=>change('rate',e.target.value)}/></label>:null}
   <label className="text-sm">{kind==='payout'?tr('Paying account','الحساب المدفوع منه'):tr('Receiving account','الحساب المستلم')}<select required className="field-input mt-1" value={draft.account} onChange={e=>change('account',e.target.value)}><option value={`snacky_${draft.currency.toLowerCase()}`}>Snacky {draft.currency}</option><option value={`owner_${draft.currency.toLowerCase()}`}>{tr('Owner','المالك')} {draft.currency}</option></select></label>
   {kind==='payout'?<label className="text-sm">{tr('Method','الطريقة')}<select className="field-input mt-1" value={draft.method} onChange={e=>change('method',e.target.value)}><option value="cash">{tr('Cash','نقداً')}</option><option value="bank_transfer">{tr('Bank transfer','تحويل مصرفي')}</option><option value="card">{tr('Card','بطاقة')}</option><option value="other">{tr('Other','أخرى')}</option></select></label>:null}
   <label className="text-sm">{tr('Reference (optional)','المرجع (اختياري)')}<input className="field-input mt-1" value={draft.reference} maxLength={200} onChange={e=>change('reference',e.target.value)}/></label>
   <label className="text-sm sm:col-span-2">{tr('Note (optional)','ملاحظة (اختياري)')}<textarea className="field-input mt-1" rows={2} maxLength={2000} value={draft.notes} onChange={e=>change('notes',e.target.value)}/></label>
   <label className="flex items-start gap-2 text-sm sm:col-span-2"><input required type="checkbox" checked={draft.confirm==='yes'} onChange={e=>change('confirm',e.target.checked?'yes':'')}/><span>{tr('I confirm this is actual investor money, not an estimate, and it has not been recorded twice.','أؤكد أن المبلغ مستلم أو مدفوع فعلياً للمستثمر، وليس تقديراً، ولم يُسجّل مرتين.')}</span></label>
  </fieldset>
  <button className="btn-primary" disabled={!ready||busy||blocked}>{busy?tr('Recording…','جارٍ التسجيل…'):saved?tr('Retry saved request','إعادة محاولة الطلب المحفوظ'):kind==='payout'?tr('Record investor payout','تسجيل دفعة للمستثمر'):tr('Record capital received','تسجيل رأس المال المستلم')}</button>
 </form>;
}
