/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { InvestorLydBatchForm } from "@/components/InvestorLydBatchForm";
import { InvestorAdminTabs } from "@/components/InvestorAdminTabs";
import { InvestorMonthlyTable, InvestorOwnerEvidence } from "@/components/InvestorMonthlyTable";
import { loadAuthorizedInvestorCashOutAudit } from "@/lib/investor-portal-cashout";
import { reconcileRecordedInvestorDrafts } from "@/lib/investor-recorded-draft";
import {
 buildInvestorMonthlyLedger,
 type InvestorHistoricLedgerMonth, type InvestorGeneratedLedgerMonth,
 type InvestorLydBatch, type InvestorLydAllocation, type InvestorUsdLegacyPayout
} from "@/lib/investor-monthly-ledger";

type RecordedInvestorDraft=InvestorGeneratedLedgerMonth & {
 revenue_lyd?:number|string|null;cogs_lyd?:number|string|null;
 gross_profit_lyd?:number|string|null;operating_expenses_lyd?:number|string|null;
 expense_breakdown?:Array<{key:string;label:string;amount:number|string}>|null;
 review_checks?:{issues?:string[]}|null;
};

type Props={
 agreementId:string;investorUserId:string;investorName?:string;sharePercent?:number|string;
 startDate?:string;endDate?:string|null;investmentUsd?:number|string|null;
 capUsd?:number|string|null;ar:boolean;admin?:boolean;
 reviewPanel?:ReactNode;managePanel?:ReactNode;
 initialAdminTab?:"review"|"payment"|"manage";
 unresolvedLegacyPayments?:boolean
};
const money=(number:number)=>new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(number);
const tripoliToday=()=>{
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 return ["year","month","day"].map(part=>parts.find(x=>x.type===part)?.value??"").join("-");
};
async function allRows(builder:(from:number,to:number)=>any):Promise<any[]>{
 const rows:any[]=[];
 for(let from=0;from<50000;from+=500){
  const result=await builder(from,from+499);
  if(result.error)throw result.error;
  const page=result.data??[];
  rows.push(...page);if(page.length<500)return rows;
 }
 throw new Error("Investor records exceeded safe pagination limit");
}

export async function InvestorYearOverview({agreementId,investorUserId,investorName,sharePercent,
 startDate="2026-01-01",endDate,capUsd,ar,admin=false,reviewPanel,managePanel,initialAdminTab="review",unresolvedLegacyPayments=false}:Props){
 if(capUsd==null)return null;
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const db=await getAuthenticatedSupabaseServerClient();
 const unavailable=()=> <div role="alert" className="surface-card border-rose-200 bg-rose-50 text-sm text-rose-900">
  {tr("Investor data could not be verified. The monthly balances are not assumed to be zero. Reload or contact Snacky management.",
      "تعذر التحقق من بيانات المستثمر. لا نفترض أن الأرصدة الشهرية صفر. أعد التحميل أو تواصل مع إدارة سناكي.")}
 </div>;
 if(!db)return unavailable();
 let historical:InvestorHistoricLedgerMonth[],generated:RecordedInvestorDraft[];
 let batches:InvestorLydBatch[],allocations:InvestorLydAllocation[],legacyUsdPayouts:InvestorUsdLegacyPayout[];
 try{
  const [h,g,b,a,u]=await Promise.all([
   allRows((from,to)=>db.from("investor_historical_months")
    .select("month_start,net_profit_lyd,exchange_rate_lyd_per_usd,confirmed_payable_usd,confirmed_paid_usd,payment_confirmed_at")
    .eq("investor_user_id",investorUserId).gte("month_start",startDate).order("month_start").order("id").range(from,to)),
   allRows((from,to)=>{
    let q=db.from("investor_monthly_statements")
     .select("month_start,revenue_lyd,cogs_lyd,gross_profit_lyd,operating_expenses_lyd,operating_profit_lyd,investor_share_due_lyd,profit_basis,capital_purchases_lyd,calculation_status,source_complete,expense_breakdown,review_checks")
     .eq("agreement_id",agreementId).gte("month_start",startDate).order("month_start").order("id").range(from,to);
    return q;
   }),
   allRows((from,to)=>db.from("investor_lyd_payout_batches")
    .select("id,amount_lyd,credited_usd,lyd_per_usd,payout_date,payment_reference")
    .eq("agreement_id",agreementId).order("payout_date",{ascending:false}).order("id").range(from,to)),
   allRows((from,to)=>db.from("investor_lyd_payout_allocations")
    .select("payout_id,month_start,amount_lyd").eq("agreement_id",agreementId).order("month_start").order("id").range(from,to)),
   allRows((from,to)=>db.from("investor_usd_payouts")
    .select("month_start,amount_usd,lyd_equivalent").eq("agreement_id",agreementId).order("month_start").order("id").range(from,to))
  ]);
  historical=h as InvestorHistoricLedgerMonth[];
  generated=g as RecordedInvestorDraft[];
  batches=b as InvestorLydBatch[];allocations=a as InvestorLydAllocation[];
  legacyUsdPayouts=u as InvestorUsdLegacyPayout[];
  // Estimates are visible to the investor, but remain clearly preliminary and
  // never enter finalized entitlements or payment eligibility.
 }catch(error){console.error("[investor] Monthly ledger failed to load",error);return unavailable();}
 // The ongoing month should be visible in the chronology without inventing
 // a completed profit or payout amount.
 const ongoingMonth=tripoliToday().slice(0,7)+"-01";
 if(ongoingMonth>=startDate&&(!endDate||ongoingMonth<=endDate)
    &&!historical.some(h=>h.month_start===ongoingMonth)
    &&!generated.some(g=>g.month_start===ongoingMonth)){
   generated.push({month_start:ongoingMonth,calculation_status:"in_progress",
    operating_profit_lyd:null,investor_share_due_lyd:null});
 }
 // Reconcile the existing, unfinalized amounts from all active Finance debits.
 // No cash flow entry (including Arabic budget adjustments) is omitted from
 // the investor's cash register, and no new financial records are written.
 let finance;
 try {
  finance=await loadAuthorizedInvestorCashOutAudit({agreementId,investorUserId,startDate,endDate,
   months:generated.filter(g=>g.calculation_status==="draft").map(g=>g.month_start)});
 }catch(error){
  console.error("[investor] Company money-out verification unavailable",error);
  return unavailable();
 }
 // Display the exact stored month draft separately from the audited payout ledger.
 // Its figures are estimates, never approved entitlements or payment eligibility.
 const lastCompleted=tripoliToday().slice(0,7);
 const latestSavedDraft=[...generated]
  .filter(row=>row.calculation_status==="draft"&&row.month_start.slice(0,7)<lastCompleted)
  .sort((a,b)=>b.month_start.localeCompare(a.month_start))[0]??null;
 const draftBreakdown=(latestSavedDraft?.expense_breakdown??[])
  .filter(item=>Number.isFinite(Number(item.amount)));
 const draftFormat=(value:unknown)=>value==null||!Number.isFinite(Number(value))?"—":money(Number(value));
 const calculatedDrafts=reconcileRecordedInvestorDrafts({
  statements:generated,sourceAudit:finance.audit,policies:finance.policies,
  profitShare:Number(sharePercent??NaN),salesByMonth:finance.salesByMonth
 });
 const ledger=buildInvestorMonthlyLedger({startDate,endDate,capUsd,historical,
  generated:calculatedDrafts,batches,allocations,legacyUsdPayouts});
 const fmtUsd=(v:number)=>"$"+money(v);
 const ownerSourceEntries=admin?finance.audit.rows.filter(r=>
  (r.review_status==="needs_review"||r.needs_review) &&
  generated.some(g=>g.calculation_status==="draft" &&
   g.month_start.slice(0,7)===String(r.transaction_date??"").slice(0,7)))
  .map(r=>({id:String(r.id??""),date:String(r.transaction_date??""),
   description:String(r.description??r.category??""),
   amount:Number(r.amount??0),currency:String(r.currency??"LYD")})):undefined;
 return <section className="space-y-4" aria-label={tr("Investor financial statement","الكشف المالي للمستثمر")}>
  {latestSavedDraft ? <section className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm" aria-label={tr("Latest recorded monthly draft","آخر مسودة شهرية مسجلة")}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-amber-100 bg-amber-50/60 px-5 py-4">
     <div>
      <div className="flex flex-wrap items-center gap-2">
       <h3 className="font-bold text-slate-900">{tr("Latest monthly calculation","آخر حساب شهري")} · {latestSavedDraft.month_start.slice(0,7)}</h3>
       <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900">{tr("Draft — not approved","مسودة — غير معتمدة")}</span>
      </div>
      <p className="mt-1 text-xs text-slate-700">{tr("Recorded from the month-end ledger. This estimate is not a payable distribution until the evidence is reconciled and the month is approved.",
       "الحساب محفوظ من سجلات نهاية الشهر. هذه حصة تقديرية وليست مستحقة للدفع حتى مطابقة المستندات واعتماد الشهر.")}</p>
     </div>
     <div className="text-end">
      <p className="text-xs text-slate-600">{tr("Estimated investor share","الحصة التقديرية للمستثمر")}</p>
      <strong dir="ltr" className="mt-1 block text-2xl font-bold tabular-nums text-emerald-800">{draftFormat(latestSavedDraft.investor_share_due_lyd)} <span className="text-sm">LYD</span></strong>
     </div>
    </div>
    <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-4">
     {[
      [tr("Revenue","الإيرادات"),latestSavedDraft.revenue_lyd],
      [tr("Cost of products","تكلفة المنتجات"),latestSavedDraft.cogs_lyd],
      [tr("Operating expenses","المصاريف التشغيلية"),latestSavedDraft.operating_expenses_lyd],
      [tr("Operating profit","الربح التشغيلي"),latestSavedDraft.operating_profit_lyd]
     ].map(([label,value])=><div className="rounded-lg bg-slate-50 p-3" key={String(label)}>
      <p className="text-xs text-slate-600">{label}</p>
      <strong dir="ltr" className="mt-1 block text-base font-bold tabular-nums text-slate-900">{draftFormat(value)}</strong>
      <p className="text-[10px] text-slate-500">LYD</p>
     </div>)}
    </div>
    {draftBreakdown.length>0?<details className="border-t border-slate-100 px-5 py-3">
     <summary className="cursor-pointer text-sm font-semibold text-slate-800">{tr("View operating expense breakdown","عرض تفاصيل المصاريف التشغيلية")}</summary>
     <div className="mt-3 divide-y divide-slate-100">
      {draftBreakdown.map((item,index)=><div className="flex justify-between gap-3 py-2 text-sm" key={item.key+index}>
       <span className="text-slate-700">{item.label}</span>
       <strong dir="ltr" className="shrink-0 tabular-nums text-slate-950">{draftFormat(item.amount)} LYD</strong>
      </div>)}
     </div>
    </details>:null}
   </section> : null}
  <InvestorMonthlyTable ledger={ledger}
   investorName={investorName||tr("Investor","المستثمر")}
   sharePercent={sharePercent??null} ar={ar}/>
  {admin && reviewPanel && managePanel ? <InvestorAdminTabs ar={ar} initialTab={initialAdminTab}
     review={<div className="space-y-5">
       {reviewPanel}
       <InvestorOwnerEvidence ar={ar} cashOutByMonth={finance.audit.byMonth}
        cashOutIssues={finance.audit.auditIssues} salesByMonth={finance.salesByMonth}
        ownerSourceEntries={ownerSourceEntries}/>
     </div>} manage={managePanel}
     payment={<div className="space-y-4">
       <div>
        <h3 className="text-lg font-bold text-slate-950">{tr("Record an investor payment","تسجيل دفعة للمستثمر")}</h3>
        <p className="mt-1 text-sm text-slate-500">{tr("Record an actual LYD payment. This does not send money.","سجّل دفعة تمت بالفعل بالدينار؛ هذا التسجيل لا يحوّل المال.")}</p>
       </div>
       {unresolvedLegacyPayments?<p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        {tr("Older investor payment entries need Finance reconciliation before another payment.","تحتاج دفعات مستثمر سابقة إلى مطابقة مع المالية قبل تسجيل دفعة أخرى.")}
       </p>:null}
       {ledger.needsReview ? <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
        {tr("Payment records need reconciliation before another payout.","سجلات الدفعات تحتاج مطابقة قبل تسجيل دفعة جديدة.")}
       </p> : ledger.remainingGoalUsd<=0 ?
        <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900">
         {tr("Agreed payout goal reached.","تم بلوغ سقف التوزيعات المتفق عليه.")}
        </p> : ledger.payableMonths.length>0 ?
        <InvestorLydBatchForm agreementId={agreementId} submissionId={randomUUID()}
         months={ledger.payableMonths} remainingGoalUsd={ledger.remainingGoalUsd}
         today={tripoliToday()} ar={ar} embedded/> :
        <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
         {tr("No approved unpaid months yet. Review and approve a month first.","لا توجد أشهر معتمدة وغير مدفوعة. راجع الشهر واعتمده أولاً.")}
        </p>}
       {batches.length>0?<details className="surface-card">
   <summary className="cursor-pointer font-semibold">{tr("Payment receipts","إيصالات الدفعات")} · {batches.length}</summary>
   <div className="mt-4 divide-y divide-slate-100">{batches.map(batch=><div className="flex flex-wrap justify-between gap-3 py-3 text-sm" key={batch.id}>
    <div><strong>{money(Number(batch.amount_lyd))} {tr("LYD","د.ل")}</strong><p className="mt-1 text-xs text-slate-500">{batch.payout_date} · {batch.payment_reference}</p></div>
    <div className="text-end text-xs text-slate-600">
     <p>{tr("Goal credit","المحتسب نحو الهدف")}: {fmtUsd(Number(batch.credited_usd))}</p>
     <p className="mt-1">{tr("Payment-day rate","سعر صرف يوم الدفع")}: {Number(batch.lyd_per_usd).toFixed(3)} {tr("LYD/USD","د.ل/دولار")}</p>
     <p className="mt-1">{tr("Months covered","الأشهر المشمولة")}: {allocations.filter(a=>a.payout_id===batch.id).map(a=>a.month_start.slice(0,7)).join(", ")||"—"}</p>
    </div>
   </div>)}</div>
  </details>:<p role="status" className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
   {ledger.totalPaidLyd===0?
    tr("No profit payments have been made or recorded yet.","لم تُدفع أو تُسجل أي توزيعات أرباح حتى الآن."):
    tr("No recent LYD payout receipts. Earlier payments remain reflected in confirmed balances.","لا توجد إيصالات دفعات دينار حديثة؛ وتبقى الدفعات السابقة ضمن الأرصدة المعتمدة.")}
  </p>}

     </div>}/>
   : <>
     {admin&&!ledger.needsReview&&ledger.payableMonths.length>0&&ledger.remainingGoalUsd>0?
       <InvestorLydBatchForm agreementId={agreementId} submissionId={randomUUID()}
        months={ledger.payableMonths} remainingGoalUsd={ledger.remainingGoalUsd}
        today={tripoliToday()} ar={ar}/>:null}
     {batches.length>0?<details className="surface-card">
   <summary className="cursor-pointer font-semibold">{tr("Payment receipts","إيصالات الدفعات")} · {batches.length}</summary>
   <div className="mt-4 divide-y divide-slate-100">{batches.map(batch=><div className="flex flex-wrap justify-between gap-3 py-3 text-sm" key={batch.id}>
    <div><strong>{money(Number(batch.amount_lyd))} {tr("LYD","د.ل")}</strong><p className="mt-1 text-xs text-slate-500">{batch.payout_date} · {batch.payment_reference}</p></div>
    <div className="text-end text-xs text-slate-600">
     <p>{tr("Goal credit","المحتسب نحو الهدف")}: {fmtUsd(Number(batch.credited_usd))}</p>
     <p className="mt-1">{tr("Payment-day rate","سعر صرف يوم الدفع")}: {Number(batch.lyd_per_usd).toFixed(3)} {tr("LYD/USD","د.ل/دولار")}</p>
     <p className="mt-1">{tr("Months covered","الأشهر المشمولة")}: {allocations.filter(a=>a.payout_id===batch.id).map(a=>a.month_start.slice(0,7)).join(", ")||"—"}</p>
    </div>
   </div>)}</div>
  </details>:<p role="status" className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
   {ledger.totalPaidLyd===0?
    tr("No profit payments have been made or recorded yet.","لم تُدفع أو تُسجل أي توزيعات أرباح حتى الآن."):
    tr("No recent LYD payout receipts. Earlier payments remain reflected in confirmed balances.","لا توجد إيصالات دفعات دينار حديثة؛ وتبقى الدفعات السابقة ضمن الأرصدة المعتمدة.")}
  </p>}

   </>}
 </section>;
}
