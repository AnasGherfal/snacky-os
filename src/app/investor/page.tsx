/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from "next/navigation";
import { ChartCard, TrendChart } from "@/components/DecisionCharts";
import { InvestorStatementCard, type InvestorStatementRecord } from "@/components/InvestorStatementCard";
import { EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasPermission, isOwnerAdminRole } from "@/lib/authz";
import { formatFinanceMoney } from "@/lib/finance-balance";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
async function readAll(build:(from:number,to:number)=>any):Promise<any[]> {
 const rows:any[]=[];
 for(let from=0;from<50000;from+=500){const result=await build(from,from+499);if(result.error)throw result.error;rows.push(...(result.data??[]));if((result.data??[]).length<500)return rows;}
 throw new Error('Investor records exceeded the safe reading limit.');
}
export default async function InvestorPortalPage({searchParams}:{searchParams:Promise<{agreement?:string}>}) {
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasPermission(profile,'investor.view'))redirect('/unauthorized');
 const db=await getAuthenticatedSupabaseServerClient(),{locale}=await getServerI18n(),ar=locale==='ar',params=await searchParams;
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const unavailable=()=> <ErrorState title={tr('Investor portal unavailable','بوابة المستثمر غير متاحة')} body={tr('Your records could not be verified. No zero capital, profit, payment or balance has been assumed. Please reload.','تعذر التحقق من سجلاتك. لم تُفترض قيم صفرية لرأس المال أو الأرباح أو الدفعات أو الرصيد. أعد التحميل.')} />;
 if(!db)return unavailable();
 let agreements:any[];
 try {agreements=await readAll((from,to)=>{let q=db.from('investor_agreements').select('*').order('start_date',{ascending:false}).order('id').range(from,to);if(!isOwnerAdminRole(profile))q=q.eq('investor_user_id',profile.id);return q;});}
 catch(error){console.error('[investor] Agreement load failed',error);return unavailable();}
 const selected=agreements.find(a=>a.id===params.agreement)??agreements[0]??null;
 if(!selected)return <EmptyState title={tr('No agreement linked yet','لم تُربط اتفاقية بعد')} body={tr('Your investor login is ready. Snacky management must enter and link your actual capital and profit-sharing agreement before monthly statements can appear.','حساب المستثمر جاهز. يجب أن تسجّل إدارة سناكي اتفاق رأس المال وتقاسم الأرباح وتربطه بحسابك حتى تظهر البيانات الشهرية.')} />;
 let statements:InvestorStatementRecord[],payments:any[],contributions:any[];
 try {
  [statements,payments,contributions]=await Promise.all([
   readAll((from,to)=>db.from('investor_monthly_statements').select('*').eq('agreement_id',selected.id).eq('calculation_status','finalized').order('month_start',{ascending:false}).order('id').range(from,to)),
   readAll((from,to)=>db.from('investor_payments').select('id,agreement_id,statement_id,payment_date,amount_lyd,payment_reference,finance_transaction_id,finance_posting_status').eq('agreement_id',selected.id).order('payment_date',{ascending:false}).order('id').range(from,to)),
   readAll((from,to)=>db.from('investor_contributions').select('id,agreement_id,received_date,original_amount,currency,exchange_rate_lyd,amount_lyd,reference').eq('agreement_id',selected.id).order('received_date',{ascending:false}).order('id').range(from,to)),
  ]);
 }catch(error){console.error('[investor] History load failed',error);return unavailable();}
 const posted=payments.filter(p=>p.finance_posting_status==='posted'&&p.finance_transaction_id);
 const paidByMonth=new Map<string,number>();posted.forEach(p=>paidByMonth.set(p.statement_id,(paidByMonth.get(p.statement_id)??0)+Number(p.amount_lyd)));
 const totalDue=statements.reduce((sum,s)=>sum+Number(s.investor_share_due_lyd),0),totalPaid=posted.reduce((sum,p)=>sum+Number(p.amount_lyd),0),received=contributions.reduce((sum,c)=>sum+Number(c.amount_lyd),0);
 const chart=[...statements].reverse();
 return <>
  <PageHeader title={tr('Investor Portal','بوابة المستثمر')} subtitle={tr('Read-only: your agreement, recorded capital, finalized monthly statements and payouts.','عرض فقط: اتفاقيتك ورأس المال المسجّل والبيانات الشهرية المعتمدة والدفعات.')} />
  <div className="space-y-5">
   {agreements.length>1?<nav aria-label={tr('Your agreements','اتفاقياتك')} className="flex flex-wrap gap-2">{agreements.map(a=><a href={`/investor?agreement=${a.id}`} key={a.id} className={a.id===selected.id?'btn-primary':'btn-secondary'}>{a.investor_name} · {a.start_date}</a>)}</nav>:null}
   <section className="surface-card"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold">{selected.investor_name}</h2><p className="mt-2 text-sm text-slate-600">{selected.start_date}{selected.end_date?` — ${selected.end_date}`:''}</p></div><div className="text-end"><strong className="text-3xl">{selected.profit_share_percent}%</strong><div className="mt-2"><StatusBadge status={selected.status}/></div></div></div>
    <p className="mt-4 text-sm text-slate-600">{selected.profit_basis==='operating_profit_after_capex'?tr('Your agreed share is calculated after product costs, recorded operating expenses and recorded machine purchases. New machine spending is itemized separately in every approved month.','تُحسب حصتك بعد تكلفة المنتجات والمصاريف التشغيلية ومشتريات الماكينات المسجّلة. تظهر مشتريات الماكينات منفصلة في كل شهر معتمد.'):tr('Your agreed share is calculated from positive operating profit after product costs and recorded operating expenses. New machine purchases are shown separately, not automatically deducted in full.','تُحسب حصتك من الربح التشغيلي الموجب بعد تكلفة المنتجات والمصاريف التشغيلية المسجّلة. تظهر الماكينات الجديدة منفصلة ولا يُخصم كامل ثمنها تلقائياً.')}</p>
    <p className="mt-2 text-xs text-slate-500">{tr('Capital contributions are not sales. Profit payouts are not operating expenses. Capital repayment is not assumed to be part of your profit share.','رأس المال ليس مبيعات، وتوزيعات الأرباح ليست مصاريف تشغيلية. لا يُفترض أن حصة الربح تشمل ردّ رأس المال.')}</p>
   </section>
   {payments.length!==posted.length?<p role="alert" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-950">{tr('A payout needs Finance verification. It is not included in settled payouts until Snacky management resolves it.','توجد دفعة تحتاج تحققاً مالياً. لا تدخل في الدفعات المسوّاة حتى تعالجها إدارة سناكي.')}</p>:null}
   <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[[tr('Agreed capital','رأس المال المتفق عليه'),selected.investment_amount_lyd],[tr('Capital received on record','رأس المال المسجّل استلامه'),received],[tr('Finalized entitlement','المستحق المعتمد'),totalDue],[tr('Posted payouts','الدفعات المرحلة'),totalPaid],[tr('Unpaid balance','الرصيد غير المدفوع'),Math.max(0,totalDue-totalPaid)]].map(([label,value])=><div className="surface-card" key={String(label)}><div className="text-xs text-slate-600">{String(label)}</div><strong className="mt-2 block text-xl">{formatFinanceMoney(Number(value))}</strong></div>)}</div>
   <ChartCard title={tr('Monthly profit, entitlement and payouts','الربح والمستحق والمدفوع شهرياً')} subtitle={tr('Each point is a month finalized by Snacky management. Draft estimates are not entitlements.','كل نقطة تمثل شهراً معتمداً من إدارة سناكي. تقديرات المسودات ليست مستحقات.')}><TrendChart labels={chart.map(s=>s.month_start.slice(0,7))} series={[{key:'profit',label:tr('Operating profit','الربح التشغيلي'),values:chart.map(s=>Number(s.operating_profit_lyd))},{key:'due',label:tr('Due','المستحق'),values:chart.map(s=>Number(s.investor_share_due_lyd))},{key:'paid',label:tr('Paid','المدفوع'),values:chart.map(s=>paidByMonth.get(s.id)??0)}]} valueFormatter={value=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(value)}/></ChartCard>
   <section className="space-y-3"><h2 className="font-semibold">{tr('Finalized monthly statements','البيانات الشهرية المعتمدة')}</h2>{statements.map(s=><InvestorStatementCard key={s.id} statement={s} paid={paidByMonth.get(s.id)??0} ar={ar}/>)}{!statements.length?<p className="surface-card text-sm text-slate-600">{tr('No month has been finalized yet.','لم يتم اعتماد شهر بعد.')}</p>:null}</section>
   <section className="surface-card"><h2 className="font-semibold">{tr('Capital receipt history','سجل استلام رأس المال')}</h2>{contributions.map(c=><div key={c.id} className="mt-3 flex flex-wrap justify-between gap-3 border-t border-slate-100 pt-3 text-sm"><span>{c.received_date} · {Number(c.original_amount).toFixed(2)} {c.currency}</span><span>{tr('LYD value','القيمة بالدينار')}: {formatFinanceMoney(Number(c.amount_lyd))}</span></div>)}{!contributions.length?<p className="mt-3 text-sm text-slate-600">{tr('No capital receipt has been linked yet. This is different from the agreed investment amount.','لم يتم ربط حركة استلام رأس مال بعد. هذه تختلف عن قيمة الاستثمار المتفق عليها.')}</p>:null}</section>
   <section className="surface-card"><h2 className="font-semibold">{tr('Payment history','سجل الدفعات')}</h2>{payments.map(p=><div className="mt-3 flex flex-wrap justify-between gap-3 border-t border-slate-100 pt-3 text-sm" key={p.id}><span>{p.payment_date} · {formatFinanceMoney(Number(p.amount_lyd))}</span><span>{statements.find(s=>s.id===p.statement_id)?.month_start.slice(0,7)??tr('Allocation pending','بانتظار التخصيص')} · {p.payment_reference??'—'}</span><StatusBadge status={p.finance_posting_status}/></div>)}{!payments.length?<p className="mt-3 text-sm text-slate-600">{tr('No payouts recorded.','لا توجد دفعات مسجّلة.')}</p>:null}</section>
  </div>
 </>;
}
