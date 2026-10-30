/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { InvestorLydBatchForm } from "@/components/InvestorLydBatchForm";
import { InvestorMonthlyTable } from "@/components/InvestorMonthlyTable";
import {
 buildInvestorMonthlyLedger,
 type InvestorHistoricLedgerMonth, type InvestorGeneratedLedgerMonth,
 type InvestorLydBatch, type InvestorLydAllocation, type InvestorUsdLegacyPayout
} from "@/lib/investor-monthly-ledger";

type Props={
 agreementId:string;investorUserId:string;investorName?:string;sharePercent?:number|string;
 startDate?:string;endDate?:string|null;investmentUsd?:number|string|null;
 capUsd?:number|string|null;ar:boolean;admin?:boolean
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
 startDate="2026-01-01",endDate,capUsd,ar,admin=false}:Props){
 if(capUsd==null)return null;
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const db=await getAuthenticatedSupabaseServerClient();
 const unavailable=()=> <div role="alert" className="surface-card border-rose-200 bg-rose-50 text-sm text-rose-900">
  {tr("Investor data could not be verified. The monthly balances are not assumed to be zero. Reload or contact Snacky management.",
      "تعذر التحقق من بيانات المستثمر. لا نفترض أن الأرصدة الشهرية صفر. أعد التحميل أو تواصل مع إدارة سناكي.")}
 </div>;
 if(!db)return unavailable();
 let historical:InvestorHistoricLedgerMonth[],generated:InvestorGeneratedLedgerMonth[];
 let batches:InvestorLydBatch[],allocations:InvestorLydAllocation[],legacyUsdPayouts:InvestorUsdLegacyPayout[];
 try{
  const [h,g,b,a,u,pending]=await Promise.all([
   allRows((from,to)=>db.from("investor_historical_months")
    .select("month_start,net_profit_lyd,exchange_rate_lyd_per_usd,confirmed_payable_usd,confirmed_paid_usd,payment_confirmed_at")
    .eq("investor_user_id",investorUserId).gte("month_start",startDate).order("month_start").order("id").range(from,to)),
   allRows((from,to)=>{
    let q=db.from("investor_monthly_statements")
     .select("month_start,operating_profit_lyd,investor_share_due_lyd,calculation_status")
     .eq("agreement_id",agreementId).gte("month_start",startDate).order("month_start").order("id").range(from,to);
    if(!admin)q=q.eq("calculation_status","finalized");
    return q;
   }),
   allRows((from,to)=>db.from("investor_lyd_payout_batches")
    .select("id,amount_lyd,credited_usd,lyd_per_usd,payout_date,payment_reference")
    .eq("agreement_id",agreementId).order("payout_date",{ascending:false}).order("id").range(from,to)),
   allRows((from,to)=>db.from("investor_lyd_payout_allocations")
    .select("payout_id,month_start,amount_lyd").eq("agreement_id",agreementId).order("month_start").order("id").range(from,to)),
   allRows((from,to)=>db.from("investor_usd_payouts")
    .select("month_start,amount_usd,lyd_equivalent").eq("agreement_id",agreementId).order("month_start").order("id").range(from,to)),
   admin?Promise.resolve([]):allRows((from,to)=>db.from("investor_monthly_statements")
    .select("month_start,calculation_status").eq("agreement_id",agreementId)
    .neq("calculation_status","finalized").gte("month_start",startDate).order("month_start").order("id").range(from,to))
  ]);
  historical=h as InvestorHistoricLedgerMonth[];
  generated=g as InvestorGeneratedLedgerMonth[];
  batches=b as InvestorLydBatch[];allocations=a as InvestorLydAllocation[];
  legacyUsdPayouts=u as InvestorUsdLegacyPayout[];
  // An investor may see that an unapproved month exists, but never the draft's numbers.
  if(!admin)generated.push(...(pending as Array<{month_start:string;calculation_status:string}>).map(row=>({
   ...row,operating_profit_lyd:null,investor_share_due_lyd:null
  })));
 }catch(error){console.error("[investor] Monthly ledger failed to load",error);return unavailable();}
 const ledger=buildInvestorMonthlyLedger({startDate,endDate,capUsd,historical,generated,batches,allocations,legacyUsdPayouts});
 const fmtUsd=(v:number)=>"$"+money(v);
 return <section className="space-y-4" aria-label={tr("Investor financial statement","الكشف المالي للمستثمر")}>
  <InvestorMonthlyTable ledger={ledger} investorName={investorName||tr("Investor","المستثمر")} sharePercent={sharePercent??null} ar={ar}/>
  {admin&&!ledger.needsReview&&ledger.payableMonths.length>0&&ledger.remainingGoalUsd>0?
   <div id="investor-record-payment"><InvestorLydBatchForm agreementId={agreementId} submissionId={randomUUID()}
    months={ledger.payableMonths} remainingGoalUsd={ledger.remainingGoalUsd} today={tripoliToday()} ar={ar}/></div>:null}
  {admin&&ledger.remainingGoalUsd<=0?<div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
   {tr("The contractual payout ceiling has been reached. No more investor payouts may be recorded.",
       "تم بلوغ سقف التوزيعات المتفق عليه؛ لا يمكن تسجيل توزيعات إضافية.")}
  </div>:null}
  {admin&&!ledger.needsReview&&ledger.remainingGoalUsd>0&&ledger.payableMonths.length===0?
   <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
    {tr("To record a payment, first review and finalize the applicable month's LYD share.",
        "لتسجيل دفعة، يجب مراجعة حصة الشهر بالدينار واعتمادها أولاً.")}
   </p>:null}
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
 </section>;
}
