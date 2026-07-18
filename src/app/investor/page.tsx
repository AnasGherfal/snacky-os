/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from "next/navigation";
import { ChartCard, TrendChart } from "@/components/DecisionCharts";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasPermission, isOwnerAdminRole } from "@/lib/authz";
import { formatFinanceMoney } from "@/lib/finance-balance";
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
  finalized_at: string | null;
};

type Payment = {
  id: string;
  agreement_id: string;
  statement_id: string | null;
  payment_date: string;
  amount_lyd: number | string;
  payment_reference: string | null;
};

function numeric(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthLabel(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
}

export default async function InvestorPortalPage({ searchParams }: { searchParams: Promise<{ agreement?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !hasPermission(profile, "investor.view")) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const params = await searchParams;
  if (!supabase) return <EmptyState title={ar ? "البوابة غير متاحة" : "Portal unavailable"} body={ar ? "Supabase غير مهيأ." : "Supabase is not configured."} />;

  let agreementsQuery = supabase.from("investor_agreements").select("*").order("start_date", { ascending: false });
  if (!isOwnerAdminRole(profile)) agreementsQuery = agreementsQuery.eq("investor_user_id", profile.id);
  const agreementsResult = await agreementsQuery;
  const agreements = (agreementsResult.data ?? []) as Agreement[];
  const selected = agreements.find((agreement) => agreement.id === params.agreement) ?? agreements[0] ?? null;

  if (!selected) {
    return <EmptyState title={ar ? "لا توجد اتفاقية مرتبطة بحسابك" : "No agreement linked to this account"} body={ar ? "يجب على إدارة سناكي ربط حساب المستثمر بالاتفاقية أولاً." : "Snacky management must link this investor login to an agreement first."} />;
  }

  const [statementsResult, paymentsResult] = await Promise.all([
    supabase.from("investor_monthly_statements").select("*").eq("agreement_id", selected.id).eq("calculation_status", "finalized").order("month_start", { ascending: true }),
    supabase.from("investor_payments").select("id, agreement_id, statement_id, payment_date, amount_lyd, payment_reference").eq("agreement_id", selected.id).order("payment_date", { ascending: false }),
  ]);
  const statements = (statementsResult.data ?? []) as Statement[];
  const payments = (paymentsResult.data ?? []) as Payment[];
  const paymentsByStatement = new Map<string, number>();
  payments.forEach((payment) => {
    if (!payment.statement_id) return;
    paymentsByStatement.set(payment.statement_id, (paymentsByStatement.get(payment.statement_id) ?? 0) + numeric(payment.amount_lyd));
  });
  const totalDue = statements.reduce((sum, row) => sum + numeric(row.investor_share_due_lyd), 0);
  const totalPaid = payments.reduce((sum, row) => sum + numeric(row.amount_lyd), 0);
  const unpaid = Math.max(0, totalDue - totalPaid);

  return (
    <>
      <PageHeader
        title={ar ? "بوابة المستثمر" : "Investor Portal"}
        subtitle={ar ? "عرض الاتفاقية والبيانات الشهرية المعتمدة والدفعات فقط." : "Read-only access to your agreement, finalized monthly statements, and payments."}
      />

      <div className="space-y-6">
        {isOwnerAdminRole(profile) && agreements.length > 1 ? (
          <div className="surface-card flex flex-wrap gap-2">
            {agreements.map((agreement) => <a key={agreement.id} href={`/investor?agreement=${agreement.id}`} className={agreement.id === selected.id ? "btn-primary" : "btn-secondary"}>{agreement.investor_name}</a>)}
          </div>
        ) : null}

        <section className="rounded-3xl border border-sky-200 bg-sky-50 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2"><StatusBadge status={selected.status} /><span className="text-sm text-slate-600">{selected.start_date}{selected.end_date ? ` — ${selected.end_date}` : ""}</span></div>
              <h2 className="mt-3 text-2xl font-semibold text-slate-950">{selected.investor_name}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{ar ? "النسبة تحسب من الربح التشغيلي الإيجابي: مبيعات VMS ناقص تكلفة المنتجات والمصاريف التشغيلية. دفعات المستثمر ليست مصروفاً تشغيلياً." : "The share is calculated from positive operating profit: VMS sales minus product cost and operating expenses. Investor distributions are not treated as operating expenses."}</p>
            </div>
            <div className="grid min-w-[280px] grid-cols-2 gap-3">
              <div className="rounded-xl bg-white p-4"><div className="text-xs text-slate-500">{ar ? "قيمة الاستثمار" : "Investment"}</div><div className="mt-1 font-semibold">{formatFinanceMoney(numeric(selected.investment_amount_lyd))}</div></div>
              <div className="rounded-xl bg-white p-4"><div className="text-xs text-slate-500">{ar ? "نسبة الربح" : "Profit share"}</div><div className="mt-1 font-semibold">{numeric(selected.profit_share_percent)}%</div></div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [ar ? "إجمالي المستحق" : "Total finalized due", totalDue],
            [ar ? "إجمالي المدفوع" : "Total paid", totalPaid],
            [ar ? "المتبقي غير المدفوع" : "Unpaid balance", unpaid],
            [ar ? "حد الدفعات" : "Payout cap", selected.payout_cap_lyd === null ? null : numeric(selected.payout_cap_lyd)],
          ].map(([label, value]) => <div key={String(label)} className="surface-card"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{String(label)}</div><div className="mt-2 text-2xl font-semibold">{value === null ? (ar ? "لا يوجد" : "No cap") : formatFinanceMoney(Number(value))}</div></div>)}
        </div>

        <ChartCard title={ar ? "الربح والمستحق والمدفوع" : "Operating profit, due, and paid"} subtitle={ar ? "كل نقطة تمثل شهراً معتمداً من إدارة سناكي." : "Each point represents a finalized month approved by Snacky management."}>
          <TrendChart
            labels={statements.map((statement) => monthLabel(statement.month_start, locale))}
            series={[
              { key: "profit", label: ar ? "الربح التشغيلي" : "Operating profit", values: statements.map((statement) => numeric(statement.operating_profit_lyd)) },
              { key: "due", label: ar ? "المستحق" : "Investor due", values: statements.map((statement) => numeric(statement.investor_share_due_lyd)) },
              { key: "paid", label: ar ? "المدفوع" : "Paid", values: statements.map((statement) => paymentsByStatement.get(statement.id) ?? 0) },
            ]}
            valueFormatter={(value) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}
          />
        </ChartCard>

        <section className="surface-card">
          <div className="mb-4"><h2 className="font-semibold text-slate-950">{ar ? "البيانات الشهرية المعتمدة" : "Finalized monthly statements"}</h2><p className="mt-1 text-sm text-slate-500">{ar ? "المسودات غير ظاهرة هنا ولا يمكن للمستثمر تعديل أي رقم." : "Drafts are hidden and the investor cannot edit any amount."}</p></div>
          {!statements.length ? <p className="text-sm text-slate-500">{ar ? "لا توجد أشهر معتمدة بعد." : "No finalized months yet."}</p> : (
            <DataTable headers={[ar ? "الشهر" : "Month", ar ? "الإيراد" : "Revenue", ar ? "تكلفة المنتجات" : "Product cost", ar ? "إجمالي الربح" : "Gross profit", ar ? "المصاريف التشغيلية" : "Operating expenses", ar ? "الربح التشغيلي" : "Operating profit", ar ? "النسبة" : "Share", ar ? "المستحق" : "Due", ar ? "المدفوع" : "Paid", ar ? "المتبقي" : "Remaining"]}>
              {[...statements].reverse().map((statement) => {
                const paid = paymentsByStatement.get(statement.id) ?? 0;
                const remaining = Math.max(0, numeric(statement.investor_share_due_lyd) - paid);
                return <tr key={statement.id}><td className="font-medium">{monthLabel(statement.month_start, locale)}</td><td>{formatFinanceMoney(numeric(statement.revenue_lyd))}</td><td>{formatFinanceMoney(numeric(statement.cogs_lyd))}</td><td>{formatFinanceMoney(numeric(statement.gross_profit_lyd))}</td><td>{formatFinanceMoney(numeric(statement.operating_expenses_lyd))}</td><td>{formatFinanceMoney(numeric(statement.operating_profit_lyd))}</td><td>{numeric(statement.share_percent)}%</td><td>{formatFinanceMoney(numeric(statement.investor_share_due_lyd))}</td><td>{formatFinanceMoney(paid)}</td><td>{formatFinanceMoney(remaining)}</td></tr>;
              })}
            </DataTable>
          )}
        </section>

        <section className="surface-card">
          <h2 className="font-semibold text-slate-950">{ar ? "سجل الدفعات" : "Payment history"}</h2>
          <div className="mt-4 space-y-3">
            {payments.map((payment) => <div key={payment.id} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4"><div><div className="font-semibold">{formatFinanceMoney(numeric(payment.amount_lyd))}</div><div className="text-xs text-slate-500">{payment.payment_date}</div></div><div className="text-sm text-slate-600">{payment.payment_reference || "-"}</div></div>)}
            {!payments.length ? <p className="text-sm text-slate-500">{ar ? "لا توجد دفعات بعد." : "No payments yet."}</p> : null}
          </div>
        </section>
      </div>
    </>
  );
}
