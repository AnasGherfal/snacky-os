import { StatusBadge } from "@/components/ui";
import { InvestorMoneyForm } from "@/components/InvestorMoneyForm";
import { finalizeInvestorStatement } from "@/lib/investor-actions";
import { formatFinanceMoney } from "@/lib/finance-balance";

export type InvestorStatementRecord={
 id:string;agreement_id:string;month_start:string;revenue_lyd:number|string;cogs_lyd:number|string;gross_profit_lyd:number|string;
 operating_expenses_lyd:number|string;operating_profit_lyd:number|string;share_percent:number|string;investor_share_due_lyd:number|string;investor_share_due_usd?:number|string|null;
 calculation_status:string;generated_at:string;source_complete?:boolean;data_source_note?:string|null;capital_purchases_lyd?:number|string|null;
 distribution_basis_lyd?:number|string|null;profit_basis?:string|null;expense_breakdown?:Array<{key:string;label:string;amount:number;transactionCount:number|null}>|null;
};
export function InvestorStatementCard({statement:s,paid,ar,adminUserId,usdCapped=false}:{statement:InvestorStatementRecord;paid:number;ar:boolean;adminUserId?:string;usdCapped?:boolean}) {
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const due=Number(s.investor_share_due_lyd),remaining=Math.max(0,due-paid),final=s.calculation_status==='finalized';
 const fmtUsd=(v:unknown)=>v==null?tr('Not verified','غير معتمد'):"$"+Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const fmt=(v:unknown)=>v===null||v===undefined?tr('Not recorded','غير مسجّل'):Number.isFinite(Number(v))?formatFinanceMoney(Number(v)):tr('Unavailable','غير متاح');
 const names:Record<string,string>={rent:'الإيجارات',salary:'الرواتب',shipping:'الشحن والجمارك',ads:'الإعلانات',maintenance:'الصيانة',vehicle:'المواصلات والسيارة',utilities:'الخدمات والاتصالات',fees:'الرسوم',charity:'التبرعات'};
 return <details className="surface-card" open={Boolean(adminUserId)&&!final}>
  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
   <span className="font-semibold">{s.month_start.slice(0,7)} <StatusBadge status={s.calculation_status} /></span>
   <span className="text-sm">{usdCapped ? <>{final?tr('Finalized USD share','الحصة المعتمدة بالدولار'):tr('Draft · not payable','مسودة · غير مستحقة')}: <strong>{final?fmtUsd(s.investor_share_due_usd):'—'}</strong></> : <>{final?tr('Due','المستحق'):tr('Draft estimate','تقدير المسودة')}: <strong>{fmt(due)}</strong> · {tr('Paid','المدفوع')}: {fmt(paid)}</>}</span>
  </summary>
  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
   {[[tr('Sales revenue','إيراد المبيعات'),s.revenue_lyd],[tr('Cost of products sold','تكلفة المنتجات المباعة'),s.cogs_lyd],[tr('Gross profit','مجمل الربح'),s.gross_profit_lyd],[tr('Recorded operating expenses','المصاريف التشغيلية المسجّلة'),s.operating_expenses_lyd],[tr('Operating profit','الربح التشغيلي'),s.operating_profit_lyd],[tr('Machine/equipment purchases','مشتريات الماكينات والمعدات'),s.capital_purchases_lyd],[tr('Agreed distribution basis','أساس التوزيع المتفق عليه'),s.distribution_basis_lyd??s.operating_profit_lyd],...(usdCapped ? [] : [[`${tr('Investor share','حصة المستثمر')} (${s.share_percent}%)`,due],[tr('Unpaid entitlement','المستحق غير المدفوع'),remaining]])].map(([label,value])=><div key={String(label)} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-600">{String(label)}</div><div className="mt-1 font-semibold">{fmt(value)}</div></div>)}
  </div>
  {usdCapped?<p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{tr('Contractual USD share','الحصة التعاقدية بالدولار')}: <strong>{final?fmtUsd(s.investor_share_due_usd):tr('Draft — not payable','مسودة — غير مستحقة')}</strong>. {tr('USD payouts and outstanding balances are reconciled in the USD investment ledger, not inferred from LYD entries.','تُراجع دفعات الدولار والأرصدة غير المدفوعة في كشف الاستثمار بالدولار، ولا تستنتج من حركات الدينار.')}</p>:null}
  <p className="mt-3 text-sm text-slate-600">{s.profit_basis==='operating_profit_after_capex'?tr('Contractual basis: operating profit minus recorded machine/equipment purchases, then the agreed percentage. This is a distribution rule, not an accounting-profit measure.','الأساس التعاقدي: الربح التشغيلي ناقص مشتريات الماكينات والمعدات المسجلة، ثم النسبة المتفق عليها. هذه قاعدة توزيع وليست مقياساً للربح المحاسبي.'):tr('Operating-profit basis: new machines are shown separately, not deducted in full from this month. Depreciation/tax adjustments must be recorded separately when applicable.','أساس الربح التشغيلي: تظهر الماكينات الجديدة منفصلة ولا يُخصم كامل ثمنها من هذا الشهر. يجب تسجيل تعديلات الإهلاك والضرائب منفصلة عند انطباقها.')}</p>
  <h3 className="mt-5 font-semibold">{tr('Operating expense breakdown','تفصيل المصاريف التشغيلية')}</h3>
  <div className="mt-2 space-y-2">{(s.expense_breakdown??[]).map((row)=><div className="flex justify-between gap-3 border-b border-slate-100 py-2 text-sm" key={row.key}><span>{ar?(names[row.key]??row.label):row.label}{row.transactionCount == null ? '' : ` (${row.transactionCount})`}</span><strong>{fmt(row.amount)}</strong></div>)}</div>
  {!s.expense_breakdown?.length?<p className="mt-2 text-sm text-amber-900">{tr('No itemized operating expenses are recorded in this snapshot. This is not proof that rent or other costs were zero.','لا توجد مصاريف تشغيلية مفصّلة في هذا البيان. هذا لا يعني أن الإيجار أو التكاليف الأخرى كانت صفراً.')}</p>:null}
  {!usdCapped&&paid>due+0.005?<p role="alert" className="mt-3 text-sm text-rose-800">{tr('Recorded payments exceed this entitlement. Review Finance before any further payout.','الدفعات المسجّلة تتجاوز المستحق. راجع المالية قبل أي دفعة أخرى.')}</p>:null}
  {adminUserId&&!final?<div className="mt-5 border-t border-slate-200 pt-4">
   {!s.source_complete?<p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{tr('Incomplete draft. Resolve missing costs, exchange rates or unreviewed Finance entries and recalculate.','المسودة غير مكتملة. عالج التكاليف أو أسعار الصرف المفقودة أو الحركات غير المراجعة، ثم أعد الحساب.')}</p>:<form action={finalizeInvestorStatement} className="space-y-3">
    <input type="hidden" name="agreement_id" value={s.agreement_id}/><input type="hidden" name="statement_id" value={s.id}/><input type="hidden" name="generated_at" value={s.generated_at}/>
    {[["sales",tr('All sales for this month are present.','جميع مبيعات الشهر موجودة.')],["rent_payroll",tr('Rent, salaries and any unpaid monthly obligations have been reviewed and entered correctly.','تمت مراجعة وتسجيل الإيجارات والرواتب والالتزامات الشهرية غير المدفوعة بصورة صحيحة.')],["expenses",tr('Other expenses, refunds and any depreciation/tax adjustments have been reviewed; USD costs have historical LYD rates.','تمت مراجعة المصاريف الأخرى والمبالغ المرتجعة وتعديلات الإهلاك والضرائب، وتسجيل سعر الصرف التاريخي للتكاليف بالدولار.')],["capital",tr('Machine purchases are complete, correctly classified, and treated according to the investor agreement.','مشتريات الماكينات مكتملة ومصنفة ومعالجة حسب اتفاق المستثمر.')]].map(([key,label])=><label className="flex items-start gap-2 text-sm" key={key}><input type="checkbox" name={`review_${key}`} value="yes" required/><span>{label}</span></label>)}
    <button className="btn-primary">{tr('Finalize monthly entitlement','اعتماد مستحقات الشهر')}</button>
   </form>}
   {s.data_source_note?<p className="mt-3 break-words text-xs text-slate-500">{s.data_source_note}</p>:null}
  </div>:null}
  {adminUserId&&final&&usdCapped?<p className="mt-4 rounded-lg border border-amber-200 p-3 text-sm text-amber-950">{tr('USD-capped agreement: use the verified USD ledger above to record actual payouts. This LYD-only payment form is disabled to prevent mixing currencies.','اتفاقية بسقف بالدولار: سجّل الدفع الفعلي بالدولار من كشف الدولار أعلاه. تم تعطيل الدفع بالدينار هنا لمنع خلط العملات.')}</p>:null}
  {adminUserId&&final&&remaining>0&&!usdCapped?<details className="mt-5 rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer font-semibold">{tr('Record investor payout','تسجيل دفعة للمستثمر')} · {fmt(remaining)}</summary><div className="mt-4"><InvestorMoneyForm kind="payout" entityId={s.id} userId={adminUserId} remaining={remaining}/></div></details>:null}
 </details>;
}
