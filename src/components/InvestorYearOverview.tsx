/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import { getAuthenticatedSupabaseServerClient } from '@/lib/auth';
import { recordActualInvestorUsdPayout, saveInvestorMonthlyFxRate } from '@/lib/investor-portal-actions';

const money=(value:number)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value)+' LYD';
const dollars=(value:number)=>'$'+new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const n=(value:unknown)=>value==null?0:Number(value);
const monthName=(value:string,ar:boolean)=>new Intl.DateTimeFormat(ar?'ar-LY':'en-US',{year:'numeric',month:'long',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
type Props={agreementId:string;investorUserId:string;investmentUsd?:number|string|null;capUsd?:number|string|null;ar:boolean;admin?:boolean};
type Fx={lyd_per_usd:number|string;rate_source:string|null};
type Historic={month_start:string;profit_lyd:number|string|null;other_opex_lyd:number|string|null;previous_month_lyd:number|string|null;net_profit_lyd:number|string|null;exchange_rate_lyd_per_usd:number|string|null;confirmed_payable_usd:number|string|null;confirmed_paid_usd:number|string|null;payment_confirmed_at:string|null};
type Statement={month_start:string;revenue_lyd:number|string;cogs_lyd:number|string;operating_expenses_lyd:number|string;operating_profit_lyd:number|string;investor_share_due_lyd:number|string;investor_share_due_usd:number|string|null;loss_carried_in_lyd:number|string;loss_carried_out_lyd:number|string;calculation_status:string;expense_breakdown:any[]|null;source_complete:boolean};
const ownerMoney=(value:unknown)=>value==null?'—':money(n(value));
const dateToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

export async function InvestorYearOverview({agreementId,investorUserId,investmentUsd,capUsd,ar,admin=false}:Props){
 const db=await getAuthenticatedSupabaseServerClient();
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 if(!db)return <p role="alert">{tr('Investor records unavailable','سجل المستثمر غير متاح')}</p>;
 const [historicResult,monthlyResult,payoutResult,fxResult,policyResult]=await Promise.all([
  db.from('investor_historical_months').select('month_start,profit_lyd,other_opex_lyd,previous_month_lyd,net_profit_lyd,exchange_rate_lyd_per_usd,confirmed_payable_usd,confirmed_paid_usd,payment_confirmed_at').eq('investor_user_id',investorUserId).gte('month_start','2026-01-01').order('month_start'),
  db.from('investor_monthly_statements').select('month_start,revenue_lyd,cogs_lyd,operating_expenses_lyd,operating_profit_lyd,investor_share_due_lyd,investor_share_due_usd,loss_carried_in_lyd,loss_carried_out_lyd,calculation_status,expense_breakdown,source_complete').eq('agreement_id',agreementId).gte('month_start','2026-01-01').order('month_start'),
  db.from('investor_usd_payouts').select('month_start,payout_date,amount_usd,lyd_equivalent,exchange_rate_lyd_per_usd,payment_reference').eq('agreement_id',agreementId).order('payout_date'),
  db.from('investor_monthly_fx_rates').select('month_start,lyd_per_usd,rate_source').eq('agreement_id',agreementId),
  db.from('investor_cost_policies').select('item_key,item_type,label,monthly_amount_lyd,effective_from,effective_through').eq('agreement_id',agreementId),
 ]);
 if(historicResult.error||monthlyResult.error||payoutResult.error||fxResult.error||policyResult.error)
  return <p role="alert" className="rounded-lg border border-rose-200 p-3">{tr('Investor schedule could not be verified; no amounts were assumed.','تعذر التحقق من كشف المستثمر، ولم تُفترض أي مبالغ.')}</p>;
 const history=(historicResult.data??[]) as Historic[];
 const statements=(monthlyResult.data??[]) as Statement[];
 const payouts=payoutResult.data??[];
 const rateMap=new Map((fxResult.data??[]).map(r=>[r.month_start,r as Fx]));
 const historyMap=new Map(history.map(h=>[h.month_start,h]));
 const statementMap=new Map(statements.map(s=>[s.month_start,s]));
 const policies=policyResult.data??[];
 const paidByMonth=new Map<string,number>();
 const paidLydByMonth=new Map<string,number>();
 for(const pay of payouts){paidByMonth.set(pay.month_start,(paidByMonth.get(pay.month_start)??0)+n(pay.amount_usd));paidLydByMonth.set(pay.month_start,(paidLydByMonth.get(pay.month_start)??0)+n(pay.lyd_equivalent));}
 const rateMonth=[...rateMap.entries()].sort(([a],[b])=>b.localeCompare(a))[0];
 const currentRate=rateMonth?Number(rateMonth[1].lyd_per_usd):null;
 const cap=capUsd==null?null:n(capUsd),capital=n(investmentUsd);
 const confirmedHistoric=history.filter(h=>h.payment_confirmed_at&&h.confirmed_payable_usd!=null&&h.confirmed_paid_usd!=null);
 const historicalEarnedUSD=confirmedHistoric.reduce((v,h)=>v+n(h.confirmed_payable_usd),0);
 const historicalPaidUSD=confirmedHistoric.reduce((v,h)=>v+n(h.confirmed_paid_usd),0);
 const historicalEarnedLYD=confirmedHistoric.reduce((v,h)=>v+n(h.confirmed_payable_usd)*n(h.exchange_rate_lyd_per_usd),0);
 const historicPaidLYD=confirmedHistoric.reduce((v,h)=>v+n(h.confirmed_paid_usd)*n(h.exchange_rate_lyd_per_usd),0);
 const finalized=statements.filter(s=>s.calculation_status==='finalized');
 const finalizedEarnedUSD=finalized.reduce((v,s)=>v+n(s.investor_share_due_usd),0);
 const postedUsd=payouts.filter(p=>!historyMap.has(p.month_start)).reduce((v,p)=>v+n(p.amount_usd),0);
 const paidUSD=historicalPaidUSD+postedUsd;
 const paidLYD=historicPaidLYD+payouts.filter(p=>!historyMap.has(p.month_start)).reduce((v,p)=>v+n(p.lyd_equivalent),0);
 const confirmedUSD=historicalEarnedUSD+finalizedEarnedUSD;
 const confirmedLYD=historicalEarnedLYD+finalized.reduce((v,s)=>v+n(s.investor_share_due_lyd),0);
 const draft=statements.filter(s=>s.calculation_status!=='finalized');
 const estimateLYD=draft.reduce((v,s)=>v+n(s.investor_share_due_lyd),0);
 const remainingCapUSD=cap==null?null:Math.max(0,cap-confirmedUSD);
 const capUnpaidUSD=Math.max(0,confirmedUSD-paidUSD);
 const rateReference=currentRate??7.5;
 const projected=draft.filter(s=>s.month_start<dateToday().slice(0,7)+'-01').slice(-3);
 const avgLYD=projected.length===3?projected.reduce((v,s)=>v+n(s.investor_share_due_lyd),0)/3:0;
 const crmMonthly=policies.filter(p=>p.item_key==='salary_crm_oct').reduce((v,p)=>v+n(p.monthly_amount_lyd),0);
 // The October CRM expense is an incremental monthly cost that recent 3-month history does not contain.
 const projectedMonthlyLYD=Math.max(0,avgLYD-crmMonthly*.3);
 const projectedMonthlyUSD=currentRate&&currentRate>0?projectedMonthlyLYD/currentRate:null;
 const estimatedMonths=projectedMonthlyUSD&&projectedMonthlyUSD>0&&remainingCapUSD!=null?Math.ceil(remainingCapUSD/projectedMonthlyUSD):null;
 const allMonths=Array.from({length:12},(_,i)=>new Date(Date.UTC(2026,i,1)).toISOString().slice(0,10))
  .filter(month=>month<=dateToday().slice(0,7)+'-01');
 const progress=cap&&cap>0?Math.min(100,Math.round(100*confirmedUSD/cap)):0;
 const status=(eligible:number,paid:number,draftMonth:boolean)=>draftMonth?tr('Estimate · not payable','تقديري · غير مستحق'):eligible<=0?tr('No payout due','لا يوجد مستحق'):paid>=eligible-0.005?tr('Paid','مدفوع'):paid>0?tr('Partially paid','مدفوع جزئياً'):tr('Unpaid','غير مدفوع');
 const payoutForm=(month:string,remaining:number)=>{
  const fx=rateMap.get(month),historical=historyMap.get(month);
  return <details className="mt-2 rounded-lg border border-slate-200 p-2" key={'pay-'+month}>
   <summary className="cursor-pointer font-medium text-sky-800">{tr('Record payment / Mark paid','تسجيل الدفع / تعديل الحالة إلى مدفوع')}</summary>
   <form action={recordActualInvestorUsdPayout} className="mt-3 grid gap-2 sm:grid-cols-2">
    <input type="hidden" name="agreement_id" value={agreementId}/>
    <input type="hidden" name="month_start" value={month}/>
    <input type="hidden" name="client_submission_id" value={randomUUID()}/>
    <label className="text-xs">{tr('Actual USD paid','المبلغ المدفوع فعلياً بالدولار')}
     <input className="field-input mt-1" name="amount_usd" type="number" required min="0.01" max={remaining.toFixed(2)} step="0.01" defaultValue={remaining.toFixed(2)}/></label>
    <label className="text-xs">{tr('Date of actual payment','تاريخ الدفع الفعلي')}
     <input className="field-input mt-1" name="payout_date" type="date" defaultValue={dateToday()} required/></label>
    <label className="text-xs">{tr('LYD for 1 USD at payment','د.ل مقابل دولار عند الدفع')}
     <input className="field-input mt-1" name="lyd_per_usd" type="number" required min="0.000001" step="0.000001"
       placeholder={historical?tr('Actual payment-day rate (not old 7.5)','سعر يوم الدفع (وليس 7.5 القديم)'):tr('Actual payment-day rate','سعر يوم الدفع الفعلي')}
       defaultValue={fx?String(fx.lyd_per_usd):''}/></label>
    <label className="text-xs">{tr('Payment reference / receipt','رقم الحوالة / مرجع الدفع')}
     <input className="field-input mt-1" name="payment_reference" minLength={3} required placeholder={tr('Reference to actual completed transfer','مرجع تحويل تم بالفعل')}/></label>
    <label className="text-xs">{tr('Account actually used','الحساب الذي تم الدفع منه')}
     <select className="field-input mt-1" name="payment_account"><option value="snacky_usd">Snacky USD</option><option value="owner_usd">{tr('Owner USD','المالك دولار')}</option></select></label>
    <label className="text-xs">{tr('Method','طريقة الدفع')}<select className="field-input mt-1" name="payment_method">
     <option value="bank_transfer">{tr('Bank transfer','حوالة مصرفية')}</option><option value="cash">{tr('Cash USD','دولار نقداً')}</option><option value="other">{tr('Other','أخرى')}</option>
    </select></label>
    <label className="text-xs sm:col-span-2">{tr('Note (optional)','ملاحظة (اختياري)')}<textarea name="notes" className="field-input mt-1" rows={2}/></label>
    <label className="flex gap-2 text-xs sm:col-span-2"><input name="confirm_actual_paid" value="yes" type="checkbox" required/>{tr('I confirm this USD money was ACTUALLY paid. This records a Finance cash-out; it does NOT send money.','أؤكد أن المبلغ دُفع فعلياً بالدولار. يسجل النظام خروج المال ولا يحوّل أي مبلغ بنفسه.')}</label>
    <button className="btn-primary sm:col-span-2" type="submit">{tr('Record actual USD payout and update status','تسجيل دفع الدولار الفعلي وتحديث الحالة')}</button>
   </form>
  </details>;
 };
 return <section className="surface-card space-y-4" dir={ar?'rtl':'ltr'}>
  <div>
   <h2 className="text-xl font-bold">{tr('Tayseer · 2026 Investment & Profit Ledger','تيسير · كشف الاستثمار والأرباح 2026')}</h2>
   <p className="mt-1 text-sm text-slate-600">{tr('30% of net monthly operating profit after products, monthly location/storage rent, salaries and verified running costs. Losses roll forward. All operating figures are LYD; actual distributions are recorded in USD.','30% من صافي أرباح التشغيل بعد المنتجات، إيجارات المواقع والمخزن، الرواتب والمصاريف التشغيلية. تُرحّل الخسائر للأشهر التالية. جميع أرقام التشغيل بالدينار، وتُسجّل التوزيعات الفعلية بالدولار.')}</p>
  </div>
  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
   {[
    [tr('Original contract investment (LYD reference)','الاستثمار الأصلي (ما يعادله بالدينار)'),money(capital*rateReference)],
    [tr('Maximum distributions, 150% (LYD reference)','سقف التوزيعات 150% (ما يعادله بالدينار)'),cap==null?'—':money(cap*rateReference)],
    [tr('Approved historical / finalized shares','المستحقات التاريخية والمعتمدة'),money(confirmedLYD)],
    [tr('April–September provisional shares','الحصص التقديرية من أبريل إلى سبتمبر'),money(estimateLYD)]
   ].map(([label,value])=><div className="rounded-xl border p-3" key={label}><p className="text-xs text-slate-600">{label}</p><strong className="mt-2 block text-lg">{value}</strong></div>)}
  </div>
  <div className="grid gap-3 sm:grid-cols-3">
   <div className="rounded-lg border p-3"><p className="text-xs">{tr('Payment status','حالة الدفع')}</p><strong>{paidUSD<=0?tr('No payments made · Unpaid','لم يتم دفع أي مبلغ · غير مدفوع'):tr('Partly paid · check each month','دُفع جزء · راجع كل شهر')}</strong></div>
   <div className="rounded-lg border p-3"><p className="text-xs">{tr('Paid to date, USD payments (LYD equivalent)','المدفوع فعلياً بالدولار (القيمة بالدينار)')}</p><strong>{money(paidLYD)}</strong></div>
   <div className="rounded-lg border p-3"><p className="text-xs">{tr('Confirmed but still unpaid (USD-denominated)','المستحق المعتمد وغير المدفوع (أصله بالدولار)')}</p><strong>{dollars(capUnpaidUSD)}</strong></div>
  </div>
  {admin?<form action={saveInvestorMonthlyFxRate} className="rounded-xl border border-sky-200 p-4">
    <h3 className="font-semibold">{tr('Current LYD → USD exchange rate','سعر الصرف الحالي من الدينار إلى الدولار')}</h3>
    <p className="mt-1 text-xs text-slate-600">{tr('Enter how many LYD buy one USD. This is for monthly USD estimates and the timeline; it does not itself mark anything paid.','اكتب كم دينار يساوي دولاراً واحداً. يستخدم للتقدير ومدة الوصول للسقف، ولا يُسجل أي مبلغ كمدفوع.')}</p>
    <input type="hidden" name="agreement_id" value={agreementId}/>
    <input type="hidden" name="month_start" value={dateToday().slice(0,7)+'-01'}/>
    <div className="mt-3 flex flex-wrap items-end gap-3">
     <label className="text-sm">1 USD = <input className="field-input mt-1 w-40" name="lyd_per_usd" type="number" required min="0.000001" step="0.000001" defaultValue={rateMap.get(dateToday().slice(0,7)+'-01')?.lyd_per_usd??''} placeholder="LYD"/></label>
     <label className="text-sm">{tr('FX source / date (optional for estimate)','المصدر / التاريخ (اختياري للتقدير)')}<input className="field-input mt-1" name="rate_source" maxLength={500} defaultValue={rateMap.get(dateToday().slice(0,7)+'-01')?.rate_source??''}/></label>
     <button type="submit" className="btn-primary">{tr('Save exchange rate','حفظ سعر الصرف')}</button>
    </div>
   </form>:null}
  <div className="rounded-xl border p-4">
   <div className="flex flex-wrap justify-between gap-3"><strong>{tr('Progress to 150% earned cap','نسبة الوصول لسقف الاستحقاق 150%')}</strong><span>{progress}%</span></div>
   <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-700" style={{width:progress+'%'}}/></div>
   <p className="mt-2 text-sm">{tr('Current rate used for LYD equivalent and forecast','سعر الصرف المستخدم للعرض والتوقعات')}: {currentRate?currentRate.toFixed(3)+' LYD / USD':tr('No current rate saved (historic 7.5 is only a display reference)','لم يُسجل سعر حالي (7.5 سعر تاريخي للعرض فقط)')}</p>
   <p className="mt-2 text-sm">{tr('Estimated months to EARN full capped share','الأشهر المتوقعة للوصول إلى كامل الاستحقاق')}:
     <strong className="ms-2">{estimatedMonths!=null?`${estimatedMonths} ${tr('months (rough estimate)','شهر (تقدير تقريبي)')}`:tr('Enter a current exchange rate to estimate','أدخل سعر الصرف الحالي لحساب التوقع')}</strong>
   </p>
   <p className="mt-1 text-xs text-slate-600">{tr('Forecast uses the average of the last three provisional months, adjusts for the 2,500 LYD CRM salary from October, and assumes a stable chosen FX rate. It does not predict when you will physically pay Tayseer; that requires a payment schedule.','التوقع مبني على متوسط آخر ثلاثة أشهر تقديرية بعد خصم أثر مرتب علاقات العملاء 2,500 د.ل من أكتوبر، وافتراض ثبات سعر الصرف المُدخل. لا يتنبأ بموعد سدادك الفعلي لتيسير؛ ذلك يحتاج خطة دفع.')}</p>
   <p className="mt-2 text-xs text-amber-900">{tr('USD contractual cap stays $8,280. Any LYD-equivalent cap above changes with the entered rate and is NOT a fixed LYD settlement obligation.','سقف العقد بالدولار ثابت عند 8,280 دولار. معادله بالدينار يتغير بسعر الصرف ولا يعتبر سقفاً ثابتاً بالدينار.')}</p>
  </div>
  <div className="overflow-x-auto">
   <table className="w-full min-w-[1050px] text-sm">
    <thead><tr className="border-b bg-slate-50">{[
     tr('Month','الشهر'),tr('Sales / historical profit','المبيعات / الربح التاريخي'),tr('Product costs','تكلفة المنتجات'),tr('Operating expenses','مصاريف التشغيل'),tr('Net profit','صافي الربح'),tr('Loss carry','الخسارة المرحلة'),tr('30% LYD share','حصة 30% بالدينار'),tr('Payment status','حالة الدفع'),tr('Details','التفاصيل')
    ].map(label=><th className="p-3 text-start" key={label}>{label}</th>)}</tr></thead>
    <tbody>{allMonths.map(month=>{
     const h=historyMap.get(month),s=statementMap.get(month);
     const eligibleUSD=h?n(h.confirmed_payable_usd):s?.calculation_status==='finalized'?n(s.investor_share_due_usd):0;
     const paidUSDForMonth=h?n(h.confirmed_paid_usd):paidByMonth.get(month)??0;
     const isDraft=!h&&s?.calculation_status!=='finalized';
     const ownerMonthRate=rateMap.get(month);
     const impliedUSD=ownerMonthRate&&s?n(s.investor_share_due_lyd)/n(ownerMonthRate.lyd_per_usd):null;
     const eligibleLYD=h?n(h.confirmed_payable_usd)*n(h.exchange_rate_lyd_per_usd):n(s?.investor_share_due_lyd);
     const currentPolicy=policies.filter(p=>p.effective_from<=month&&(!p.effective_through||p.effective_through>=month));
     const scheduledRent=currentPolicy.filter(p=>p.item_type==='rent').reduce((sum,p)=>sum+n(p.monthly_amount_lyd),0);
     const scheduledSalary=currentPolicy.filter(p=>p.item_type==='salary_adjustment').reduce((sum,p)=>sum+n(p.monthly_amount_lyd),0);
     return <tr key={month} className="border-b align-top">
      <td className="whitespace-nowrap p-3 font-semibold">{monthName(month,ar)}</td>
      <td className="whitespace-nowrap p-3">{h?ownerMoney(h.profit_lyd):s?money(n(s.revenue_lyd)):'—'}</td>
      <td className="whitespace-nowrap p-3">{h?'—':s?money(n(s.cogs_lyd)):'—'}</td>
      <td className="whitespace-nowrap p-3">{h?ownerMoney(h.other_opex_lyd):s?money(n(s.operating_expenses_lyd)):money(scheduledRent+scheduledSalary)+'*'}</td>
      <td className="whitespace-nowrap p-3">{h?ownerMoney(h.net_profit_lyd):s?money(n(s.operating_profit_lyd)):'—'}</td>
      <td className="whitespace-nowrap p-3">{h?ownerMoney(h.previous_month_lyd):s?money(n(s.loss_carried_out_lyd)):'—'}</td>
      <td className="whitespace-nowrap p-3 font-semibold">{h||s?money(eligibleLYD):'—'}</td>
      <td className="p-3"><span className={eligibleUSD>0&&paidUSDForMonth<=0&&!isDraft?'font-semibold text-amber-800':'text-slate-600'}>
       {status(eligibleUSD,paidUSDForMonth,isDraft)}</span>{h||s?.calculation_status==='finalized'?<p className="text-xs">{tr('Actually paid','مدفوع فعلياً')}: {money(h?n(h.confirmed_paid_usd)*n(h.exchange_rate_lyd_per_usd):paidLydByMonth.get(month)??0)}</p>:null}</td>
      <td className="min-w-[230px] p-3">
       {s?<details><summary className="cursor-pointer font-medium text-sky-800">{tr('Cost breakdown','تفصيل المصاريف')}</summary>
        <div className="mt-2 space-y-1 text-xs">{(s.expense_breakdown??[]).map((x:any,i:number)=><div className="flex justify-between gap-2 border-b py-1" key={i}><span>{String(x.label??x.key)}</span><strong>{money(n(x.amount))}</strong></div>)}
        {!s.expense_breakdown?.length?<p>{tr('No expense lines verified','لا توجد مصاريف تفصيلية معتمدة')}</p>:null}</div></details>:null}
       {!h&&!s&&scheduledRent+scheduledSalary>0?<div className="text-xs text-amber-800">{tr('Planned only, sales not yet checked','تكاليف متوقعة فقط، المبيعات لم تُراجع')}:
       <p>{tr('Rent','إيجار')}: {money(scheduledRent)}</p><p>{tr('Salaries','مرتبات')}: {money(scheduledSalary)}</p></div>:null}
       {s&&ownerMonthRate?<p className="mt-1 text-xs">{tr('Estimate only at entered FX','تقدير فقط بسعر الصرف المدخل')}: {impliedUSD!=null?dollars(impliedUSD):'—'}</p>:null}
       {admin&&!h?<details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-sky-800">{tr('Set LYD / USD rate','تعديل سعر الصرف')}</summary>
        <form action={saveInvestorMonthlyFxRate} className="mt-2 space-y-2">
         <input type="hidden" name="agreement_id" value={agreementId}/><input type="hidden" name="month_start" value={month}/>
         <label className="block text-xs">1 USD = <input className="field-input mt-1" name="lyd_per_usd" type="number" min=".000001" step=".000001" required defaultValue={ownerMonthRate?String(ownerMonthRate.lyd_per_usd):''} placeholder="LYD"/></label>
         <label className="block text-xs">{tr('Source (optional for estimate)','المصدر (اختياري للتقدير)')}<input className="field-input mt-1" name="rate_source" maxLength={500} defaultValue={ownerMonthRate?.rate_source??''}/></label>
         <button type="submit" className="btn-secondary">{tr('Save exchange rate','حفظ سعر الصرف')}</button>
        </form>
       </details>:null}
       {admin&&eligibleUSD-paidUSDForMonth>0.005&&!isDraft?payoutForm(month,eligibleUSD-paidUSDForMonth):null}
      </td>
     </tr>;
    })}</tbody>
   </table>
  </div>
  <p className="text-xs text-slate-600">{tr('January–March reflects owner-confirmed history (the January loss was already applied in February). From April, rent schedules were applied provisionally because historical start dates for HT Land and the increased HT Mall rent were not established. September includes 640 LYD for Basheer and 250 LYD for Ahmed; October includes planned 2,500 LYD CRM salary. No historical owner salary was invented. Shipping for new machines and owner drawings are excluded from operating costs.','يناير–مارس أرقام تاريخية أكدها المالك (خسارة يناير خُصمت بالفعل في فبراير). من أبريل أُدرجت الإيجارات كتقديرات لعدم توثيق بداية HT Land وزيادة HT Mall. سبتمبر يشمل 640 د.ل لبشير و250 د.ل لأحمد، وأكتوبر يشمل مرتب CRM المخطط له 2,500 د.ل. لم نفترض أي مرتب تاريخي للمالك. شحن الماكينات الجديدة والسحوبات الشخصية للمالك ليست مصاريف تشغيلية.')}</p>
  <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">{tr('April–September are UNFINALIZED estimates. Earlier rent start dates, manual-sale product costs, missing historical payroll and suspicious Finance entries need reconciliation. “Paid” is only recorded through the actual USD payment form and matching Finance cash-out. Changing an FX estimate does not record a payment.','أبريل–سبتمبر ما زالت تقديرات غير معتمدة. يجب مراجعة تواريخ الإيجارات وتكلفة المبيعات اليدوية والمرتبات التاريخية والحركات المالية المريبة. لا تصبح الحالة «مدفوع» إلا بعد تسجيل دفع دولار فعلي وربطه بحركة صرف مالية. تعديل سعر الصرف لا يسجل أي دفع.')}</p>
 </section>;
}
