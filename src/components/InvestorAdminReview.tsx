import { InvestorAdminMonthSwitcher } from "@/components/InvestorAdminMonthSwitcher";
import { finalizeInvestorStatement, generateInvestorStatement } from "@/lib/investor-actions";
import type { InvestorStatementRecord } from "@/components/InvestorStatementCard";
import { formatFinanceMoney } from "@/lib/finance-balance";

type Props = {
  ar: boolean;
  agreementId: string;
  month: string;
  availableMonths: string[];
  statement: InvestorStatementRecord | null;
  canReview: boolean;
};

export function InvestorAdminReview({
  ar, agreementId, month, availableMonths, statement, canReview,
}: Props) {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const finalized = statement?.calculation_status === "finalized";
  const ready = statement?.source_complete === true;
  const amount = (value: unknown) =>
    value == null || !Number.isFinite(Number(value)) ? "—" : formatFinanceMoney(Number(value));

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="text-lg font-bold text-slate-950">{tr("Monthly review", "مراجعة أرباح الشهر")}</h3>
        <p className="mt-1 text-sm text-slate-500">
          {tr("Check one month, then approve its share. No money moves when you approve.",
            "راجع شهراً واحداً ثم اعتمد حصته. الاعتماد لا ينفّذ أي دفع.")}
        </p>
      </div>
      <InvestorAdminMonthSwitcher ar={ar} agreementId={agreementId} month={month} months={availableMonths} />
    </div>

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div>
        <p className="font-semibold text-slate-900">{month}</p>
        <p className="mt-1 text-xs text-slate-600">
          {finalized ? tr("This month is approved and locked.", "هذا الشهر معتمد ومقفل.")
            : tr("Refresh from Snacky sales and Finance records before approval.", "حدّث الحساب من المبيعات والمالية قبل اعتماد الشهر.")}
        </p>
      </div>
      {!finalized ? <form action={generateInvestorStatement}>
        <input type="hidden" name="agreement_id" value={agreementId}/>
        <input type="hidden" name="month" value={month}/>
        <button className="btn-secondary" type="submit" disabled={!canReview}>
          {tr(statement ? "Refresh figures" : "Calculate month", statement ? "تحديث الأرقام" : "حساب الشهر")}
        </button>
      </form> : <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
        {tr("Approved", "معتمد")}
      </span>}
    </div>

    {statement ? <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          [tr("Sales", "المبيعات"), statement.revenue_lyd],
          [tr("Products sold", "تكلفة المنتجات"), statement.cogs_lyd],
          [tr("Operating costs", "مصاريف التشغيل"), statement.operating_expenses_lyd],
          [tr("Investor share", "حصة المستثمر"), statement.investor_share_due_lyd],
        ].map(([label, value], index) => <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <p className="text-xs text-slate-500">{String(label)}</p>
          <strong dir="ltr" className={`mt-2 block text-lg tabular-nums ${index === 3 ? "text-emerald-800" : "text-slate-950"}`}>
            {amount(value)}
          </strong>
          <span className="text-[11px] text-slate-500">LYD</span>
        </div>)}
      </div>
      {!finalized && ready ? <form action={finalizeInvestorStatement} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <input type="hidden" name="agreement_id" value={agreementId}/>
        <input type="hidden" name="statement_id" value={statement.id}/>
        <input type="hidden" name="generated_at" value={statement.generated_at}/>
        <input type="hidden" name="review_month" value={month}/>
        {["sales", "rent_payroll", "expenses", "capital"].map(key =>
          <input key={key} type="hidden" name={`review_${key}`} value="yes"/>)}
        <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-700">
          <input type="checkbox" required className="mt-1 size-4 shrink-0"/>
          <span>{tr("I checked this month's sales, product costs, rent, payroll, other expenses and machine purchases against the recorded sources.",
            "راجعت مبيعات الشهر وتكلفة المنتجات والإيجارات والمرتبات والمصاريف ومشتريات الماكينات مقابل السجلات.")}</span>
        </label>
        <button type="submit" className="btn-primary">
          {tr("Approve this month", "اعتماد هذا الشهر")}
        </button>
      </form> : null}
      {!finalized && !ready ? <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        {tr("This saved calculation still has incomplete source checks. Review the source evidence, correct the underlying records, and refresh it before approval.",
          "توجد مصادر لم تكتمل مطابقتها لهذا الحساب المحفوظ. راجع الأدلة وصحّح السجلات الأصلية ثم حدّث الحساب قبل الاعتماد.")}
      </p> : null}

      <details className="rounded-xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">
          {tr("View recorded expense details", "عرض تفاصيل المصاريف")}
        </summary>
        <div className="mt-4 divide-y divide-slate-100 text-sm">
          {statement.expense_breakdown?.length ?
            statement.expense_breakdown.map((item, index) => <div key={item.key + index}
              className="flex items-start justify-between gap-4 py-2">
              <span className="text-slate-600">{item.label}</span>
              <span className="shrink-0 font-semibold tabular-nums">{amount(item.amount)} LYD</span>
            </div>) : <p className="py-2 text-slate-500">
              {tr("No itemized expenses in this saved calculation.", "لا توجد مصاريف مفصّلة في هذا الحساب المحفوظ.")}
            </p>}
        </div>
      </details>
    </> : <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
      {tr("No saved calculation for this month. Select Calculate month to load the recorded figures.",
        "لا يوجد حساب محفوظ لهذا الشهر. اضغط «حساب الشهر» لقراءة الأرقام المسجلة.")}
    </p>}
  </div>;
}
