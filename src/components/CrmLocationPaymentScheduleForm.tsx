'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

type Props={
 locationId:string;
 rentAmount:number;
 agreementType:string;
 frequency:string;
 nextDueDate:string;
 recurring:boolean;
 noticeDays:number;
 ar:boolean;
};

export function CrmLocationPaymentScheduleForm(props:Props){
 const router=useRouter();
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const tr=(en:string,ar:string)=>props.ar?ar:en;
 async function submit(formData:FormData){
  setBusy(true);setMessage('');
  const payload={
   location_id:props.locationId,
   rent_amount:Number(formData.get('rent_amount')||0),
   agreement_type:String(formData.get('agreement_type')||'other'),
   frequency:String(formData.get('frequency')||'monthly'),
   next_due_date:String(formData.get('next_due_date')||''),
   recurring:formData.get('recurring')==='yes',
   notice_days:Number(formData.get('notice_days')||7),
  };
  try{
   const response=await fetch('/api/crm/location-payment-schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const data=await response.json().catch(()=>({}));
   if(!response.ok||!data.ok)throw new Error(data.code||'save_failed');
   setMessage(tr('Saved. Future rent obligations will appear automatically in My Work.','تم الحفظ. ستظهر التزامات الإيجار القادمة تلقائياً في «عملي اليوم».'));
   router.refresh();
  }catch{
   setMessage(tr('Could not save the payment schedule. Report the Snacky OS issue and try again.','تعذر حفظ جدول الدفع. بلّغ عن مشكلة Snacky OS ثم حاول مرة أخرى.'));
  }finally{setBusy(false);}
 }
 return <section className="surface-card" dir={props.ar?'rtl':'ltr'}>
  <h2 className="font-semibold">{tr('Rent & recurring payment setup','إعداد الإيجار والدفع الدوري')}</h2>
  <p className="mt-2 text-sm text-slate-600">{tr('This controls the rent terms shown to Customer Relations and creates a separate unpaid obligation for every payment period. It does not create a Finance expense or mark anything paid.','هذا الإعداد يحدد شروط الإيجار الظاهرة لعلاقات العملاء، وينشئ التزاماً مستقلاً غير مدفوع لكل فترة دفع. لا ينشئ مصروفاً مالياً ولا يسجّل أي دفعة كمدفوعة.')}</p>
  <form action={submit} className="mt-4 grid gap-4 md:grid-cols-2">
   <label className="text-sm">{tr('Agreement type','نوع الاتفاق')}
    <select name="agreement_type" defaultValue={props.agreementType||'other'} className="field-input mt-1">
     <option value="fixed_rent">{tr('Fixed rent','إيجار ثابت')}</option>
     <option value="revenue_share">{tr('Revenue share','نسبة من الإيراد')}</option>
     <option value="free_service">{tr('No rent','دون إيجار')}</option>
     <option value="other">{tr('Other / not recorded','أخرى / غير مسجّل')}</option>
    </select>
   </label>
   <label className="text-sm">{tr('Rent amount (LYD)','قيمة الإيجار (د.ل)')}
    <input name="rent_amount" type="number" min="0" step="0.01" defaultValue={props.rentAmount||0} className="field-input mt-1"/>
   </label>
   <label className="text-sm">{tr('Payment frequency','تكرار الدفع')}
    <select name="frequency" defaultValue={props.frequency||'monthly'} className="field-input mt-1">
     <option value="once">{tr('Once','مرة واحدة')}</option>
     <option value="monthly">{tr('Monthly','شهري')}</option>
     <option value="quarterly">{tr('Quarterly','ربع سنوي')}</option>
     <option value="yearly">{tr('Yearly','سنوي')}</option>
    </select>
   </label>
   <label className="text-sm">{tr('Next payment due date','موعد الدفع القادم')}
    <input name="next_due_date" type="date" defaultValue={props.nextDueDate||''} className="field-input mt-1"/>
   </label>
   <label className="text-sm">{tr('Show/create obligation this many days before due','إظهار/إنشاء الالتزام قبل الموعد بعدد الأيام')}
    <input name="notice_days" type="number" min="0" max="30" defaultValue={props.noticeDays??7} className="field-input mt-1"/>
   </label>
   <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm">
    <input name="recurring" type="checkbox" value="yes" defaultChecked={props.recurring}/>
    <span><strong>{tr('Recurring rent','إيجار دوري')}</strong><span className="block text-xs text-slate-500">{tr('Create a new unpaid payment obligation every period.','إنشاء التزام دفع جديد غير مدفوع في كل فترة.')}</span></span>
   </label>
   <div className="md:col-span-2 flex items-center gap-3">
    <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">{busy?tr('Saving…','جارٍ الحفظ…'):tr('Save rent schedule','حفظ جدول الإيجار')}</button>
    {message?<p role="status" className="text-sm text-slate-700">{message}</p>:null}
   </div>
  </form>
 </section>;
}
