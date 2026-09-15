import { historicalCell, type InvestorHistoricalMonth } from '@/lib/investor-history';
import { historicalPaymentSummary } from '@/lib/investor-history-payment';

export function InvestorHistoryTable({ rows, investorName, ar }: {
  rows: InvestorHistoricalMonth[];
  investorName: string;
  ar: boolean;
}) {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const payments = historicalPaymentSummary(rows);
  const money = (cents: number | null) => cents === null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const statusLabels = {
    unconfirmed: tr('Not confirmed', 'غير مؤكّد'),
    no_payout_due: tr('No payout due', 'لا توجد دفعة مستحقة'),
    unpaid: tr('Unpaid', 'غير مدفوع'),
    partially_paid: tr('Partially paid', 'مدفوع جزئياً'),
    paid: tr('Paid', 'مدفوع'),
  };
  return (
    <section className="surface-card min-w-0" dir={ar ? 'rtl' : 'ltr'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-950">{investorName}</h3>
          <p className="mt-1 text-xs text-slate-600">{tr('Owner-supplied historical figures · original signs, blanks and rounding preserved', 'أرقام تاريخية قدّمها المالك · الإشارات والخانات الفارغة والتقريب كما وردت')}</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium">{payments.confirmedCount === 0
          ? tr('Historical record — payment status not supplied', 'سجل تاريخي — حالة الدفع غير مذكورة')
          : tr('Historical payment position confirmed by owner', 'حالة الدفعات التاريخية مؤكدة من المالك')}</span>
      </div>
      {payments.confirmedCount > 0 && payments.validScope ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h4 className="font-semibold text-slate-950">{tr('Historical amounts still owed (USD)', 'المستحقات التاريخية المتبقية (دولار)')}</h4>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            {[
              [tr('Confirmed payable', 'المستحق المؤكّد'), payments.dueCents],
              [tr('Paid', 'المدفوع'), payments.paidCents],
              [tr('Still owed', 'المتبقي المستحق'), payments.remainingCents],
            ].map(([label, amount]) => <div key={String(label)}><dt className="text-xs text-slate-700">{String(label)}</dt><dd className="mt-1 text-xl font-semibold" dir="ltr">{money(amount as number | null)}</dd></div>)}
          </dl>
          <p className="mt-3 text-xs text-slate-700">{tr('For the confirmed historical months below only. Separate from current LYD totals; no money has been moved by this confirmation.', 'للأشهر التاريخية المؤكدة أدناه فقط. منفصلة عن الإجماليات الحالية بالدينار؛ هذا التأكيد لا يحرّك الأموال.')}</p>
          {payments.unconfirmedCount > 0 ? <p className="mt-2 text-sm text-amber-950">{tr('Some months still have unconfirmed payment status and are excluded from these totals.', 'بعض الأشهر لم تُؤكّد حالة دفعها ولا تدخل في هذه الإجماليات.')}</p> : null}
        </div>
      ) : null}
      {!payments.validScope ? <p role="alert" className="mt-3 text-sm text-rose-800">{tr('Payment totals could not be verified. Review duplicated months or mixed investor records.', 'تعذر التحقق من إجماليات الدفع. راجع تكرار الأشهر أو اختلاط سجلات المستثمرين.')}</p> : null}
      <div className="mt-4 max-w-full overflow-x-auto" tabIndex={0} role="region" aria-label={tr('Historical investor figures', 'الأرقام التاريخية للمستثمر')}>
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <caption className="sr-only">{tr('Original monthly source figures. Payment confirmations are shown separately.', 'الأرقام الأصلية للجدول الشهري. تظهر تأكيدات الدفع منفصلة.')}</caption>
          <thead>
            <tr className="border-b border-slate-200 text-start text-xs text-slate-600">
              {[
                tr('Month', 'الشهر'), tr('Profit', 'الربح'),
                tr('COGS / Refill Cost (LYD)', 'تكلفة المنتجات / التعبئة (د.ل)'),
                tr('Other OpEx (LYD)', 'المصاريف التشغيلية الأخرى (د.ل)'),
                tr('previous month', 'الشهر السابق'), tr('Net Profit (LYD)', 'صافي الربح (د.ل)'),
                tr('Exchange Rate (LYD per USD)', 'سعر الصرف (د.ل لكل دولار)'),
                tr('Net Profit (USD)', 'صافي الربح (دولار)'), tr('Investor Share (USD)', 'حصة المستثمر (دولار)'),
              ].map(label => <th scope="col" key={label} className="px-3 py-3 text-start font-medium">{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const shareColumn = `Investor Share ${Number(row.investor_share_percent)}% (USD)`;
              const month = row.source_cells.Month || row.month_start.slice(0, 7);
              const cells = [
                historicalCell(row, 'Profit', row.profit_lyd),
                historicalCell(row, 'COGS / Refill Cost (LYD)', row.cogs_refill_cost_lyd),
                historicalCell(row, 'Other OpEx (LYD)', row.other_opex_lyd),
                historicalCell(row, 'previous month', row.previous_month_lyd),
                historicalCell(row, 'Net Profit (LYD)', row.net_profit_lyd),
                historicalCell(row, 'Exchange Rate (LYD per USD)', row.exchange_rate_lyd_per_usd),
                historicalCell(row, 'Net Profit (USD)', row.net_profit_usd),
                historicalCell(row, shareColumn, row.investor_share_usd),
              ];
              return (
                <tr key={row.id} className="border-b border-slate-100 align-top">
                  <th scope="row" className="whitespace-nowrap px-3 py-3 text-start font-medium">{month}</th>
                  {cells.map((cell, index) => <td key={index} className="whitespace-nowrap px-3 py-3 tabular-nums" dir="ltr">
                    {cell}{index === 7 ? <span className="ms-2 text-xs text-slate-500">({Number(row.investor_share_percent)}%)</span> : null}
                  </td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {payments.confirmedCount > 0 && payments.validScope ? <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <caption className="mb-2 text-start font-semibold">{tr('Historical payment confirmations (USD)', 'تأكيدات الدفعات التاريخية (دولار)')}</caption>
          <thead><tr className="border-b border-slate-200">{[tr('Month', 'الشهر'), tr('Payable', 'المستحق'), tr('Paid', 'المدفوع'), tr('Still owed', 'المتبقي المستحق'), tr('Status / confirmed as of', 'الحالة / تاريخ التأكيد')].map(label => <th key={label} scope="col" className="px-3 py-3 text-start font-medium">{label}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => {
            const position = payments.positions[index];
            return <tr key={row.id} className="border-b border-slate-100">
              <th scope="row" className="px-3 py-3 text-start font-medium">{row.source_cells.Month || row.month_start.slice(0, 7)}</th>
              <td className="px-3 py-3" dir="ltr">{position.confirmed ? money(position.dueCents) : '—'}</td>
              <td className="px-3 py-3" dir="ltr">{position.confirmed ? money(position.paidCents) : '—'}</td>
              <td className="px-3 py-3 font-semibold" dir="ltr">{position.confirmed ? money(position.remainingCents) : '—'}</td>
              <td className="px-3 py-3"><span className="font-medium">{statusLabels[position.status]}</span>{position.confirmed ? <time className="mt-1 block text-xs text-slate-500" dateTime={position.confirmedAt}>{new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tripoli', year: 'numeric', month: 'short', day: '2-digit' }).format(new Date(position.confirmedAt))}</time> : null}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : null}
      <div className="mt-4 space-y-2 text-sm leading-6 text-slate-600">
        <p>{tr('Blank cells mean not supplied, not zero. “Profit” retains the source label; no sales or extra COGS deduction has been inferred.', 'الخانات الفارغة تعني غير مذكور، وليس صفراً. بقي عمود «الربح» كما ورد، دون افتراض مبيعات أو خصم تكلفة المنتجات مرة أخرى.')}</p>
        <p>{tr('A negative share is preserved as a source figure, not an amount the investor must repay. When a loss is already carried into the next month, do not subtract it again by summing the signed share column.', 'الحصة السالبة محفوظة كما وردت، وليست مبلغاً مطلوباً من المستثمر سداده. عندما تكون الخسارة مرحّلة للشهر التالي بالفعل، لا تُخصم مرة ثانية بجمع عمود الحصص بإشاراته.')}</p>
        <p>{tr('Imported history does not create contributions, payouts or Finance movements and is excluded from the current LYD entitlement totals.', 'استيراد السجل لا ينشئ رأس مال أو دفعات أو حركات مالية، ولا يدخل في إجمالي المستحقات الحالية بالدينار.')}</p>
        <p>{payments.confirmedCount > 0 ? tr('The payment position above records the owner’s confirmation as of the shown date. A later actual payment needs a separate recorded payout; this historical confirmation does not send or deduct money.', 'حالة الدفع أعلاه تسجل تأكيد المالك حتى التاريخ الموضح. أي دفعة فعلية لاحقة تحتاج إلى تسجيل مستقل؛ هذا التأكيد التاريخي لا يرسل أو يخصم أموالاً.') : tr('Past payments and agreement terms must be verified before treating any USD amount as payable.', 'يجب التحقق من الدفعات السابقة وشروط الاتفاق قبل اعتبار أي مبلغ بالدولار مستحق الدفع.')}</p>
      </div>
    </section>
  );
}
