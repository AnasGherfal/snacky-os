import { historicalCell, type InvestorHistoricalMonth } from '@/lib/investor-history';

export function InvestorHistoryTable({ rows, investorName, ar }: {
  rows: InvestorHistoricalMonth[];
  investorName: string;
  ar: boolean;
}) {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  return (
    <section className="surface-card min-w-0" dir={ar ? 'rtl' : 'ltr'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-950">{investorName}</h3>
          <p className="mt-1 text-xs text-slate-600">{tr('Owner-supplied historical figures · original signs, blanks and rounding preserved', 'أرقام تاريخية قدّمها المالك · الإشارات والخانات الفارغة والتقريب كما وردت')}</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium">{tr('Historical record — payment status not supplied', 'سجل تاريخي — حالة الدفع غير مذكورة')}</span>
      </div>
      <div className="mt-4 max-w-full overflow-x-auto" tabIndex={0} role="region" aria-label={tr('Historical investor figures', 'الأرقام التاريخية للمستثمر')}>
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <caption className="sr-only">{tr('Original monthly table. These are not new Finance transactions or confirmed unpaid entitlements.', 'الجدول الشهري الأصلي. هذه ليست حركات مالية جديدة أو مستحقات مؤكدة غير مدفوعة.')}</caption>
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
      <div className="mt-4 space-y-2 text-sm leading-6 text-slate-600">
        <p>{tr('Blank cells mean not supplied, not zero. “Profit” retains the source label; no sales or extra COGS deduction has been inferred.', 'الخانات الفارغة تعني غير مذكور، وليس صفراً. بقي عمود «الربح» كما ورد، دون افتراض مبيعات أو خصم تكلفة المنتجات مرة أخرى.')}</p>
        <p>{tr('A negative share is preserved as a source figure, not an amount the investor must repay. When a loss is already carried into the next month, do not subtract it again by summing the signed share column.', 'الحصة السالبة محفوظة كما وردت، وليست مبلغاً مطلوباً من المستثمر سداده. عندما تكون الخسارة مرحّلة للشهر التالي بالفعل، لا تُخصم مرة ثانية بجمع عمود الحصص بإشاراته.')}</p>
        <p>{tr('Imported history does not create contributions, payouts or Finance movements and is excluded from the current LYD entitlement totals. Past payments and agreement terms must be verified before treating any USD amount as payable.', 'استيراد السجل لا ينشئ رأس مال أو دفعات أو حركات مالية، ولا يدخل في إجمالي المستحقات الحالية بالدينار. يجب التحقق من الدفعات السابقة وشروط الاتفاق قبل اعتبار أي مبلغ بالدولار مستحق الدفع.')}</p>
      </div>
    </section>
  );
}
