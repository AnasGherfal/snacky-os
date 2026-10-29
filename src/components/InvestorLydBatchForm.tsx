"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { recordActualInvestorLydBatch } from "@/lib/investor-lyd-payout-actions";

export type PayableInvestorMonth={month_start:string;due_lyd:number;paid_lyd:number;remaining_lyd:number};
type Props={
 agreementId:string;
 submissionId:string;
 months:PayableInvestorMonth[];
 remainingGoalUsd:number;
 today:string;
 ar:boolean;
};
const amount=(n:number)=>new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
function SubmitPayout({disabled,ar}:{disabled:boolean;ar:boolean}){
 const {pending}=useFormStatus();
 return <button className="btn-primary w-full sm:w-auto" type="submit" disabled={disabled||pending}>
  {pending?(ar?"جارٍ تسجيل الدفع…":"Recording payment…"):(ar?"تسجيل دفعة تمت بالفعل":"Record completed LYD payment")}
 </button>;
}
export function InvestorLydBatchForm({agreementId,submissionId,months,remainingGoalUsd,today,ar}:Props){
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const [chosen,setChosen]=useState<Record<string,string>>({});
 const [rate,setRate]=useState("");
 const values=useMemo(()=>months.flatMap(row=>{
  const value=chosen[row.month_start];if(value===undefined)return [];
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0||n>row.remaining_lyd+0.005||Math.abs(n*100-Math.round(n*100))>1e-6)return [];
  return [{month_start:row.month_start,amount_lyd:n}];
 }),[chosen,months]);
 const selectedCount=Object.keys(chosen).length;
 const total=values.reduce((sum,v)=>sum+v.amount_lyd,0);
 const numericRate=Number(rate);
 const usdCredit=rate.trim()!==""&&Number.isFinite(numericRate)&&numericRate>0?Math.round(total/numericRate*100)/100:null;
 const overGoal=usdCredit!==null&&usdCredit>remainingGoalUsd+0.005;
 const invalid=selectedCount===0||selectedCount!==values.length||usdCredit===null||usdCredit<=0||overGoal;
 return <details className="rounded-xl border border-slate-200 bg-white p-4">
  <summary className="cursor-pointer font-semibold text-slate-950">{tr("Record a completed LYD payment · one or several months","تسجيل دفعة بالدينار تمت بالفعل · لشهر أو عدة أشهر")}</summary>
  <p className="mt-3 text-sm text-slate-600">{tr("Select the months this payment settles. You may pay part of a month's remaining LYD balance. One payment creates one Finance cash-out and separate month allocations.","اختر الأشهر التي تغطيها الدفعة. يمكنك دفع جزء من باقي مستحق الشهر بالدينار. تُسجل حركة صرف مالية واحدة مع توزيع المبلغ على الأشهر المختارة.")}</p>
  <form action={recordActualInvestorLydBatch} className="mt-4 space-y-4">
   <input type="hidden" name="agreement_id" value={agreementId}/>
   <input type="hidden" name="client_submission_id" value={submissionId}/>
   <input type="hidden" name="allocations_json" value={JSON.stringify(values)}/>
   <div className="space-y-2">
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{tr("Unpaid confirmed months · LYD","الأشهر المعتمدة وغير المدفوعة · د.ل")}</p>
    {months.map(row=>{
     const active=chosen[row.month_start]!==undefined;
     return <div key={row.month_start} className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <label className="flex min-w-0 cursor-pointer items-start gap-3">
       <input type="checkbox" className="mt-1 size-4" checked={active} onChange={e=>setChosen(previous=>{
        const next={...previous};
        if(e.target.checked)next[row.month_start]=row.remaining_lyd.toFixed(2);else delete next[row.month_start];
        return next;
       })}/>
       <span><strong className="block text-sm">{row.month_start.slice(0,7)}</strong><span className="mt-1 block text-xs text-slate-600">{tr("Due","المستحق")}: {amount(row.due_lyd)} · {tr("Paid","المدفوع")}: {amount(row.paid_lyd)} · {tr("Remaining","المتبقي")}: <strong>{amount(row.remaining_lyd)} LYD</strong></span></span>
      </label>
      {active?<label className="text-xs text-slate-700">{tr("Allocate LYD","المبلغ المخصص بالدينار")}<input className="field-input mt-1 w-full sm:w-36" type="number" min="0.01" max={row.remaining_lyd.toFixed(2)} step="0.01" required value={chosen[row.month_start]} onChange={e=>setChosen(prev=>({...prev,[row.month_start]:e.target.value}))}/></label>:null}
     </div>;
    })}
   </div>
   <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm">{tr("Date money was actually paid","تاريخ الدفع الفعلي")}<input className="field-input mt-1" name="payout_date" type="date" defaultValue={today} max={today} required/></label>
    <label className="text-sm">{tr("Actual rate on payment date (LYD per USD)","سعر الصرف يوم الدفع (دينار لكل دولار)")}<input className="field-input mt-1" name="lyd_per_usd" type="number" min="0.000001" max="99999.999999" step="0.000001" value={rate} onChange={e=>setRate(e.target.value)} placeholder={tr("e.g. 10 (only if actual)","مثلاً 10 إذا كان السعر الفعلي")} required/></label>
    <label className="text-sm">{tr("Account paid from (LYD)","الحساب الذي دُفع منه (د.ل)")}<select className="field-input mt-1" name="payment_account" defaultValue="snacky_lyd"><option value="snacky_lyd">Snacky LYD</option><option value="owner_lyd">{tr("Owner LYD","حساب المالك بالدينار")}</option></select></label>
    <label className="text-sm">{tr("Actual payment method","طريقة الدفع الفعلية")}<select className="field-input mt-1" name="payment_method" defaultValue="bank_transfer"><option value="bank_transfer">{tr("Bank transfer","تحويل مصرفي")}</option><option value="cash">{tr("Cash","نقداً")}</option><option value="other">{tr("Other","أخرى")}</option></select></label>
    <label className="text-sm sm:col-span-2">{tr("Payment receipt / reference","مرجع الحوالة أو إيصال الدفع")}<input className="field-input mt-1" name="payment_reference" minLength={3} maxLength={200} placeholder={tr("Reference to an actual completed payment","رقم مرجع دفع تم بالفعل")} required/></label>
    <label className="text-sm sm:col-span-2">{tr("Optional note","ملاحظة اختيارية")}<textarea className="field-input mt-1" name="notes" maxLength={2000} rows={2}/></label>
   </div>
   <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><span className="text-sm text-slate-600">{tr("Actual LYD total to record","إجمالي الدفعة المسجلة بالدينار")}</span><strong className="text-2xl tabular-nums">{amount(total)} LYD</strong></div>
    <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-2 text-sm"><span>{tr("Credit to USD goal at this payment rate","ما يُحتسب نحو هدف الدولار بسعر هذه الدفعة")}</span><strong>{usdCredit===null?"—":"$"+amount(usdCredit)}</strong></div>
    <div className="mt-1 flex flex-wrap justify-between gap-2 text-sm"><span>{tr("USD goal remaining before payment","المتبقي من هدف الدولار قبل هذه الدفعة")}</span><strong>{"$"+amount(remainingGoalUsd)}</strong></div>
    {overGoal?<p role="alert" className="mt-2 text-sm text-rose-800">{tr("The payment exceeds the remaining contractual USD goal. Lower the LYD amount.","الدفعة تتجاوز المتبقي من الهدف التعاقدي بالدولار. قلّل مبلغ الدينار.")}</p>:null}
   </div>
   <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" name="confirm_actual_paid" value="yes" required/><span>{tr("I confirm I already paid this exact LYD amount. This only records the transaction; it does not send money. I checked that no previous payment is being recorded twice.","أؤكد أنني دفعت هذا المبلغ بالدينار بالفعل. هذا تسجيل فقط وليس حوالة، وقد تحققت من عدم تكرار الدفع.")}</span></label>
   <SubmitPayout disabled={invalid} ar={ar}/>
  </form>
 </details>;
}
