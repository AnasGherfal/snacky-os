import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, FormField, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { isBalanceAffectingTransaction, signedAmount } from "@/lib/finance-balance";
import { updateFinanceSettings } from "@/lib/finance-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type FinanceSearchParams = {
  period?: string;
  date_from?: string;
  date_to?: string;
  settingsSaved?: string;
  settingsError?: string;
};

type FinanceRow = {
  id: string;
  transaction_date: string;
  direction: "money_in" | "money_out";
  transaction_kind: string;
  transaction_type: string | null;
  description: string | null;
  signed_amount: number | string | null;
  final_bucket: string | null;
  review_status: string | null;
  needs_review: boolean | null;
  transaction_status?: string | null;
};

function financeAllowed(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return profile && canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });
}

function ymd(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function resolvePeriod(params: FinanceSearchParams) {
  const now = new Date();
  const period = params.period === "last_month" || params.period === "this_year" || params.period === "custom" ? params.period : "this_month";
  if (period === "last_month") {
    const start = addMonths(now, -1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { period, label: "Last Month", suffix: "Last Month", start: ymd(start), end: ymd(end) };
  }
  if (period === "this_year") {
    return { period, label: "This Year", suffix: "This Year", start: ymd(new Date(now.getFullYear(), 0, 1)), end: ymd(now) };
  }
  if (period === "custom") {
    const fallbackStart = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    return {
      period,
      label: "Custom Range",
      suffix: "Custom Range",
      start: params.date_from || fallbackStart,
      end: params.date_to || ymd(now),
    };
  }
  return { period, label: "This Month", suffix: "This Month", start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: ymd(now) };
}

function amount(row: FinanceRow) {
  return signedAmount(row);
}

function sum(rows: FinanceRow[]) {
  return rows.reduce((total, row) => total + amount(row), 0);
}

function money(value: number, currency: string) {
  return `${Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
}

function transactionText(row: FinanceRow) {
  return [row.transaction_kind, row.transaction_type, row.final_bucket, row.description].filter(Boolean).join(" ").toLowerCase();
}

function includesAny(row: FinanceRow, terms: string[]) {
  const text = transactionText(row);
  return terms.some((term) => text.includes(term));
}

function StatCard({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "positive" | "negative" | "strong";
}) {
  const valueClass =
    tone === "positive" ? "text-emerald-700" : tone === "negative" ? "text-rose-700" : tone === "strong" ? "text-slate-950" : "text-slate-900";
  return (
    <div className="surface-card">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</div>
      {note ? <div className="mt-2 text-xs text-slate-500">{note}</div> : null}
    </div>
  );
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<FinanceSearchParams>;
}) {
  const profile = await getCurrentProfile();
  if (!financeAllowed(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const periodRange = resolvePeriod(params);
  const supabase = getSupabaseServerClient();
  const [settingsResult, transactionsResult] = supabase
    ? await Promise.all([
        supabase.from("finance_settings").select("opening_balance, opening_balance_date, default_currency, updated_at").eq("id", "default").maybeSingle(),
        supabase
          .from("financial_transactions")
          .select("id, transaction_date, direction, transaction_kind, transaction_type, description, signed_amount, final_bucket, review_status, needs_review, transaction_status")
          .eq("transaction_status", "active")
          .order("transaction_date", { ascending: false })
          .limit(10000),
      ])
    : [{ data: null, error: null }, { data: [], error: null }];

  const settings = settingsResult.error ? null : (settingsResult.data as any);
  const rows = ((transactionsResult.data ?? []) as FinanceRow[]).filter((row) => row.transaction_date);
  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const currency = String(settings?.default_currency ?? "LYD");
  const openingBalanceIsSet = settings?.opening_balance !== null && settings?.opening_balance !== undefined;
  const openingBalance = openingBalanceIsSet ? Number(settings.opening_balance ?? 0) : 0;
  const ledgerNet = sum(balanceRows);
  const currentBalance = openingBalance + ledgerNet;
  const totalMoneyIn = balanceRows.filter((row) => row.direction === "money_in").reduce((total, row) => total + amount(row), 0);
  const totalMoneyOut = Math.abs(balanceRows.filter((row) => row.direction === "money_out").reduce((total, row) => total + amount(row), 0));
  const periodRows = balanceRows.filter((row) => row.transaction_date >= periodRange.start && row.transaction_date <= periodRange.end);
  const periodMoneyIn = periodRows.filter((row) => row.direction === "money_in").reduce((total, row) => total + amount(row), 0);
  const periodMoneyOut = Math.abs(periodRows.filter((row) => row.direction === "money_out").reduce((total, row) => total + amount(row), 0));
  const periodNet = periodMoneyIn - periodMoneyOut;
  const purchases = Math.abs(periodRows.filter((row) => row.direction === "money_out" && (row.transaction_kind === "product_purchase" || includesAny(row, ["purchase", "restocking", "supplier"]))).reduce((total, row) => total + amount(row), 0));
  const rent = Math.abs(periodRows.filter((row) => row.direction === "money_out" && includesAny(row, ["rent"])).reduce((total, row) => total + amount(row), 0));
  const machineInvestments = Math.abs(periodRows.filter((row) => row.direction === "money_out" && includesAny(row, ["machine investment", "machine investments", "machine purchase", "equipment"])).reduce((total, row) => total + amount(row), 0));
  const reviewCount = rows.filter((row) => row.needs_review).length;
  const latestRows = rows.slice(0, 10);
  const periodLinks = [
    { label: "This month", href: "/finance?period=this_month", key: "this_month" },
    { label: "Last month", href: "/finance?period=last_month", key: "last_month" },
    { label: "This year", href: "/finance?period=this_year", key: "this_year" },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Finance"
        subtitle="Actual balance and cash flow from Snacky OS financial transactions."
        action={<PrimaryButton href="/finance/transactions/new">Manual money in/out</PrimaryButton>}
      />

      {params.settingsError ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{params.settingsError}</div> : null}
      {params.settingsSaved ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">Finance settings saved.</div> : null}

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          <SecondaryButton href="/finance/transactions">Transactions</SecondaryButton>
          <SecondaryButton href="/cash-collections">Cash Collections</SecondaryButton>
          <SecondaryButton href="/finance/transactions?q=rent">Rent</SecondaryButton>
          <SecondaryButton href="/finance/transactions?q=machine%20investment">Machine Investments</SecondaryButton>
          <SecondaryButton href="/finance/transactions?direction=money_out">Expenses</SecondaryButton>
          <SecondaryButton href="/finance/transactions?direction=money_in">Revenue</SecondaryButton>
          <SecondaryButton href="/finance/reports">Reports</SecondaryButton>
          <SecondaryButton href="/finance/import">Import History</SecondaryButton>
        </div>
      </div>

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900">Cash flow period</div>
            <div className="mt-1 text-sm text-slate-500">
              {periodRange.label}: {periodRange.start} to {periodRange.end}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {periodLinks.map((link) => (
              <Link key={link.key} href={link.href} className={periodRange.period === link.key ? "btn-primary" : "btn-secondary"}>
                {link.label}
              </Link>
            ))}
          </div>
        </div>
        <form className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <input type="hidden" name="period" value="custom" />
          <input name="date_from" type="date" defaultValue={periodRange.period === "custom" ? periodRange.start : ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={periodRange.period === "custom" ? periodRange.end : ""} className="field-input" />
          <button className={periodRange.period === "custom" ? "btn-primary" : "btn-secondary"}>Apply custom range</button>
        </form>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Opening Balance"
          value={openingBalanceIsSet ? money(openingBalance, currency) : "Not set"}
          note={openingBalanceIsSet ? `As of ${settings?.opening_balance_date ?? "not dated"}` : "Set this in Finance Settings"}
        />
        <StatCard label="Total Money In" value={money(totalMoneyIn, currency)} note="Approved active finance ledger inflows" tone="positive" />
        <StatCard label="Total Money Out" value={money(totalMoneyOut, currency)} note="Approved active finance ledger outflows" tone="negative" />
        <StatCard
          label="Current Balance"
          value={money(currentBalance, currency)}
          note="Opening balance + approved active money in - approved active money out"
          tone={currentBalance < 0 ? "negative" : "strong"}
        />
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <StatCard label={`Revenue ${periodRange.suffix}`} value={money(periodMoneyIn, currency)} note="Approved actual money in, not VMS sales reports" tone="positive" />
        <StatCard label={`Expenses ${periodRange.suffix}`} value={money(periodMoneyOut, currency)} note="Approved actual money out" tone="negative" />
        <StatCard label={`Net Cash Flow ${periodRange.suffix}`} value={money(periodNet, currency)} note="Money in minus money out" tone={periodNet < 0 ? "negative" : "positive"} />
        <StatCard label={`Purchases ${periodRange.suffix}`} value={money(purchases, currency)} note="Paid or received product purchases" />
        <StatCard label={`Rent ${periodRange.suffix}`} value={money(rent, currency)} note="Rent-labelled finance transactions" />
        <StatCard label={`Machine Investments ${periodRange.suffix}`} value={money(machineInvestments, currency)} note="Machine or equipment investment spend" />
      </section>

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-1 border-b border-slate-200 pb-4">
          <h2 className="text-base font-semibold text-slate-900">Finance Settings</h2>
          <p className="text-sm text-slate-500">Opening balance is added once before approved active ledger inflows and outflows. Needs-review, voided, and archived rows are excluded.</p>
        </div>
        <form action={updateFinanceSettings} className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <FormField label="Opening balance" required>
            <input name="opening_balance" type="number" step="0.01" defaultValue={openingBalanceIsSet ? Number(settings.opening_balance ?? 0) : ""} className="field-input" />
          </FormField>
          <FormField label="Opening balance date">
            <input name="opening_balance_date" type="date" defaultValue={settings?.opening_balance_date ?? ymd(new Date())} className="field-input" />
          </FormField>
          <FormField label="Default currency">
            <select name="default_currency" defaultValue={currency} className="field-input">
              <option value="LYD">LYD</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </FormField>
          <button className="btn-primary">Save settings</button>
        </form>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-3">
        <StatCard label="Needs Review" value={String(reviewCount)} note="Imported rows waiting for finance cleanup" />
        <StatCard label="Confirmed" value={String(rows.filter((row) => row.review_status === "confirmed").length)} />
        <StatCard label="Reviewed" value={String(rows.filter((row) => row.review_status === "reviewed").length)} />
      </section>

      {!latestRows.length ? (
        <EmptyState title="No finance transactions yet" body="Import the historical finance file or add a manual money in/out transaction." />
      ) : (
        <DataTable headers={["Date", "Direction", "Kind", "Type", "Description", "Amount", "Review"]}>
          {latestRows.map((row) => (
            <tr key={row.id}>
              <td>{row.transaction_date}</td>
              <td><StatusBadge status={row.direction.replace("_", " ")} /></td>
              <td>{row.transaction_kind.replaceAll("_", " ")}</td>
              <td>{row.transaction_type ?? "-"}</td>
              <td>{row.description ?? "-"}</td>
              <td>{money(amount(row), currency)}</td>
              <td><StatusBadge status={row.needs_review ? "needs_review" : row.review_status} /></td>
            </tr>
          ))}
        </DataTable>
      )}
      <div className="mt-4"><Link href="/finance/transactions" className="link-secondary">Open all transactions</Link></div>
    </AppShell>
  );
}
