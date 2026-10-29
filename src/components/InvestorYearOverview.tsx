import { randomUUID } from "node:crypto";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { InvestorLydBatchForm, type PayableInvestorMonth } from "@/components/InvestorLydBatchForm";

type Props={agreementId:string;investorUserId:string;investorName?:string;sharePercent?:number|string;startDate?:string;endDate?:string|null;investmentUsd?:number|string|null;capUsd?:number|string|null;ar:boolean;admin?:boolean};
type Historic={month_start:string;net_profit_lyd:number|string|null;exchange_rate_lyd_per_usd:number|string;confirmed_payable_usd:number|string|null;confirmed_paid_usd:number|string|null;payment_confirmed_at:string|null};
type Statement={month_start:string;operating_profit_lyd:number|string;investor_share_due_lyd:number|string;calculation_status:string};
type Batch={id:string;amount_lyd:number|string;credited_usd:number|string;lyd_per_usd:number|string;payout_date:string;payment_reference:string};
type Allocation={payout_id:string;month_start:string;amount_lyd:number|string};
type Legacy={month_start:string;amount_usd:number|string;lyd_equivalent:number|string};
const n=(value:unknown)=>Number(value??0);
const round=(value:number)=>Math.round(value*100)/100;
const fmt=(v:number)=>new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const lyd=(v:number)=>fmt(v)+" LYD",usd=(v:number)=>"$"+fmt(v);
const nameMonth=(m:string,ar:boolean)=>new Intl.DateTimeFormat(ar?"ar-LY":"en-US",{year:"numeric",month:"long",timeZone:"UTC"}).format(new Date(m+"T12:00:00Z"));
const today=()=>{const p=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());return ["year","month","day"].map(k=>p.find(x=>x.type===k)?.value).join("-");};

export async function InvestorYearOverview({agreementId,investorUserId,investorName,sharePercent,startDate="2026-01-01",endDate,capUsd,ar,admin=false}:Props){
 if(capUsd==null)return null;
 const tr=(en:string,arabic:string)=>ar?arabic:en,db=await getAuthenticatedSupabaseServerClient();
 const unavailable=()=> <p role="alert" className="surface-card text-rose-800">{tr("Investor data unavailable. No zero balances have been assumed.","بيانات المستثمر غير متاحة. لم نفترض أن الأرصدة صفر.")}</p>;
 if(!db)return unavailable();
 const [hr,sr,br,arows,ur]=await Promise.all([
  db.from("investor_historical_months").select("month_start,net_profit_lyd,exchange_rate_lyd_per_usd,confirmed_payable_usd,confirmed_paid_usd,payment_confirmed_at").eq("investor_user_id",investorUserId).gte("month_start",startDate),
  (admin?db.from("investor_monthly_statements").select("month_start,operating_profit_lyd,investor_share_due_lyd,calculation_status"):db.from("investor_monthly_statements").select("month_start,operating_profit_lyd,investor_share_due_lyd,calculation_status").eq("calculation_status","finalized")).eq("agreement_id",agreementId).gte("month_start",startDate),
  db.from("investor_lyd_payout_batches").select("id,amount_lyd,credited_usd,lyd_per_usd,payout_date,payment_reference").eq("agreement_id",agreementId).order("payout_date",{ascending:false}),
  db.from("investor_lyd_payout_allocations").select("payout_id,month_start,amount_lyd").eq("agreement_id",agreementId),
  db.from("investor_usd_payouts").select("month_start,amount_usd,lyd_equivalent").eq("agreement_id",agreementId),
 ]);
 if(hr.error||sr.error||br.error||arows.error||ur.error)return unavailable();
 const history=(hr.data??[]) as Historic[],statements=(sr.data??[]) as Statement[],batches=(br.data??[]) as Batch[],allocations=(arows.data??[]) as Allocation[],legacy=(ur.data??[]) as Legacy[];
 const hmap=new Map(history.filter(h=>!endDate||h.month_start<=endDate).map(h=>[h.month_start,h]));
 const smap=new Map(statements.filter(s=>!endDate||s.month_start<=endDate).map(s=>[s.month_start,s]));
 const periods=[...new Set([...hmap.keys(),...smap.keys()])].sort().reverse();
 const overlap=periods.some(m=>hmap.has(m)&&smap.has(m));
 const unknownHistory=history.some(h=>!h.payment_confirmed_at||h.confirmed_payable_usd==null||h.confirmed_paid_usd==null);
 const newPaid=new Map<string,number>(),oldPaid=new Map<string,number>();
 for(const a of allocations)newPaid.set(a.month_start,(newPaid.get(a.month_start)??0)+n(a.amount_lyd));
 for(const a of legacy)oldPaid.set(a.month_start,(oldPaid.get(a.month_start)??0)+n(a.lyd_equivalent));
 const payable:PayableInvestorMonth[]=[];
 const monthly=periods.map(month=>{
  const h=hmap.get(month),s=smap.get(month),verified=h?Boolean(h.payment_confirmed_at&&h.confirmed_payable_usd!=null&&h.confirmed_paid_usd!=null):s?.calculation_status==="finalized";
  const due=verified?(h?round(n(h.confirmed_payable_usd)*n(h.exchange_rate_lyd_per_usd)):n(s?.investor_share_due_lyd)):0;
  const paid=verified?round((newPaid.get(month)??0)+(h?round(n(h.confirmed_paid_usd)*n(h.exchange_rate_lyd_per_usd)):(oldPaid.get(month)??0))):0;
  const remaining=Math.max(0,round(due-paid));
  if(verified&&remaining>0.005&&!overlap)payable.push({month_start:month,due_lyd:due,paid_lyd:paid,remaining_lyd:remaining});
  return {month,h,s,verified,due,paid,remaining};
 });
 const earned=round(monthly.reduce((v,m)=>v+m.due,0)),paid=round(monthly.reduce((v,m)=>v+m.paid,0));
 const historicPaidUsd=round(history.filter(h=>h.payment_confirmed_at).reduce((v,h)=>v+n(h.confirmed_paid_usd),0));
 const legacyCurrentUsd=round(legacy.filter(row=>!hmap.has(row.month_start)).reduce((v,row)=>v+n(row.amount_usd),0));
 const usdCredited=round(historicPaidUsd+legacyCurrentUsd+batches.reduce((v,b)=>v+n(b.credited_usd),0));
 const cap=n(capUsd),capLeft=Math.max(0,round(cap-usdCredited));
 const status=(m:typeof monthly[number])=>!m.verified?(m.s?tr("Draft · not payable","مسودة · غير مستحقة"):tr("Not verified","غير معتمد")):m.due<=0?tr("No payout due","لا يوجد مستحق"):m.paid>=m.due-.005?tr("Paid","مدفوع"):m.paid>0?tr("Partially paid","مدفوع جزئياً"):tr("Unpaid","غير مدفوع");
 return <section className="surface-card space-y-5" dir={ar?"rtl":"ltr"}>
  <div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{tr("Investor profit & payments","أرباح ودفعات المستثمر")}</p>
   <h2 className="mt-1 text-xl font-bold">{investorName||tr("Investor statement","كشف المستثمر")}</h2>
   <p className="mt-1 text-sm text-slate-600">{tr("Profit and real payments are in LYD. Only real payments count toward the USD contractual goal.","الأرباح والدفعات الفعلية بالدينار. فقط الدفعات الفعلية تُحتسب نحو الهدف التعاقدي بالدولار.")}</p>
   {sharePercent!=null?<p className="mt-2 text-sm font-semibold">{tr("Agreed share","النسبة المتفق عليها")}: {sharePercent}%</p>:null}</div>
  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
   [tr("Approved LYD profit","أرباح معتمدة بالدينار"),lyd(earned)],
   [tr("Actually paid LYD","المدفوع الفعلي بالدينار"),lyd(paid)],
   [tr("Unpaid LYD profit","أرباح غير مدفوعة بالدينار"),lyd(Math.max(0,round(earned-paid)))],
   [tr("Paid progress toward USD goal","قيمة المدفوع نحو هدف الدولار"),usd(usdCredited)+" / "+usd(cap)]
  ].map(([label,value])=><div key={label} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs text-slate-600">{label}</p><strong className="mt-2 block text-xl tabular-nums">{value}</strong></div>)}</div>
  <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3 text-sm"><span>{tr("Contract goal reached from actual payments","التقدم نحو الهدف من الدفعات الفعلية")}</span><strong>{cap>0?(100*usdCredited/cap).toFixed(1):"0.0"}%</strong></div>
   <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-700" style={{width:(cap>0?Math.min(100,100*usdCredited/cap):0)+"%"}}/></div>
   <p className="mt-2 text-xs text-slate-600">{tr("USD goal remaining","المتبقي من الهدف بالدولار")}: {usd(capLeft)}. {tr("A payment's exchange rate is frozen at recording and never changes historical LYD shares.","سعر صرف كل دفعة يُثبت عند تسجيلها ولا يغير حصص الأشهر بالدينار.")}</p></div>
  {overlap||unknownHistory||paid>earned+.005?<p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{tr("Historical months or payment totals require reconciliation before further payouts.","الأشهر التاريخية أو إجمالي الدفعات تحتاج مراجعة قبل تسجيل دفعات جديدة.")}</p>:null}
  {admin&&payable.length>0&&capLeft>0&&!overlap&&!unknownHistory?<InvestorLydBatchForm agreementId={agreementId} submissionId={randomUUID()} months={[...payable].reverse()} remainingGoalUsd={capLeft} today={today()} ar={ar}/>:null}
  <div><h3 className="font-semibold">{tr("Monthly profit shares · LYD","حصص الأرباح الشهرية · بالدينار")}</h3><p className="mt-1 text-xs text-slate-600">{tr("Monthly profit never has a payment exchange rate. Drafts are not payable.","لا يوجد سعر صرف للدفع على أرباح الأشهر. المسودات ليست مستحقة.")}</p></div>
  <div className="space-y-2">{monthly.map(m=><details key={m.month} className="rounded-xl border border-slate-200 p-4"><summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3"><span className="font-semibold">{nameMonth(m.month,ar)}</span><span className="text-sm text-slate-600">{status(m)} · <strong>{m.verified?lyd(m.due):"—"}</strong></span></summary>
   <div className="mt-4 grid gap-2 sm:grid-cols-3">{[[tr("Profit share","الحصة"),m.verified?lyd(m.due):"—"],[tr("Actually paid","المدفوع"),m.verified?lyd(m.paid):"—"],[tr("Remaining","المتبقي"),m.verified?lyd(m.remaining):"—"]].map(([label,val])=><div className="rounded-lg bg-slate-50 p-3" key={label}><p className="text-xs text-slate-600">{label}</p><strong className="mt-1 block tabular-nums">{val}</strong></div>)}</div>
   {m.s?<p className="mt-3 text-xs text-slate-600">{tr("Net operating result","صافي نتيجة التشغيل")}: {lyd(n(m.s.operating_profit_lyd))}</p>:m.h?<p className="mt-3 text-xs text-slate-600">{tr("Imported history: original confirmed share converted using the archived historical rate. Future payments do not change this LYD share.","سجل تاريخي: حُسبت الحصة المؤكدة بسعر المصدر التاريخي المحفوظ. لا تغير الدفعات المستقبلية حصة الدينار.")}</p>:null}
  </details>)}{!monthly.length?<p className="text-sm text-slate-600">{tr("No finalized months yet.","لا توجد أشهر معتمدة بعد.")}</p>:null}</div>
  <div className="space-y-3"><h3 className="font-semibold">{tr("Actual payments","الدفعات الفعلية")}</h3>
   {batches.map(b=><div key={b.id} className="rounded-xl border border-slate-200 p-4 text-sm"><div className="flex flex-wrap justify-between gap-3"><strong>{lyd(n(b.amount_lyd))}</strong><span>{tr("Goal credit","المحتسب نحو الهدف")}: {usd(n(b.credited_usd))}</span></div>
    <p className="mt-2 text-xs text-slate-600">{b.payout_date} · {b.payment_reference} · 1 USD = {n(b.lyd_per_usd).toFixed(3)} LYD</p>
    <p className="mt-1 text-xs text-slate-600">{tr("Months paid","الأشهر المدفوعة")}: {allocations.filter(a=>a.payout_id===b.id).map(a=>a.month_start.slice(0,7)).join(", ")}</p></div>)}
   {!batches.length&&legacy.length===0&&historicPaidUsd===0?<p className="rounded-lg border border-slate-200 p-4 text-sm">{tr("No payments recorded. 0.00 LYD paid and $0.00 credited to the goal.","لا توجد دفعات مسجلة. المدفوع 0.00 د.ل والمحتسب نحو الهدف $0.00.")}</p>:null}
  </div>
 </section>;
}
