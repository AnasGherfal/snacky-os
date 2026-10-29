import { randomUUID } from "node:crypto";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { recordActualInvestorUsdPayout, saveInvestorMonthlyFxRate } from "@/lib/investor-portal-actions";

type Props = {
  agreementId: string;
  investorUserId: string;
  investorName?: string;
  sharePercent?: number | string;
  startDate?: string;
  endDate?: string | null;
  investmentUsd?: number | string | null;
  capUsd?: number | string | null;
  ar: boolean;
  admin?: boolean;
};
type Historical = {
  month_start: string;
  profit_lyd: number | string | null;
  other_opex_lyd: number | string | null;
  net_profit_lyd: number | string | null;
  exchange_rate_lyd_per_usd: number | string | null;
  confirmed_payable_usd: number | string | null;
  confirmed_paid_usd: number | string | null;
  payment_confirmed_at: string | null;
};
type Statement = {
  month_start: string;
  revenue_lyd: number | string;
  cogs_lyd: number | string;
  operating_expenses_lyd: number | string;
  operating_profit_lyd: number | string;
  investor_share_due_usd: number | string | null;
  investor_share_due_lyd: number | string;
  calculation_status: string;
  source_complete: boolean;
  expense_breakdown: Array<{ key: string; label: string; amount: number }> | null;
};
type Payout = { id: string; month_start: string; payout_date: string; amount_usd: number | string; payment_reference: string; finance_transaction_id: string };
type Fx = { month_start: string; lyd_per_usd: number | string; rate_source: string | null };
const amount = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const usd = (value: number) => "$" + amount(value);
const lyd = (value: number) => amount(value) + " LYD";
const asNumber = (value: number | string | null | undefined) => Number(value ?? 0);
const monthLabel = (month: string, ar: boolean) =>
  new Intl.DateTimeFormat(ar ? "ar-LY" : "en-US", { year: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(month + "T12:00:00Z"));
const tripoliToday = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export async function InvestorYearOverview({
  agreementId, investorUserId, investorName, sharePercent, startDate = "2026-01-01",
  endDate, investmentUsd, capUsd, ar, admin = false,
}: Props) {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return <p role="alert" className="surface-card text-rose-800">{tr("Investor records are temporarily unavailable.", "سجل المستثمر غير متاح حالياً.")}</p>;

  // This component is for USD-denominated agreements only. Never invent an FX conversion.
  if (capUsd == null) return null;
  const [historyResult, statementResult, payoutResult, fxResult] = await Promise.all([
    db.from("investor_historical_months")
      .select("month_start,profit_lyd,other_opex_lyd,net_profit_lyd,exchange_rate_lyd_per_usd,confirmed_payable_usd,confirmed_paid_usd,payment_confirmed_at")
      .eq("investor_user_id", investorUserId).gte("month_start", startDate).order("month_start", { ascending: false }),
    (admin
      ? db.from("investor_monthly_statements").select("month_start,revenue_lyd,cogs_lyd,operating_expenses_lyd,operating_profit_lyd,investor_share_due_usd,investor_share_due_lyd,calculation_status,source_complete,expense_breakdown")
      : db.from("investor_monthly_statements").select("month_start,revenue_lyd,cogs_lyd,operating_expenses_lyd,operating_profit_lyd,investor_share_due_usd,investor_share_due_lyd,calculation_status,source_complete,expense_breakdown").eq("calculation_status", "finalized"))
      .eq("agreement_id", agreementId).gte("month_start", startDate).order("month_start", { ascending: false }),
    db.from("investor_usd_payouts").select("id,month_start,payout_date,amount_usd,payment_reference,finance_transaction_id")
      .eq("agreement_id", agreementId).order("payout_date", { ascending: false }),
    admin
      ? db.from("investor_monthly_fx_rates").select("month_start,lyd_per_usd,rate_source").eq("agreement_id", agreementId)
      : Promise.resolve({ data: [] as Fx[], error: null }),
  ]);
  if (historyResult.error || statementResult.error || payoutResult.error || fxResult.error)
    return <p role="alert" className="surface-card text-rose-800">{tr("The USD ledger could not be verified. No amounts have been assumed. Reload or contact Snacky management.", "تعذر التحقق من كشف الدولار. لم نفترض أي مبالغ. أعد التحميل أو تواصل مع إدارة سناكي.")}</p>;

  const historic = (historyResult.data ?? [] as Historical[]).filter(h => !endDate || h.month_start <= endDate) as Historical[];
  const statements = (statementResult.data ?? [] as Statement[]).filter(s => !endDate || s.month_start <= endDate) as Statement[];
  const payouts = (payoutResult.data ?? []) as Payout[];
  const rates = new Map(((fxResult.data ?? []) as Fx[]).map(r => [r.month_start, r]));
  const historyByMonth = new Map(historic.map(row => [row.month_start, row]));
  const statementByMonth = new Map(statements.map(row => [row.month_start, row]));
  const payoutByMonth = new Map<string, number>();
  for (const p of payouts) payoutByMonth.set(p.month_start, (payoutByMonth.get(p.month_start) ?? 0) + asNumber(p.amount_usd));
  const overlap = historic.some(h => statementByMonth.has(h.month_start));
  const unconfirmedHistory = historic.some(h => !h.payment_confirmed_at || h.confirmed_payable_usd == null || h.confirmed_paid_usd == null);
  const invalidFinal = statements.some(s => s.calculation_status === "finalized" && s.investor_share_due_usd == null);
  // Historical paid balances are updated by the atomic USD payout RPC. Counting the payout rows again would double-count them.
  const verifiedHistoric = historic.filter(h => h.payment_confirmed_at && h.confirmed_payable_usd != null && h.confirmed_paid_usd != null);
  const dueHistoric = verifiedHistoric.reduce((sum, h) => sum + asNumber(h.confirmed_payable_usd), 0);
  const paidHistoric = verifiedHistoric.reduce((sum, h) => sum + asNumber(h.confirmed_paid_usd), 0);
  const finalized = statements.filter(s => s.calculation_status === "finalized" && !historyByMonth.has(s.month_start) && s.investor_share_due_usd != null);
  const dueCurrent = finalized.reduce((sum, s) => sum + asNumber(s.investor_share_due_usd), 0);
  const paidCurrent = payouts.filter(p => !historyByMonth.has(p.month_start)).reduce((sum, p) => sum + asNumber(p.amount_usd), 0);
  const earned = dueHistoric + dueCurrent;
  const paid = paidHistoric + paidCurrent;
  const cap = asNumber(capUsd), incomplete = unconfirmedHistory || invalidFinal || overlap;
  const months = [...new Set([...historic.map(h => h.month_start), ...statements.map(s => s.month_start)])].sort().reverse();
  const status = (due: number, paidValue: number, draft: boolean, verified: boolean) =>
    !verified ? tr("Not verified", "غير معتمد")
    : draft ? tr("Draft · not payable", "مسودة · غير مستحقة")
    : due <= 0 ? tr("No payout due", "لا يوجد مستحق")
    : paidValue >= due - .005 ? tr("Paid", "مدفوع")
    : paidValue > 0 ? tr("Partly paid", "مدفوع جزئياً")
    : tr("Unpaid", "غير مدفوع");

  return <section className="surface-card space-y-5" dir={ar ? "rtl" : "ltr"} aria-label={tr("USD investment ledger", "كشف الاستثمار بالدولار")}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">{tr("USD profit-sharing ledger", "كشف تقاسم الأرباح بالدولار")}</p>
        <h2 className="mt-1 text-xl font-bold text-slate-950">{investorName || tr("Investment overview", "نظرة عامة على الاستثمار")}</h2>
        <p className="mt-1 text-sm text-slate-600">{tr("Only confirmed historical shares and finalized months are payable. Recorded USD transfers are shown separately from operating results.", "المستحقات التاريخية المؤكدة والأشهر المعتمدة فقط قابلة للدفع. تظهر دفعات الدولار الفعلية منفصلة عن نتائج التشغيل.")}</p>
      </div>
      {sharePercent != null ? <span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-900">{sharePercent}% {tr("agreed share", "نسبة الاتفاق")}</span> : null}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[
        [tr("Agreed investment", "الاستثمار المتفق عليه"), investmentUsd == null ? "—" : usd(asNumber(investmentUsd))],
        [tr("Contractual payout cap", "سقف التوزيعات بالعقد"), usd(cap)],
        [tr("Confirmed entitlement", "المستحق المعتمد"), incomplete ? usd(earned) + " *" : usd(earned)],
        [tr("Confirmed unpaid", "المستحق غير المدفوع"), incomplete ? "—" : usd(Math.max(0, earned - paid))],
      ].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <p className="text-xs text-slate-600">{label}</p><strong className="mt-2 block text-xl tabular-nums text-slate-950">{value}</strong>
      </div>)}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4 text-sm">
      <span className="text-slate-600">{tr("Recorded actual USD payouts", "توزيعات الدولار المدفوعة فعلياً")}</span>
      <strong className="text-lg tabular-nums">{usd(paid)}</strong>
      <span className="w-full text-xs text-slate-500">{tr("Contract amounts are in USD. No arbitrary LYD exchange rate is applied.", "المبالغ التعاقدية بالدولار. لا نستخدم سعر صرف افتراضياً للتحويل إلى الدينار.")}</span>
    </div>
    {incomplete ? <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      {tr("Some historical payment confirmations or USD statement values are missing, or a month overlaps two sources. Confirm them before relying on the total unpaid position. Displayed earnings include verified records only.", "تنقص بعض تأكيدات الدفع التاريخية أو قيم الدولار، أو يوجد شهر مكرر بين مصدرين. راجعها قبل الاعتماد على إجمالي غير المدفوع. المبالغ الظاهرة تشمل السجلات المتحقق منها فقط.")}
    </p> : null}
    {admin ? <details className="rounded-xl border border-slate-200 p-4">
      <summary className="cursor-pointer font-semibold">{tr("Manage documented monthly FX rates", "إدارة أسعار الصرف الشهرية الموثقة")}</summary>
      <p className="mt-2 text-sm text-slate-600">{tr("Enter a real dated rate for the selected month. Saving a rate never moves or records money.", "أدخل سعر الصرف الفعلي للشهر. حفظ السعر لا يحرّك الأموال ولا يسجل دفعة.")}</p>
      <form action={saveInvestorMonthlyFxRate} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="agreement_id" value={agreementId} />
        <label className="text-sm">{tr("Month", "الشهر")}<input className="field-input mt-1" name="month_start" type="month" defaultValue={tripoliToday().slice(0, 7)} required /></label>
        <label className="text-sm">{tr("LYD per USD", "د.ل لكل دولار")}<input className="field-input mt-1" name="lyd_per_usd" type="number" min="0.000001" step="0.000001" required /></label>
        <label className="text-sm">{tr("Evidence / source", "المصدر أو الإثبات")}<input className="field-input mt-1" name="rate_source" maxLength={500} /></label>
        <button type="submit" className="btn-secondary self-end">{tr("Save rate", "حفظ السعر")}</button>
      </form>
    </details> : null}
    <div>
      <h3 className="text-lg font-semibold">{tr("Monthly statements", "الكشوف الشهرية")}</h3>
      <p className="mt-1 text-sm text-slate-600">{tr("Open a month for its accounting breakdown and actual transfer records.", "افتح أي شهر لمراجعة الحسابات وحركات الدفع المسجلة.")}</p>
    </div>
    {months.length ? <div className="space-y-3">
      {months.map(month => {
        const h = historyByMonth.get(month), s = statementByMonth.get(month);
        const verified = h ? Boolean(h.payment_confirmed_at && h.confirmed_payable_usd != null && h.confirmed_paid_usd != null)
          : Boolean(s && s.calculation_status === "finalized" && s.investor_share_due_usd != null);
        const draft = Boolean(!h && s?.calculation_status !== "finalized");
        const monthDue = h ? asNumber(h.confirmed_payable_usd) : asNumber(s?.investor_share_due_usd);
        const monthPaid = h ? asNumber(h.confirmed_paid_usd) : payoutByMonth.get(month) ?? 0;
        const monthPayouts = payouts.filter(p => p.month_start === month);
        const canPay = admin && verified && !draft && monthDue - monthPaid > .005 && month >= startDate && (!endDate || month <= endDate) && !overlap;
        const currentRate = rates.get(month);
        return <details key={month} className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
            <span className="font-semibold text-slate-900">{monthLabel(month, ar)} <span className="ms-2 text-xs font-normal text-slate-500">{h ? tr("Imported history", "سجل تاريخي") : s?.calculation_status === "finalized" ? tr("Finalized", "معتمد") : tr("Owner draft", "مسودة الإدارة")}</span></span>
            <span className="text-sm text-slate-600">{status(monthDue, monthPaid, draft, verified)} · <strong className="tabular-nums text-slate-900">{verified ? usd(monthDue) : "—"}</strong></span>
          </summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              [tr("Net operating result (LYD)", "نتيجة التشغيل (د.ل)"), h?.net_profit_lyd ?? s?.operating_profit_lyd, "LYD"],
              [tr("Approved share (USD)", "الحصة المعتمدة ($)"), verified ? monthDue : null, "USD"],
              [tr("Paid to date (USD)", "المدفوع حتى الآن ($)"), verified ? monthPaid : null, "USD"],
            ].map(([label, value, currency]) => <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-600">{label}</p><strong className="mt-1 block tabular-nums">{value == null ? "—" : currency === "USD" ? usd(Number(value)) : lyd(Number(value))}</strong>
            </div>)}
          </div>
          {s ? <div className="mt-3 text-sm text-slate-600">
            <p>{tr("Sales", "المبيعات")}: {lyd(asNumber(s.revenue_lyd))} · {tr("Product cost", "تكلفة المنتجات")}: {lyd(asNumber(s.cogs_lyd))} · {tr("Operating expenses", "مصاريف التشغيل")}: {lyd(asNumber(s.operating_expenses_lyd))}</p>
            {s.expense_breakdown?.length ? <details className="mt-3 rounded-lg border border-slate-100 p-3"><summary className="cursor-pointer font-medium">{tr("Recorded expense breakdown", "تفاصيل المصاريف المسجلة")}</summary>
              <div className="mt-2 space-y-2">{s.expense_breakdown.map((row, i) => <div key={i} className="flex flex-wrap justify-between gap-2 border-t border-slate-100 pt-2"><span>{row.label}</span><span>{lyd(asNumber(row.amount))}</span></div>)}</div>
            </details> : null}
            {admin && s.calculation_status !== "finalized" ? <p className="mt-2 text-amber-800">{tr("Owner draft — review and finalize in Monthly profit review before it becomes payable.", "مسودة إدارة — راجعها واعتمدها من مراجعة الأرباح الشهرية قبل استحقاق الدفع.")}</p> : null}
          </div> : null}
          {h && !verified ? <p className="mt-3 text-sm text-amber-800">{tr("Historical entitlement or settlement has not been confirmed.", "لم يُعتمد المستحق التاريخي أو حالة دفعه.")}</p> : null}
          {monthPayouts.length ? <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">{monthPayouts.map(p =>
            <p key={p.id}>{p.payout_date} · {usd(asNumber(p.amount_usd))} · {p.payment_reference}</p>)}</div> : null}
          {canPay ? <details className="mt-4 rounded-lg border border-emerald-200 p-3">
            <summary className="cursor-pointer font-semibold text-emerald-800">{tr("Record an already completed USD payout", "تسجيل دفعة دولار تمت بالفعل")}</summary>
            <p className="mt-2 text-xs text-slate-600">{tr("This does not initiate a bank transfer. It posts a real past payout to Finance.", "هذا الإجراء لا ينفذ حوالة مصرفية؛ بل يسجل دفعة تمت سابقاً في المالية.")}</p>
            <form action={recordActualInvestorUsdPayout} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="agreement_id" value={agreementId} />
              <input type="hidden" name="month_start" value={month} />
              <input type="hidden" name="client_submission_id" value={randomUUID()} />
              <label className="text-sm">{tr("USD amount actually paid", "المبلغ المدفوع فعلياً بالدولار")}<input className="field-input mt-1" name="amount_usd" type="number" min="0.01" step="0.01" max={(monthDue - monthPaid).toFixed(2)} defaultValue={(monthDue - monthPaid).toFixed(2)} required /></label>
              <label className="text-sm">{tr("Actual payment date", "تاريخ الدفع الفعلي")}<input className="field-input mt-1" name="payout_date" type="date" max={tripoliToday()} defaultValue={tripoliToday()} required /></label>
              <label className="text-sm">{tr("LYD per USD on payment date", "سعر الدينار للدولار يوم الدفع")}<input className="field-input mt-1" name="lyd_per_usd" type="number" min="0.000001" step="0.000001" defaultValue={currentRate ? String(currentRate.lyd_per_usd) : ""} required /></label>
              <label className="text-sm">{tr("Transfer / cash receipt reference", "مرجع الحوالة أو وصل الدفع")}<input className="field-input mt-1" name="payment_reference" minLength={3} maxLength={200} required /></label>
              <label className="text-sm">{tr("Account used", "الحساب المستخدم")}<select className="field-input mt-1" name="payment_account"><option value="snacky_usd">Snacky USD</option><option value="owner_usd">{tr("Owner USD", "دولار المالك")}</option></select></label>
              <label className="text-sm">{tr("Method", "طريقة الدفع")}<select className="field-input mt-1" name="payment_method"><option value="bank_transfer">{tr("Bank transfer", "حوالة مصرفية")}</option><option value="cash">{tr("Cash", "نقداً")}</option><option value="other">{tr("Other", "أخرى")}</option></select></label>
              <label className="text-sm sm:col-span-2">{tr("Note (optional)", "ملاحظة (اختياري)")}<textarea className="field-input mt-1" name="notes" maxLength={2000} rows={2} /></label>
              <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="confirm_actual_paid" value="yes" required /><span>{tr("I confirm that this money was actually paid, and I have checked the payment history to avoid duplication.", "أؤكد أن هذا المبلغ دُفع فعلياً وأنني راجعت السجل لمنع تكراره.")}</span></label>
              <button className="btn-primary sm:col-span-2" type="submit">{tr("Record verified USD payout", "تسجيل دفعة الدولار المؤكدة")}</button>
            </form>
          </details> : null}
        </details>;
      })}
    </div> : <p className="rounded-xl border border-dashed border-slate-200 p-5 text-sm text-slate-600">{tr("No confirmed monthly statements are available for this agreement yet.", "لا توجد كشوف شهرية معتمدة لهذه الاتفاقية بعد.")}</p>}
    <p className="text-xs text-slate-500">{tr("This ledger is based on saved records only. Drafts, missing historical confirmations and unentered expenses are not treated as payable profit. Historical records outside the agreement period remain in the separate archive below.", "يعتمد هذا الكشف على السجلات المحفوظة فقط. المسودات والتأكيدات الناقصة والمصاريف غير المسجلة لا تُعد أرباحاً مستحقة. السجل التاريخي خارج فترة الاتفاق يبقى في الأرشيف المنفصل أدناه.")}</p>
  </section>;
}
