/* eslint-disable @typescript-eslint/no-explicit-any */
import { getAuthenticatedSupabaseServerClient } from '@/lib/auth';

const fmtLYD = (n: number) => new Intl.NumberFormat('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}).format(n) + ' LYD';
const fmtUSD = (n: number) => '$' + new Intl.NumberFormat('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
const amount = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const monthLabel = (month: string, ar: boolean) => new Intl.DateTimeFormat(ar ? 'ar-LY' : 'en-US', {month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'T12:00:00Z'));
type Input = { agreementId: string; investorUserId: string; investmentUsd?: number|string|null; capUsd?: number|string|null; ar: boolean };

export async function InvestorYearOverview({agreementId,investorUserId,investmentUsd,capUsd,ar}:Input) {
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return <p role="alert">{ar?'تعذر تحميل كشف المستثمر.':'Investor schedule unavailable.'}</p>;
  const [history,statements,payments] = await Promise.all([
    db.from('investor_historical_months').select('month_start,profit_lyd,other_opex_lyd,previous_month_lyd,net_profit_lyd,exchange_rate_lyd_per_usd,investor_share_usd,confirmed_payable_usd,confirmed_paid_usd,payment_confirmed_at').eq('investor_user_id',investorUserId).gte('month_start','2026-01-01').order('month_start'),
    db.from('investor_monthly_statements').select('month_start,revenue_lyd,cogs_lyd,operating_expenses_lyd,operating_profit_lyd,distribution_basis_lyd,investor_share_due_lyd,calculation_status,loss_carried_in_lyd,loss_carried_out_lyd,source_complete,usd_rate_lyd_per_usd,investor_share_due_usd,data_source_note').eq('agreement_id',agreementId).gte('month_start','2026-01-01').order('month_start'),
    db.from('investor_payments').select('amount_lyd,finance_posting_status,finance_transaction_id').eq('agreement_id',agreementId),
  ]);
  if(history.error || statements.error || payments.error)
    return <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-4">{ar?'تعذر التحقق من السجل الشهري. لم يُفترض أي مبلغ.':'Could not verify monthly records; amounts were not assumed.'}</p>;
  const historical = new Map((history.data??[]).map(h=>[h.month_start,h]));
  const monthly = new Map((statements.data??[]).map(s=>[s.month_start,s]));
  const confirmedHistory = (history.data??[]).filter(h=>h.payment_confirmed_at && h.confirmed_payable_usd != null && h.confirmed_paid_usd != null);
  const historicalDueUSD = confirmedHistory.reduce((sum,h)=>sum+amount(h.confirmed_payable_usd),0);
  const historicalPaidUSD = confirmedHistory.reduce((sum,h)=>sum+amount(h.confirmed_paid_usd),0);
  const finalizedUSD = (statements.data??[]).filter(s=>s.calculation_status==='finalized' && s.investor_share_due_usd != null).reduce((sum,s)=>sum+amount(s.investor_share_due_usd),0);
  const settledLYD = (payments.data??[]).filter(p=>p.finance_posting_status==='posted'&&p.finance_transaction_id).reduce((sum,p)=>sum+amount(p.amount_lyd),0);
  const drafts = (statements.data??[]).filter(s=>s.calculation_status!=='finalized');
  const estimateLyd = drafts.reduce((sum,s)=>sum+amount(s.investor_share_due_lyd),0);
  const knownUSD = historicalDueUSD+finalizedUSD;
  const cap=capUsd == null ? null : amount(capUsd);
  const progress=cap && cap>0 ? Math.min(100,100*knownUSD/cap):0;
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Tripoli'});
  const currentMonth=today.slice(0,7)+'-01';
  const rows=Array.from({length:12},(_,i)=>new Date(Date.UTC(2026,i,1)).toISOString().slice(0,10))
    .filter(mon=>mon<=currentMonth);
  const tr=(en:string,arabic:string)=>ar?arabic:en;
  return <section className="surface-card space-y-4" aria-labelledby="tayseer-year-overview" dir={ar?'rtl':'ltr'}>
    <div className="flex flex-wrap justify-between gap-3">
      <div>
        <h2 id="tayseer-year-overview" className="text-xl font-bold">{tr('2026 · Monthly profit & investor share','2026 · الأرباح الشهرية وحصة المستثمر')}</h2>
        <p className="mt-1 text-sm text-slate-600">{tr('30% of net operating profit after products, rent, payroll and recorded operating costs. Any operating loss reduces profits in subsequent months before a share becomes due.','30% من صافي الربح التشغيلي بعد المنتجات والإيجار والمرتبات والمصاريف التشغيلية المسجلة. تُرحّل الخسارة وتُخصم من أرباح الأشهر التالية قبل احتساب الحصة.')}</p>
      </div>
      <span className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">{tr('Contract investment', 'الاستثمار المتفق عليه')}: {fmtUSD(amount(investmentUsd))}</span>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border p-3"><p className="text-xs">{tr('Maximum cumulative share (150%)','الحد الأقصى الإجمالي للحصة (150%)')}</p><strong>{cap!=null?fmtUSD(cap):'—'}</strong></div>
      <div className="rounded-xl border p-3"><p className="text-xs">{tr('Confirmed historical USD entitlement, Jan–Mar','المستحق التاريخي المؤكد بالدولار، يناير–مارس')}</p><strong>{fmtUSD(historicalDueUSD)}</strong></div>
      <div className="rounded-xl border p-3"><p className="text-xs">{tr('Remaining USD entitlement capacity (excluding drafts)','المتبقي من سقف الدولار (دون المسودات)')}</p><strong>{cap!=null?fmtUSD(Math.max(0,cap-knownUSD)):'—'}</strong></div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs">{tr('Apr–Sep provisional LYD shares — NOT payable yet','الحصص التقديرية بالدينار من أبريل–سبتمبر — ليست مستحقة بعد')}</p><strong>{fmtLYD(estimateLyd)}</strong></div>
    </div>
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={tr('USD cap progress for verified entitlements','نسبة المستحق المؤكد من سقف الدولار')}><div className="h-full rounded-full bg-emerald-700" style={{width:progress+'%'}}/></div>
    <p className="text-xs text-slate-600">{tr('Confirmed January–March payouts recorded: ', 'الدفعات المؤكدة من يناير إلى مارس: ')}{fmtUSD(historicalPaidUSD)}. {tr('Posted payouts in the new LYD ledger: ','الدفعات المرحلة في دفتر الدينار الجديد: ')}{fmtLYD(settledLYD)}. {tr('These are separate currencies and are never added without a verified exchange rate.','العملتان منفصلتان ولا يتم جمعهما دون سعر صرف موثق.')}</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[880px] text-sm">
      <thead><tr className="border-b bg-slate-50 text-start">
        {[tr('Month','الشهر'),tr('Sales / original profit','المبيعات / الربح الأصلي'),tr('Products','تكلفة المنتجات'),tr('Operating expenses','المصاريف التشغيلية'),tr('Net profit after costs','صافي الربح بعد المصاريف'),tr('Loss carried in → out','الخسارة المرحلة دخول ← خروج'),tr('Investor 30%','حصة المستثمر 30%'),tr('Status','الحالة')].map(h=><th key={h} className="p-3 text-start font-semibold">{h}</th>)}
      </tr></thead>
      <tbody>{rows.map(mon=>{
        const h=historical.get(mon),s=monthly.get(mon);
        return <tr key={mon} className="border-b align-top">
          <td className="p-3 whitespace-nowrap font-medium">{monthLabel(mon,ar)}</td>
          {h ? <>
            <td className="p-3">{fmtLYD(amount(h.profit_lyd))}<p className="text-xs text-slate-500">{tr('Owner-supplied profit figure','رقم الربح المقدم من المالك')}</p></td>
            <td className="p-3 text-slate-500">{tr('Not separately provided','غير مفصلة')}</td>
            <td className="p-3">{fmtLYD(Math.abs(amount(h.other_opex_lyd)))}</td>
            <td className="p-3">{fmtLYD(amount(h.net_profit_lyd))}</td>
            <td className="p-3">{h.previous_month_lyd==null?'—':fmtLYD(amount(h.previous_month_lyd))} → {amount(h.net_profit_lyd)<0?fmtLYD(amount(h.net_profit_lyd)):'0.00 LYD'}</td>
            <td className="p-3 font-semibold">{h.confirmed_payable_usd==null?'—':fmtUSD(amount(h.confirmed_payable_usd))}</td>
            <td className="p-3 text-emerald-800">{tr('Historical · owner confirmed','تاريخي · مؤكد من المالك')}</td>
          </> : s ? <>
            <td className="p-3">{fmtLYD(amount(s.revenue_lyd))}</td>
            <td className="p-3">{fmtLYD(amount(s.cogs_lyd))}</td>
            <td className="p-3">{fmtLYD(amount(s.operating_expenses_lyd))}</td>
            <td className="p-3">{fmtLYD(amount(s.operating_profit_lyd))}</td>
            <td className="p-3">{fmtLYD(amount(s.loss_carried_in_lyd))} → {fmtLYD(amount(s.loss_carried_out_lyd))}</td>
            <td className="p-3 font-semibold">{fmtLYD(amount(s.investor_share_due_lyd))}{s.calculation_status==='draft'?<p className="text-xs font-normal text-amber-800">{tr('Estimate, not yet due','تقدير، غير مستحق حالياً')}</p>:s.investor_share_due_usd!=null?<p className="text-xs">{fmtUSD(amount(s.investor_share_due_usd))}</p>:null}</td>
            <td className="p-3">{s.calculation_status==='finalized'?tr('Finalized','معتمد'):tr('Draft · source/FX review','مسودة · مراجعة المصاريف والصرف')}</td>
          </> : <td colSpan={7} className="p-3 text-slate-500">{mon===currentMonth?tr('Current month: waiting for verified complete sales and expense records. No payout is accrued yet.','الشهر الحالي: بانتظار بيانات المبيعات والمصاريف المعتمدة. لا يُحسب استحقاق حتى الآن.'):tr('No verified monthly figures available.','لا تتوفر أرقام شهرية معتمدة.')}</td>}
        </tr>;
      })}</tbody>
    </table></div>
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{tr('Important: April–September calculations are draft estimates from active XY monthly reports and currently categorized Finance expenses. Some expenses and manual sales costs remain unresolved. These amounts must not be recorded as verified debt or paid until costs are reconciled and the USD exchange rate used for the $8,280 cap is documented. New machines are capital investment, not automatically a full operating expense.','مهم: حسابات أبريل–سبتمبر تقديرية بناءً على ملفات XY الشهرية النشطة والمصاريف المصنفة حالياً. توجد مصاريف وتكلفة مبيعات يدوية تحتاج تسوية. لا تُعتبر الأرقام ديناً معتمداً ولا تُدفع قبل مراجعة جميع المصاريف وتوثيق سعر الصرف لحساب سقف 8,280 دولار. شراء الماكينات الجديدة استثمار رأسمالي وليس بالضرورة مصروفاً تشغيلياً كاملاً.')}</p>
  </section>;
}
