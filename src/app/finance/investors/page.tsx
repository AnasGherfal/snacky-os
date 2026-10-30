/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import { InvestorYearOverview } from "@/components/InvestorYearOverview";
import { InvestorAdminTabs } from "@/components/InvestorAdminTabs";
import { InvestorAdminReview } from "@/components/InvestorAdminReview";
import { InvestorAdminAgreement, InvestorCreateAgreement } from "@/components/InvestorAdminAgreement";
import { InvestorStatementCard, type InvestorStatementRecord } from "@/components/InvestorStatementCard";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { formatFinanceMoney } from "@/lib/finance-balance";
import { getServerI18n } from "@/lib/i18n/server";
import type { InvestorFundingReceipt } from "@/components/InvestorMoneyForm";

export const dynamic = "force-dynamic";

async function readAll(build:(from:number,to:number)=>any):Promise<any[]>{
 const results:any[]=[];
 for(let from=0;from<50000;from+=500){
  const response=await build(from,from+499);
  if(response.error)throw response.error;
  const rows=response.data??[];results.push(...rows);
  if(rows.length<500)return results;
 }
 throw new Error("Investor records exceeded verified pagination limit");
}
function lastCompletedMonth(){
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit"}).formatToParts(new Date());
 const year=Number(parts.find(p=>p.type==="year")?.value),month=Number(parts.find(p=>p.type==="month")?.value);
 return new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
}
const monthPattern=/^\d{4}-(0[1-9]|1[0-2])$/;
const sum=(arr:any[],key:string)=>arr.reduce((value,row)=>value+Number(row[key]??0),0);

export default async function InvestorsPage({searchParams}:{searchParams:Promise<{
 agreement?:string;month?:string;tab?:string;success?:string;warning?:string;error?:string
}>}){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
 const db=await getAuthenticatedSupabaseServerClient();
 const {locale}=await getServerI18n(),ar=locale==="ar",params=await searchParams;
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const unavailable=()=> <ErrorState title={tr("Investor records unavailable","تعذر عرض المستثمرين")}
  body={tr("Could not securely verify the investor records. Reload and check the connection.","تعذر التحقق من سجلات المستثمرين. أعد التحميل وتحقق من الاتصال.")}/>;
 if(!db)return unavailable();

 let agreements:any[],profiles:any[];
 try {
  [agreements,profiles]=await Promise.all([
   readAll((from,to)=>db.from("investor_agreements").select("*")
    .order("start_date",{ascending:false}).order("id").range(from,to)),
   readAll((from,to)=>db.from("profiles")
    .select("id,full_name,email,role,roles,active_status")
    .eq("active_status","active").order("id").range(from,to)),
  ]);
 }catch(error){console.error("[investor-admin] Agreements unavailable",error);return unavailable();}
 const selected=agreements.find(a=>a.id===params.agreement)??agreements[0]??null;
 const investorProfiles=profiles.filter(p=>p.role==="investor"||(p.roles??[]).includes("investor"));
 let statements:InvestorStatementRecord[]=[],payments:any[]=[],contributions:any[]=[];
 let receipts:InvestorFundingReceipt[]=[],receiptLookupError=false;
 if(selected){
  try {
   [statements,payments,contributions]=await Promise.all([
    readAll((from,to)=>db.from("investor_monthly_statements").select("*").eq("agreement_id",selected.id)
     .order("month_start",{ascending:false}).order("id").range(from,to)),
    readAll((from,to)=>db.from("investor_payments").select("*").eq("agreement_id",selected.id)
     .order("payment_date",{ascending:false}).order("id").range(from,to)),
    readAll((from,to)=>db.from("investor_contributions").select("*").eq("agreement_id",selected.id)
     .order("received_date",{ascending:false}).order("id").range(from,to)),
   ]);
   const received=await db.from("financial_transactions")
    .select("id,transaction_date,description,amount,currency,account_id,exchange_rate_usd_to_lyd")
    .eq("direction","money_in").eq("transaction_status","active")
    .eq("transaction_effect","income").in("transaction_kind",["manual_money_in","spreadsheet_import"])
    .in("review_status",["confirmed","reviewed"])
    .or("is_void.eq.false,is_void.is.null").is("voided_at",null)
    .order("transaction_date",{ascending:false}).order("id").limit(200);
   receiptLookupError=Boolean(received.error);
   const linked=new Set(contributions.map(item=>item.finance_transaction_id));
   receipts=((received.data??[]) as InvestorFundingReceipt[]).filter(row=>!linked.has(row.id));
  }catch(error){console.error("[investor-admin] History unavailable",error);return unavailable();}
 }
 const finalized=statements.filter(s=>s.calculation_status==="finalized");
 const posted=payments.filter(p=>p.finance_posting_status==="posted"&&p.finance_transaction_id);
 const locked=finalized.length>0,capitalReceived=sum(contributions,"amount_lyd");
 const notice=params.error??params.warning??params.success;
 const alertStyle=params.error?"border-rose-200 bg-rose-50 text-rose-800":
  params.warning?"border-amber-200 bg-amber-50 text-amber-800":
  "border-emerald-200 bg-emerald-50 text-emerald-800";

 // Review exactly one month at a time; the normal investor overview already
 // includes every month's profit without opening separate cards.
 const previous=lastCompletedMonth();
 const availableMonths=[...new Set([
  ...statements.map(s=>s.month_start.slice(0,7)),
  previous,
 ])].filter(month=>monthPattern.test(month)&&month<=previous &&
   (!selected||month>=selected.start_date.slice(0,7)) &&
   (!selected?.end_date||month<=selected.end_date.slice(0,7))).sort();
 const firstOpen=statements.filter(s=>s.calculation_status!=="finalized")
  .sort((a,b)=>a.month_start.localeCompare(b.month_start))[0]?.month_start.slice(0,7);
 const reviewMonth=params.month&&availableMonths.includes(params.month)?params.month:
  firstOpen&&availableMonths.includes(firstOpen)?firstOpen:
  availableMonths.at(-1)??previous;
 const reviewedStatement=statements.find(s=>s.month_start.slice(0,7)===reviewMonth)??null;
 const initialTab=params.tab==="payment"?"payment":params.tab==="manage"?"manage":"review";
 const reviewPanel=selected?<InvestorAdminReview
  ar={ar} agreementId={selected.id} month={reviewMonth} availableMonths={availableMonths}
  statement={reviewedStatement} canReview={Boolean(selected.profit_basis_confirmed&&selected.status==="active")}
 />:null;
 const agreementPanel=<InvestorAdminAgreement
  ar={ar} selected={selected} locked={locked} capitalReceived={capitalReceived}
  contributions={contributions} receipts={receipts} receiptLookupError={receiptLookupError}
  investorProfiles={investorProfiles} profileId={profile.id}/>;

 return <>
  <PageHeader title={tr("Investors","المستثمرون")}
   subtitle={tr("Monthly profit, payments and agreements — in one place.",
    "الأرباح الشهرية والدفعات والاتفاقات في مكان واحد.")}/>
  <div className="space-y-4">
   {notice?<div role={params.error?"alert":"status"} className={`rounded-lg border px-4 py-3 text-sm ${alertStyle}`}>
    {notice}
   </div>:null}
   {agreements.length>1?<nav aria-label={tr("Select investor","اختر المستثمر")} className="flex flex-wrap gap-2">
    {agreements.map(a=><Link key={a.id} href={`/finance/investors?agreement=${a.id}`}
     className={selected?.id===a.id?"btn-primary":"btn-secondary"}>{a.investor_name}</Link>)}
   </nav>:null}
   {selected ? selected.payout_cap_usd!=null ?
    <InvestorYearOverview
     agreementId={selected.id} investorUserId={selected.investor_user_id}
     investorName={selected.investor_name} sharePercent={selected.profit_share_percent}
     startDate={selected.start_date} endDate={selected.end_date}
     investmentUsd={selected.investment_amount_usd} capUsd={selected.payout_cap_usd}
     ar={ar} admin initialAdminTab={initialTab}
     reviewPanel={reviewPanel} managePanel={agreementPanel}
    /> :
    <>
     <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-2">
       <div><h2 className="text-xl font-bold text-slate-950">{selected.investor_name}</h2>
        <p className="mt-1 text-sm text-slate-500">{selected.profit_share_percent}% · {selected.start_date}</p>
       </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-100 pt-4">
       {[
        [tr("Approved share","المستحق المعتمد"),sum(finalized,"investor_share_due_lyd")],
        [tr("Paid","المدفوع"),sum(posted,"amount_lyd")],
        [tr("Remaining","المتبقي"),Math.max(0,sum(finalized,"investor_share_due_lyd")-sum(posted,"amount_lyd"))],
       ].map(([label,value])=><div key={String(label)}>
        <p className="text-xs text-slate-500">{label}</p>
        <strong className="mt-1 block text-lg font-bold tabular-nums">{formatFinanceMoney(Number(value))}</strong>
        <span className="text-xs text-slate-500">LYD</span>
       </div>)}
      </div>
     </section>
     <InvestorAdminTabs ar={ar} initialTab={initialTab} review={reviewPanel}
      manage={agreementPanel} payment={<div className="space-y-4">
       <h3 className="text-lg font-bold">{tr("Recorded payouts","توزيعات الأرباح")}</h3>
       {finalized.length?finalized.map(s=><InvestorStatementCard key={s.id} statement={s}
        ar={ar} adminUserId={profile.id}
        paid={posted.filter(p=>p.statement_id===s.id).reduce((total,p)=>total+Number(p.amount_lyd),0)}/>):
        <p className="text-sm text-slate-600">{tr("Approve a month before recording a payout.","اعتمد الشهر قبل تسجيل توزيعات الأرباح.")}</p>}
      </div>}/>
    </>
    : <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
     <InvestorCreateAgreement ar={ar} investorProfiles={investorProfiles}/>
    </section>}
   {!selected?<EmptyState title={tr("No investors yet","لا يوجد مستثمرون بعد")}
    body={tr("Create an agreement to begin tracking monthly profit and payments.",
     "أنشئ اتفاقاً للبدء في متابعة الأرباح الشهرية والدفعات.")}/>:null}
  </div>
 </>;
}
