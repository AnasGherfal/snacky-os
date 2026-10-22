import { type InvestorHistoricalMonth } from '@/lib/investor-history';
import { historicalPaymentSummary } from '@/lib/investor-history-payment';

const lyd=(n:number)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+' LYD';
const validRate=(row:InvestorHistoricalMonth)=>{const n=Number(row.exchange_rate_lyd_per_usd);return Number.isFinite(n)&&n>0?n:null;};
const ownerCell=(value:unknown)=>value===null||value===undefined||value===''?'—':lyd(Number(value));

export function InvestorHistoryTable({rows,investorName,ar}:{rows:InvestorHistoricalMonth[];investorName:string;ar:boolean}) {
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const payments=historicalPaymentSummary(rows);
 const historicalTotals=payments.validScope&&payments.unconfirmedCount===0&&rows.every(r=>validRate(r)!==null);
 const total=(key:'dueCents'|'paidCents'|'remainingCents')=>rows.reduce((sum,row,i)=>{
  const position=payments.positions[i];if(!position.confirmed)return sum;
  return sum+position[key]*Number(validRate(row))/100;
 },0);
 const statusLabels:{[key:string]:string}={
  unconfirmed:tr('Not confirmed','غير مؤكد'),
  no_payout_due:tr('No payout due','لا يوجد مستحق'),
  unpaid:tr('Unpaid','غير مدفوع'),
  partially_paid:tr('Partially paid','مدفوع جزئياً'),
  paid:tr('Paid','مدفوع')
 };
 return <section className="surface-card min-w-0 space-y-4" dir={ar?'rtl':'ltr'}>
  <div><h3 className="font-semibold text-slate-950">{investorName}</h3>
   <p className="mt-1 text-xs text-slate-600">{tr('Owner-supplied January–March 2026 history. All displayed financial amounts are LYD; original source remains unchanged for audit.','سجل يناير–مارس 2026 الذي قدمه المالك. جميع المبالغ المعروضة بالدينار، والبيانات الأصلية محفوظة للمراجعة.')}</p>
  </div>
  {historicalTotals?<div className="grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:grid-cols-3">
   {[[tr('Confirmed payable','المستحق المؤكد'),total('dueCents')],[tr('Paid','المدفوع'),total('paidCents')],[tr('Remaining unpaid','المتبقي غير المدفوع'),total('remainingCents')]].map(([label,n])=><div key={String(label)}><p className="text-xs text-slate-700">{label}</p><strong className="text-lg">{lyd(Number(n))}</strong></div>)}
  </div>:<p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">{tr('Historical payout totals need verified source rates and payment status.','الإجماليات التاريخية تحتاج تأكيد أسعار الصرف وحالات الدفع.')}</p>}
  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={tr('Historical monthly LYD figures','الأرقام الشهرية التاريخية بالدينار')}>
   <table className="w-full min-w-[920px] text-sm">
    <thead><tr className="border-b bg-slate-50">{[
     tr('Month','الشهر'),tr('Historical profit','الربح التاريخي'),tr('COGS','تكلفة المنتجات'),tr('Other operating expenses','مصاريف التشغيل الأخرى'),tr('Previous loss applied','الخسارة السابقة المخصومة'),
     tr('Net profit','صافي الربح'),tr('Investor share (30%)','حصة المستثمر (30%)'),tr('Paid','المدفوع'),tr('Status','الحالة')
    ].map(h=><th key={h} className="p-3 text-start">{h}</th>)}</tr></thead>
    <tbody>{rows.map((row,i)=>{
     const position=payments.positions[i],rate=validRate(row);
     const confirmVal=(key:'dueCents'|'paidCents')=>position.confirmed&&rate!==null?lyd(position[key]*rate/100):'—';
     return <tr key={row.id} className="border-b align-top">
      <td className="p-3 font-medium whitespace-nowrap">{row.source_cells.Month||row.month_start.slice(0,7)}</td>
      <td className="p-3 whitespace-nowrap">{ownerCell(row.profit_lyd)}</td>
      <td className="p-3">{ownerCell(row.cogs_refill_cost_lyd)}</td>
      <td className="p-3 whitespace-nowrap">{ownerCell(row.other_opex_lyd)}</td>
      <td className="p-3 whitespace-nowrap">{ownerCell(row.previous_month_lyd)}</td>
      <td className="p-3 whitespace-nowrap">{ownerCell(row.net_profit_lyd)}</td>
      <td className="p-3 whitespace-nowrap font-semibold">{confirmVal('dueCents')}</td>
      <td className="p-3 whitespace-nowrap">{confirmVal('paidCents')}</td>
      <td className="p-3">{statusLabels[position.status]}</td>
     </tr>;
    })}</tbody>
   </table>
  </div>
  <p className="text-xs text-slate-600">{tr('Historical LYD shares are shown using each source month’s recorded exchange rate (7.5 LYD for every January–March 2026 row), not today’s rate. January’s loss was already applied in February; it is not deducted again. Missing costs are not assumed zero. These confirmed historical sums are not additional payouts.', 'تظهر الحصص التاريخية بالدينار باستخدام سعر الصرف المسجل لكل شهر (7.5 د.ل في أشهر يناير–مارس 2026)، وليس سعر اليوم. خسارة يناير مخصومة مسبقاً في فبراير ولا تُخصم مرتين. التكلفة غير الموثقة لا تُفترض صفراً. هذه المستحقات التاريخية ليست دفعات جديدة.')}</p>
 </section>;
}
