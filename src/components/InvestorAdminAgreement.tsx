/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { InvestorMoneyForm, type InvestorFundingReceipt } from "@/components/InvestorMoneyForm";
import { createInvestorAgreement } from "@/lib/investor-actions";
import { updateInvestorAgreement } from "@/lib/investor-agreement-actions";
import { formatFinanceMoney } from "@/lib/finance-balance";
import { FormField } from "@/components/ui";

type Props = {
  ar:boolean;
  selected?:any | null;
  locked?:boolean;
  capitalReceived?:number;
  contributions?:any[];
  receipts?:InvestorFundingReceipt[];
  receiptLookupError?:boolean;
  investorProfiles:any[];
  profileId:string;
};
const profitBasis=(ar:boolean)=><>
  <option value="">{ar?"اختر أساس الربح":"Choose profit basis"}</option>
  <option value="operating_profit">{ar?"الربح التشغيلي":"Operating profit"}</option>
  <option value="operating_profit_after_capex">{ar?"الربح بعد مشتريات الماكينات":"Operating profit after machine purchases"}</option>
</>;
export function InvestorCreateAgreement({ar,investorProfiles}:{
  ar:boolean;investorProfiles:any[];
}){
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 return <div className="space-y-4">
  <div className="flex flex-wrap items-center justify-between gap-3">
   <div><h3 className="text-lg font-bold text-slate-950">{tr("New investor agreement","اتفاق مستثمر جديد")}</h3>
    <p className="mt-1 text-sm text-slate-500">{tr("Create the agreement first. Receiving capital is a separate financial step.","أنشئ الاتفاق أولاً، ثم سجّل رأس المال المستلم كحركة مالية منفصلة.")}</p>
   </div>
   <Link href="/team/new" className="btn-secondary">{tr("Create investor login","إنشاء حساب مستثمر")}</Link>
  </div>
  <form action={createInvestorAgreement} className="grid gap-4 sm:grid-cols-2">
   <FormField label={tr("Investor account","حساب المستثمر")} required>
    <select name="investor_user_id" defaultValue="" className="field-input" required>
     <option value="">{tr("Select account","اختر الحساب")}</option>
     {investorProfiles.map(p=><option value={p.id} key={p.id}>{p.full_name||p.email||p.id}</option>)}
    </select>
   </FormField>
   <FormField label={tr("Investor name","اسم المستثمر")} required><input className="field-input" name="investor_name" required/></FormField>
   <FormField label={tr("First month","أول شهر")} required><input name="first_month" type="month" className="field-input" required/></FormField>
   <FormField label={tr("Share %","نسبة الأرباح %")} required><input name="profit_share_percent" type="number" defaultValue="30" min="0.01" max="100" step="0.01" className="field-input" required/></FormField>
   <FormField label={tr("Profit basis","أساس الأرباح")} required><select name="profit_basis" className="field-input" required defaultValue="">{profitBasis(ar)}</select></FormField>
   <FormField label={tr("Agreed capital · LYD","رأس المال المتفق عليه · د.ل")}><input name="investment_amount_lyd" type="number" step="0.01" min="0" className="field-input"/></FormField>
   <details className="sm:col-span-2 rounded-lg border border-slate-200 p-3">
    <summary className="cursor-pointer text-sm font-semibold text-slate-700">{tr("Optional contract details","تفاصيل الاتفاق الاختيارية")}</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
     <FormField label={tr("End date","تاريخ النهاية")}><input name="end_date" type="date" className="field-input"/></FormField>
     <FormField label={tr("LYD distribution cap","سقف التوزيعات بالدينار")}><input name="payout_cap_lyd" type="number" step="0.01" min="0" className="field-input"/></FormField>
     <FormField label={tr("Notes","ملاحظات")}><textarea name="notes" rows={2} className="field-input"/></FormField>
    </div>
   </details>
   <button className="btn-primary sm:col-span-2 sm:justify-self-start" type="submit" disabled={!investorProfiles.length}>
    {tr("Create agreement","إنشاء الاتفاق")}
   </button>
  </form>
 </div>;
}

export function InvestorAdminAgreement({
 ar,selected,locked=false,capitalReceived=0,contributions=[],receipts=[],
 receiptLookupError=false,investorProfiles,profileId,
}:Props){
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 if(!selected)return <InvestorCreateAgreement ar={ar} investorProfiles={investorProfiles}/>;
 return <div className="space-y-4">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div>
    <h3 className="text-lg font-bold text-slate-950">{tr("Agreement & capital","الاتفاق ورأس المال")}</h3>
    <p className="mt-1 text-sm text-slate-500">
     {tr("Contract terms, capital records and investor access.","شروط الاتفاق وسجلات رأس المال وحساب المستثمر.")}
    </p>
   </div>
   <Link href={`/investor?agreement=${encodeURIComponent(selected.id)}`} className="btn-secondary">
    {tr("View investor page","عرض صفحة المستثمر")}
   </Link>
  </div>
  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
   <p className="text-xs font-medium text-slate-500">{tr("Recorded capital received","رأس المال المستلم المسجّل")}</p>
   <strong dir="ltr" className="mt-1 block text-2xl font-bold tabular-nums text-slate-950">
    {formatFinanceMoney(capitalReceived)} LYD
   </strong>
   <p className="mt-1 text-xs text-slate-500">{tr("Based on linked Finance receipts, not contractual capital alone.","بناءً على إيصالات المالية المرتبطة، وليس قيمة العقد وحدها.")}</p>
  </div>
  <details className="rounded-xl border border-slate-200 p-4">
   <summary className="cursor-pointer font-semibold text-slate-900">{tr("Capital receipts","إيصالات رأس المال")}</summary>
   <div className="mt-4 space-y-3">
    {contributions.length ? contributions.map(c=><div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 text-sm">
     <span>{c.received_date} · {c.original_amount} {c.currency}</span>
     <Link href={`/finance/transactions/${c.finance_transaction_id}`} className="text-emerald-800 underline underline-offset-2">
      {tr("Finance record","حركة المالية")}
     </Link>
    </div>) : <p className="text-sm text-slate-500">{tr("No capital receipt linked yet.","لا يوجد إيصال رأس مال مرتبط بعد.")}</p>}
    {receiptLookupError?<p className="text-sm text-rose-800">{tr("Finance receipts are unavailable. Do not record this twice.","إيصالات المالية غير متاحة. لا تُسجّل العملية مرتين.")}</p>:
     <InvestorMoneyForm key={selected.id} kind="contribution" entityId={selected.id} userId={profileId} receipts={receipts}/>}
   </div>
  </details>
  <details className="rounded-xl border border-slate-200 p-4">
   <summary className="cursor-pointer font-semibold text-slate-900">{tr("Edit agreement","تعديل الاتفاق")}</summary>
   <p className="mt-3 text-sm text-slate-500">{locked?
    tr("Original profit terms are locked because a month is approved.","شروط الأرباح الأساسية مقفلة بعد اعتماد أحد الأشهر."):
    tr("Edit only the terms agreed with the investor.","عدّل فقط الشروط المتفق عليها مع المستثمر.")}</p>
   <form action={updateInvestorAgreement} className="mt-4 grid gap-3 sm:grid-cols-2">
    <input type="hidden" name="agreement_id" value={selected.id}/>
    <FormField label={tr("Name","الاسم")}><input name="investor_name" className="field-input" defaultValue={selected.investor_name} required/></FormField>
    <FormField label={tr("Profit share %","نسبة الأرباح %")}><input name="profit_share_percent" type="number" className="field-input" min="0.01" max="100" step="0.01" defaultValue={selected.profit_share_percent} readOnly={locked} required/></FormField>
    <FormField label={tr("Start date","تاريخ البداية")}><input name="start_date" type="date" className="field-input" defaultValue={selected.start_date} readOnly={locked} required/></FormField>
    <FormField label={tr("End date","تاريخ النهاية")}><input name="end_date" type="date" className="field-input" defaultValue={selected.end_date??""}/></FormField>
    <FormField label={tr("Profit basis","أساس الأرباح")}><select name="profit_basis" className="field-input" defaultValue={selected.profit_basis_confirmed?selected.profit_basis:""} disabled={locked} required>{profitBasis(ar)}</select>{locked?<input name="profit_basis" type="hidden" value={selected.profit_basis}/>:null}</FormField>
    <FormField label={tr("Agreement status","حالة الاتفاق")}><select name="status" defaultValue={selected.status} className="field-input">{["draft","active","completed","cancelled"].map(status=><option key={status} value={status}>{status}</option>)}</select></FormField>
    <FormField label={tr("Agreed capital · LYD","رأس المال المتفق عليه · د.ل")}><input name="investment_amount_lyd" type="number" min="0" step="0.01" className="field-input" defaultValue={selected.investment_amount_lyd??0}/></FormField>
    <FormField label={tr("LYD payout cap (optional)","سقف التوزيعات بالدينار (اختياري)")}><input name="payout_cap_lyd" type="number" min="0" step="0.01" className="field-input" defaultValue={selected.payout_cap_lyd??""}/></FormField>
    <FormField label={tr("Notes","ملاحظات")}><textarea name="notes" rows={2} className="field-input" defaultValue={selected.notes??""}/></FormField>
    <button className="btn-primary sm:col-span-2 sm:justify-self-start" type="submit">{tr("Save changes","حفظ التغييرات")}</button>
   </form>
  </details>
  <details className="rounded-xl border border-slate-200 p-4">
   <summary className="cursor-pointer font-semibold text-slate-900">{tr("Add another investor","إضافة مستثمر آخر")}</summary>
   <div className="mt-4"><InvestorCreateAgreement ar={ar} investorProfiles={investorProfiles}/></div>
  </details>
 </div>;
}
