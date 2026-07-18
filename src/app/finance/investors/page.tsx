/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChartCard, TrendChart } from "@/components/DecisionCharts";
import { DataTable, EmptyState, FormField, FormSection, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { formatFinanceMoney } from "@/lib/finance-balance";
import { updateInvestorAgreement } from "@/lib/investor-agreement-actions";
import { createInvestorAgreement, finalizeInvestorStatement, generateInvestorStatement, recordInvestorPayment } from "@/lib/investor-actions";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type Agreement = {
  id: string;
  investor_user_id: string | null;
  investor_name: string;
  investment_amount_lyd: number | string;
  profit_share_percent: number | string;
  start_date: string;
  end_date: string | null;
  payout_cap_lyd: number | string | null;
  status: string;
  notes: string | null;
};

type Statement = {
  id: string;
  agreement_id: string;
  month_start: string;
  revenue_lyd: number | string;
  cogs_lyd: number | string;
  gross_profit_lyd: number | string;
  operating_expenses_lyd: number | string;
  operating_profit_lyd: number | string;
  share_percent: number | string;
  investor_share_due_lyd: number | string;
  calculation_status: string;
  data_source_note: string | null;
  finalized_at: string | null;
};

type Payment = {
  id: string;
  agreement_id: string;
  statement_id: string | null;
  payment_date: string;
  amount_lyd: number | string;
  payment_reference: string | null;
  notes: string | null;
  finance_posting_status: string;
  finance_posting_error: string | null;
};

type InvestorProfile = { id: string; full_name: string; email: string | null; role: string; roles: string[] | null; active_status: string };

function numeric(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function previousMonthValue() {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return previous.toISOString().slice(0, 7);
}

function monthLabel(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
}

function noticeClass(type: "success" | "error" | "warning") {
  if (type === "success") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (type === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

export default async function InvestorsPage({ searchParams }: { searchParams: Promise<{ agreement?: string; success?: string; error?: string; warning?: string }> }) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const params = await searchParams;
  if (!supabase) redirect("/finance?error=Supabase%20is%20not%20configured.");

  const [agreementsResult, statementsResult, paymentsResult, profilesResult] = await Promise.all([
    supabase.from("investor_agreements").select("*").order("start_date", { ascending: false }),
    supabase.from("investor_monthly_statements").select("*").order("month_start", { ascending: true }),
    supabase.from("investor_payments").select("*").order("payment_date", { ascending: false }),
    supabase.from("profiles").select("id, full_name, email, role, roles, active_status").eq("active_status", "active").order("full_name"),
  ]);

  const migrationMissing = agreementsResult.error && `${agreementsResult.error.code ?? ""} ${agreementsResult.error.message ?? ""}`.toLowerCase().includes("investor_agreements");
  if (migrationMissing) {
    return <EmptyState title={ar ? "يلزم تثبيت وحدة المستثمر" : "Investor module setup required"} body={ar ? "شغّل ملف 202607180003_growth_decisions_investor_portal.sql في Supabase." : "Run 202607180003_growth_decisions_investor_portal.sql in Supabase."} />;
  }

  const agreements = (agreementsResult.data ?? []) as Agreement[];
  const statements = (statementsResult.data ?? []) as Statement[];
  const payments = (paymentsResult.data ?? []) as Payment[];
  const investorProfiles = ((profilesResult.data ?? []) as InvestorProfile[]).filter((candidate) => candidate.role === "investor" || (candidate.roles ?? []).includes("investor"));
  const selected = agreements.find((agreement) => agreement.id === params.agreement) ?? agreements[0] ?? null;
  const selectedStatements = selected ? statements.filter((statement) => statement.agreement_id === selected.id) : [];
  const selectedPayments = selected ? payments.filter((payment) => payment.agreement_id === selected.id) : [];
  const totalDue = selectedStatements.filter((row) => row.calculation_status === "finalized").reduce((sum, row) => sum + numeric(row.investor_share_due_lyd), 0);
  const totalPaid = selectedPayments.reduce((sum, row) => sum + numeric(row.amount_lyd), 0);
  const unpaid = Math.max(0, totalDue - totalPaid);
  const paymentsByStatement = new Map<string, number>();
  selectedPayments.forEach((payment) => {
    if (!payment.statement_id) return;
    paymentsByStatement.set(payment.statement_id, (paymentsByStatement.get(payment.statement_id) ?? 0) + numeric(payment.amount_lyd));
  });
  const chartStatements = selectedStatements.filter((row) => row.calculation_status === "finalized");
  const notice = params.error
    ? { type: "error" as const, text: params.error }
    : params.warning
      ? { type: "warning" as const, text: params.warning }
      : params.success
        ? { type: "success" as const, text: params.success }
        : null;

  return (
    <>
      <PageHeader
        title={ar ? "المستثمرون" : "Investors"}
        subtitle={ar ? "اتفاقيات المستثمر، الربح الشهري، نسبة 30%، الدفعات، والرصيد غير المدفوع." : "Investor agreements, monthly operating profit, profit share, payments, and unpaid balance."}
        action={<Link href="/team/new" className="btn-secondary">{ar ? "إنشاء دخول مستثمر" : "Create investor login"}</Link>}
      />

      <div className="space-y-6">
        {notice ? <div className={`rounded-xl border p-4 text-sm font-medium ${noticeClass(notice.type)}`}>{notice.text}</div> : null}
        {(agreementsResult.error || statementsResult.error || paymentsResult.error) && !migrationMissing ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{ar ? "تعذر تحميل جزء من بيانات المستثمر. راجع Supabase أو الصلاحيات." : "Some investor data could not load. Check Supabase schema and permissions."}</div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <section className="surface-card">
              <h2 className="font-semibold text-slate-950">{ar ? "الاتفاقيات" : "Agreements"}</h2>
              <div className="mt-3 space-y-2">
                {agreements.map((agreement) => (
                  <Link key={agreement.id} href={`/finance/investors?agreement=${agreement.id}`} className={`block rounded-xl border p-3 ${selected?.id === agreement.id ? "border-sky-300 bg-sky-50" : "border-slate-200 hover:bg-slate-50"}`}>
                    <div className="flex items-center justify-between gap-2"><span className="font-semibold text-slate-900">{agreement.investor_name}</span><StatusBadge status={agreement.status} /></div>
                    <div className="mt-1 text-xs text-slate-500">{numeric(agreement.profit_share_percent)}% · {agreement.start_date}</div>
                  </Link>
                ))}
                {!agreements.length ? <p className="text-sm text-slate-500">{ar ? "لا توجد اتفاقيات بعد." : "No agreements yet."}</p> : null}
              </div>
            </section>

            <FormSection title={ar ? "اتفاقية جديدة" : "New agreement"} description={ar ? "أنشئ حساباً بدور مستثمر أولاً ثم اربطه هنا." : "Create a Team login with the Investor role first, then link it here."}>
              <form action={createInvestorAgreement} className="space-y-3">
                <FormField label={ar ? "حساب المستثمر" : "Investor login"} required>
                  <select name="investor_user_id" className="field-input" required defaultValue="">
                    <option value="">{ar ? "اختر الحساب" : "Select account"}</option>
                    {investorProfiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.full_name} {candidate.email ? `— ${candidate.email}` : ""}</option>)}
                  </select>
                </FormField>
                <FormField label={ar ? "اسم المستثمر" : "Investor name"} required><input name="investor_name" className="field-input" required /></FormField>
                <FormField label={ar ? "قيمة الاستثمار" : "Investment amount (LYD)"}><input name="investment_amount_lyd" type="number" min="0" step="0.01" className="field-input" defaultValue="0" /></FormField>
                <FormField label={ar ? "نسبة الربح" : "Profit share %"}><input name="profit_share_percent" type="number" min="0" max="100" step="0.01" className="field-input" defaultValue="30" /></FormField>
                <FormField label={ar ? "تاريخ البداية" : "Start date"} required><input name="start_date" type="date" className="field-input" required /></FormField>
                <FormField label={ar ? "تاريخ النهاية اختياري" : "End date (optional)"}><input name="end_date" type="date" className="field-input" /></FormField>
                <FormField label={ar ? "حد إجمالي الدفعات اختياري" : "Payout cap (optional)"}><input name="payout_cap_lyd" type="number" min="0" step="0.01" className="field-input" /></FormField>
                <input type="hidden" name="status" value="active" />
                <button className="btn-primary w-full" disabled={!investorProfiles.length}>{ar ? "إنشاء الاتفاقية" : "Create agreement"}</button>
              </form>
              {!investorProfiles.length ? <Link href="/team/new" className="mt-3 block text-sm font-semibold text-sky-700">{ar ? "أنشئ حساب المستثمر أولاً" : "Create the investor login first"}</Link> : null}
            </FormSection>
          </div>

          {!selected ? (
            <EmptyState title={ar ? "أضف أول مستثمر" : "Add the first investor"} body={ar ? "بعد إنشاء الاتفاقية ستظهر البيانات الشهرية والدفعات هنا." : "Monthly statements and payments will appear after an agreement is created."} />
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  [ar ? "قيمة الاستثمار" : "Investment", numeric(selected.investment_amount_lyd)],
                  [ar ? "إجمالي المستحق" : "Finalized due", totalDue],
                  [ar ? "إجمالي المدفوع" : "Paid", totalPaid],
                  [ar ? "غير مدفوع" : "Unpaid", unpaid],
                ].map(([label, value]) => <div key={String(label)} className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{String(label)}</div><div className="mt-2 text-2xl font-semibold">{formatFinanceMoney(Number(value))}</div></div>)}
              </div>

              <ChartCard title={ar ? "الربح والمستحق والمدفوع شهرياً" : "Monthly profit, investor due, and paid"} subtitle={ar ? "تظهر فقط البيانات الشهرية المعتمدة للمستثمر." : "Only finalized monthly statements are included."}>
                <TrendChart
                  labels={chartStatements.map((statement) => monthLabel(statement.month_start, locale))}
                  series={[
                    { key: "profit", label: ar ? "الربح التشغيلي" : "Operating profit", values: chartStatements.map((statement) => numeric(statement.operating_profit_lyd)) },
                    { key: "due", label: ar ? "مستحق المستثمر" : "Investor due", values: chartStatements.map((statement) => numeric(statement.investor_share_due_lyd)) },
                    { key: "paid", label: ar ? "المدفوع" : "Paid", values: chartStatements.map((statement) => paymentsByStatement.get(statement.id) ?? 0) },
                  ]}
                  valueFormatter={(value) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}
                />
              </ChartCard>

              <div className="grid gap-6 xl:grid-cols-2">
                <FormSection title={ar ? "إعداد بيان شهري" : "Generate monthly statement"} description={ar ? "الربح التشغيلي = مبيعات VMS ناقص تكلفة المنتجات والمصاريف التشغيلية. الدفعات للمستثمر لا تُخصم من الربح." : "Operating profit equals VMS gross profit minus operating expenses. Investor distributions are not deducted from the profit basis."}>
                  <form action={generateInvestorStatement} className="space-y-4">
                    <input type="hidden" name="agreement_id" value={selected.id} />
                    <FormField label={ar ? "الشهر" : "Month"} required><input name="month" type="month" className="field-input" defaultValue={previousMonthValue()} required /></FormField>
                    <button className="btn-primary w-full">{ar ? "حساب مسودة الشهر" : "Calculate monthly draft"}</button>
                  </form>
                </FormSection>

                <FormSection title={ar ? "تعديل الاتفاقية" : "Edit agreement"} description={ar ? "النسبة الجديدة تطبق على المسودات الجديدة فقط، ولا تغيّر الأشهر المعتمدة." : "A new percentage applies to future drafts and does not rewrite finalized months."}>
                  <form action={updateInvestorAgreement} className="grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="agreement_id" value={selected.id} />
                    <FormField label={ar ? "الاسم" : "Name"}><input name="investor_name" defaultValue={selected.investor_name} className="field-input" required /></FormField>
                    <FormField label={ar ? "نسبة الربح" : "Profit share %"}><input name="profit_share_percent" type="number" min="0" max="100" step="0.01" defaultValue={numeric(selected.profit_share_percent)} className="field-input" /></FormField>
                    <FormField label={ar ? "قيمة الاستثمار" : "Investment"}><input name="investment_amount_lyd" type="number" min="0" step="0.01" defaultValue={numeric(selected.investment_amount_lyd)} className="field-input" /></FormField>
                    <FormField label={ar ? "حد الدفعات" : "Payout cap"}><input name="payout_cap_lyd" type="number" min="0" step="0.01" defaultValue={selected.payout_cap_lyd ?? ""} className="field-input" /></FormField>
                    <FormField label={ar ? "البداية" : "Start"}><input name="start_date" type="date" defaultValue={selected.start_date} className="field-input" required /></FormField>
                    <FormField label={ar ? "النهاية" : "End"}><input name="end_date" type="date" defaultValue={selected.end_date ?? ""} className="field-input" /></FormField>
                    <FormField label={ar ? "الحالة" : "Status"}><select name="status" defaultValue={selected.status} className="field-input"><option value="draft">Draft</option><option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></FormField>
                    <FormField label={ar ? "ملاحظات" : "Notes"}><input name="notes" defaultValue={selected.notes ?? ""} className="field-input" /></FormField>
                    <button className="btn-secondary sm:col-span-2">{ar ? "حفظ الاتفاقية" : "Save agreement"}</button>
                  </form>
                </FormSection>
              </div>

              <section className="surface-card">
                <div className="mb-4"><h2 className="font-semibold text-slate-950">{ar ? "البيانات الشهرية" : "Monthly statements"}</h2><p className="mt-1 text-sm text-slate-500">{ar ? "المسودة يمكن إعادة حسابها. البيان المعتمد يصبح ثابتاً ويظهر للمستثمر." : "Drafts can be recalculated. Finalized statements are locked and visible to the investor."}</p></div>
                {!selectedStatements.length ? <p className="text-sm text-slate-500">{ar ? "لا توجد بيانات شهرية بعد." : "No monthly statements yet."}</p> : (
                  <DataTable headers={[ar ? "الشهر" : "Month", ar ? "الإيراد" : "Revenue", ar ? "إجمالي الربح" : "Gross profit", ar ? "المصاريف" : "Expenses", ar ? "الربح التشغيلي" : "Operating profit", ar ? "المستحق" : "Investor due", ar ? "المدفوع" : "Paid", ar ? "الحالة" : "Status", ar ? "الإجراء" : "Action"]}>
                    {[...selectedStatements].reverse().map((statement) => {
                      const paid = paymentsByStatement.get(statement.id) ?? 0;
                      const remaining = Math.max(0, numeric(statement.investor_share_due_lyd) - paid);
                      return (
                        <tr key={statement.id}>
                          <td className="font-medium">{monthLabel(statement.month_start, locale)}</td><td>{formatFinanceMoney(numeric(statement.revenue_lyd))}</td><td>{formatFinanceMoney(numeric(statement.gross_profit_lyd))}</td><td>{formatFinanceMoney(numeric(statement.operating_expenses_lyd))}</td><td>{formatFinanceMoney(numeric(statement.operating_profit_lyd))}</td><td>{formatFinanceMoney(numeric(statement.investor_share_due_lyd))}</td><td>{formatFinanceMoney(paid)}</td><td><StatusBadge status={statement.calculation_status} /></td>
                          <td>
                            {statement.calculation_status === "draft" ? (
                              <form action={finalizeInvestorStatement}><input type="hidden" name="agreement_id" value={selected.id} /><input type="hidden" name="statement_id" value={statement.id} /><button className="btn-secondary">{ar ? "اعتماد" : "Finalize"}</button></form>
                            ) : remaining > 0 ? (
                              <details><summary className="cursor-pointer text-sm font-semibold text-sky-700">{ar ? "تسجيل دفعة" : "Record payment"}</summary><form action={recordInvestorPayment} className="mt-3 min-w-[260px] space-y-2 rounded-xl border border-slate-200 bg-white p-3"><input type="hidden" name="agreement_id" value={selected.id} /><input type="hidden" name="statement_id" value={statement.id} /><input name="amount_lyd" type="number" min="0.01" max={remaining} step="0.01" defaultValue={remaining.toFixed(2)} className="field-input" required /><input name="payment_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="field-input" required /><select name="payment_method" className="field-input"><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option></select><input name="payment_reference" placeholder={ar ? "مرجع اختياري" : "Optional reference"} className="field-input" /><button className="btn-primary w-full">{ar ? "حفظ الدفعة" : "Save payment"}</button></form></details>
                            ) : <span className="text-sm text-emerald-700">{ar ? "مدفوع" : "Paid"}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </DataTable>
                )}
              </section>

              <section className="surface-card">
                <h2 className="font-semibold text-slate-950">{ar ? "سجل الدفعات" : "Payment history"}</h2>
                <div className="mt-4 space-y-3">
                  {selectedPayments.map((payment) => <div key={payment.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="font-semibold">{formatFinanceMoney(numeric(payment.amount_lyd))}</div><div className="text-xs text-slate-500">{payment.payment_date} · {payment.payment_reference || "-"}</div></div><div className="text-end"><StatusBadge status={payment.finance_posting_status} />{payment.finance_posting_error ? <div className="mt-1 max-w-md text-xs text-rose-600">{payment.finance_posting_error}</div> : null}</div></div>)}
                  {!selectedPayments.length ? <p className="text-sm text-slate-500">{ar ? "لا توجد دفعات بعد." : "No payments yet."}</p> : null}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
