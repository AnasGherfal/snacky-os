/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import {
  computeFinanceBalancesFromCutoff,
  FINANCE_RECONCILIATION_CUTOFF_DATE,
  formatFinanceMoney,
  isFinanceLedgerTransaction,
  RECONCILED_OPENING_BALANCES,
  signedAmount,
  sumFinanceProfitRows,
  sumFinanceRows,
  type FinanceBalances,
} from "@/lib/finance-balance";
import { updateFinanceSettings } from "@/lib/finance-actions";
import {
  buildFinanceClarificationPrompts,
  buildFinanceReviewGroups,
} from "@/lib/finance-import";
import {
  FINANCE_TRANSACTIONS_TABLE,
  loadFinanceLedgerRows,
  supabaseErrorDetails,
} from "@/lib/finance-ledger";
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
  amount?: number | string | null;
  currency?: string | null;
  account_id?: string | null;
  transaction_effect?: string | null;
  source_account_id?: string | null;
  destination_account_id?: string | null;
  import_status?: string | null;
  final_bucket: string | null;
  review_status: string | null;
  needs_review: boolean | null;
  transaction_status?: string | null;
};

type OpeningBalanceRow = {
  account_id: keyof FinanceBalances;
  currency: string;
  balance_date: string;
  opening_balance: number | string;
};

function financeAllowed(
  profile: Awaited<ReturnType<typeof getCurrentProfile>>,
) {
  return (
    profile &&
    canViewFinancials({
      id: profile.id,
      role: profile.role,
      roles: profile.roles,
      canAddProducts: profile.can_add_products,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    })
  );
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
  const period =
    params.period === "last_month" ||
    params.period === "this_year" ||
    params.period === "custom"
      ? params.period
      : "this_month";
  if (period === "last_month") {
    const start = addMonths(now, -1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
      period,
      label: "Last Month",
      suffix: "Last Month",
      start: ymd(start),
      end: ymd(end),
    };
  }
  if (period === "this_year") {
    return {
      period,
      label: "This Year",
      suffix: "This Year",
      start: ymd(new Date(now.getFullYear(), 0, 1)),
      end: ymd(now),
    };
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
  return {
    period,
    label: "This Month",
    suffix: "This Month",
    start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: ymd(now),
  };
}

function amount(row: FinanceRow) {
  return signedAmount(row);
}

function openingBalancesFromRows(
  rows: OpeningBalanceRow[] | null | undefined,
  fallback: Partial<FinanceBalances>,
): FinanceBalances {
  const balances: FinanceBalances = {
    snacky_lyd: Number(
      fallback.snacky_lyd ?? RECONCILED_OPENING_BALANCES.snacky_lyd,
    ),
    snacky_usd: Number(
      fallback.snacky_usd ?? RECONCILED_OPENING_BALANCES.snacky_usd,
    ),
    owner_lyd: Number(
      fallback.owner_lyd ?? RECONCILED_OPENING_BALANCES.owner_lyd,
    ),
    owner_usd: Number(
      fallback.owner_usd ?? RECONCILED_OPENING_BALANCES.owner_usd,
    ),
  };

  (rows ?? []).forEach((row) => {
    if (row.account_id in balances)
      balances[row.account_id] = Number(row.opening_balance ?? 0);
  });

  return balances;
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
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
        ? "text-rose-700"
        : tone === "strong"
          ? "text-slate-950"
          : "text-slate-900";
  return (
    <div className="surface-card">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight ${valueClass}`}
      >
        {value}
      </div>
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
  if (!supabase) {
    return (
      <>
        <ErrorState
          title="Finance unavailable"
          body="Supabase is not configured, so Snacky OS cannot load finance data."
        />
      </>
    );
  }
  const [settingsResult, openingBalancesResult, transactionsResult] =
    await Promise.all([
      supabase
        .from("finance_settings")
        .select(
          "opening_balance, opening_balance_snacky_lyd, opening_balance_snacky_usd, opening_balance_owner_lyd, opening_balance_owner_usd, opening_balance_date, reconciliation_cutoff_date, default_currency, exchange_rate_usd_to_lyd, updated_at",
        )
        .eq("id", "default")
        .maybeSingle(),
      supabase
        .from("finance_opening_balances")
        .select("account_id, currency, balance_date, opening_balance")
        .eq("balance_date", FINANCE_RECONCILIATION_CUTOFF_DATE),
      loadFinanceLedgerRows({
        label: "finance overview",
        buildQuery: (columns, level) => {
          let query = supabase
            .from(FINANCE_TRANSACTIONS_TABLE)
            .select(columns.join(", "))
            .order("transaction_date", { ascending: false })
            .limit(10000);
          if (level !== "legacy")
            query = query.eq("transaction_status", "active");
          return query;
        },
      }),
    ]);

  if (transactionsResult.error) {
    console.error("[finance] Overview fell back to empty ledger rows", {
      table: FINANCE_TRANSACTIONS_TABLE,
      selected_columns: transactionsResult.selectedColumns,
      supabase_error: supabaseErrorDetails(transactionsResult.error),
    });
  }

  const settings = settingsResult.error ? null : (settingsResult.data as any);
  const rows = (transactionsResult.data as FinanceRow[]).filter(
    (row) => row.transaction_date && row.transaction_status === "active",
  );
  const currency = String(settings?.default_currency ?? "LYD");
  const cutoffDate = String(
    settings?.reconciliation_cutoff_date ??
      settings?.opening_balance_date ??
      FINANCE_RECONCILIATION_CUTOFF_DATE,
  );
  const openingBalanceIsSet = true;
  const settingsFallback = {
    snacky_lyd: Number(
      settings?.opening_balance_snacky_lyd ??
        settings?.opening_balance ??
        RECONCILED_OPENING_BALANCES.snacky_lyd,
    ),
    snacky_usd: Number(
      settings?.opening_balance_snacky_usd ??
        RECONCILED_OPENING_BALANCES.snacky_usd,
    ),
    owner_lyd: Number(
      settings?.opening_balance_owner_lyd ??
        RECONCILED_OPENING_BALANCES.owner_lyd,
    ),
    owner_usd: Number(
      settings?.opening_balance_owner_usd ??
        RECONCILED_OPENING_BALANCES.owner_usd,
    ),
  };
  const openingRows = openingBalancesResult.error
    ? []
    : (openingBalancesResult.data as OpeningBalanceRow[] | null);
  if (openingBalancesResult.error)
    console.error(
      "[finance] Failed to load finance opening balance records",
      openingBalancesResult.error,
    );
  const openingBalances = openingBalancesFromRows(
    openingRows,
    settingsFallback,
  );
  const ledgerRows = rows.filter((row) =>
    isFinanceLedgerTransaction(row, cutoffDate),
  );
  const balances = computeFinanceBalancesFromCutoff({
    rows,
    openingBalances,
    cutoffDate,
  });
  const exchangeRate = Number(settings?.exchange_rate_usd_to_lyd ?? 0);
  const periodRows = ledgerRows.filter(
    (row) =>
      row.transaction_date >= periodRange.start &&
      row.transaction_date <= periodRange.end,
  );
  const periodMoneyInLyd = sumFinanceRows(periodRows, "LYD", "money_in");
  const periodMoneyOutLyd = Math.abs(
    sumFinanceRows(periodRows, "LYD", "money_out"),
  );
  const periodMoneyInUsd = sumFinanceRows(periodRows, "USD", "money_in");
  const periodMoneyOutUsd = Math.abs(
    sumFinanceRows(periodRows, "USD", "money_out"),
  );
  const periodNetLyd = periodMoneyInLyd - periodMoneyOutLyd;
  const periodNetUsd = periodMoneyInUsd - periodMoneyOutUsd;
  const periodProfitLyd = sumFinanceProfitRows(periodRows, "LYD", cutoffDate);
  const periodProfitUsd = sumFinanceProfitRows(periodRows, "USD", cutoffDate);
  const reviewCount = rows.filter((row) => row.needs_review).length;
  const latestRows = rows.slice(0, 10);
  const reviewGroups = buildFinanceReviewGroups(
    rows
      .filter((row) => row.needs_review)
      .map((row: any) => ({
        ...row,
        importStatus: "needs_review",
        sourceRow: Number(row.source_row ?? 0),
        sourceFile: "",
        sourceSheet: "",
        record: {},
        originalDescription: row.description ?? "",
        reviewReason: "Needs review",
        reviewGroupKey: row.final_bucket ?? "needs_review",
        suggestedCategory: row.final_bucket,
        suggestedAccount: row.account_id ?? "snacky_lyd",
        suggestedMachine: null,
        suggestedSourceAccount: row.source_account_id,
        suggestedDestinationAccount: row.destination_account_id,
        confidenceScore: 0.5,
        clarificationQuestion:
          "Should this transaction affect a Snacky account, an Owner account, or be ignored?",
        amount: Number(row.amount ?? Math.abs(Number(row.signed_amount ?? 0))),
        currency: row.currency ?? "LYD",
      })) as any[],
  );
  const periodLinks = [
    {
      label: "This month",
      href: "/finance?period=this_month",
      key: "this_month",
    },
    {
      label: "Last month",
      href: "/finance?period=last_month",
      key: "last_month",
    },
    { label: "This year", href: "/finance?period=this_year", key: "this_year" },
  ];

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle={`Actual balances from reconciled opening records dated ${cutoffDate} plus Snacky OS transactions after that date.`}
        action={
          <PrimaryButton href="/finance/transactions/new">
            Manual money in/out
          </PrimaryButton>
        }
      />

      {params.settingsError ? (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {params.settingsError}
        </div>
      ) : null}
      {params.settingsSaved ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Finance settings saved.
        </div>
      ) : null}
      {transactionsResult.warning || transactionsResult.error ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {transactionsResult.error
            ? "No finance transactions loaded. The overview is available, but the ledger query failed while the schema is being repaired."
            : transactionsResult.warning}
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Cash flow period
            </div>
            <div className="mt-1 text-sm text-slate-500">
              {periodRange.label}: {periodRange.start} to {periodRange.end}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {periodLinks.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                className={
                  periodRange.period === link.key
                    ? "btn-primary"
                    : "btn-secondary"
                }
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
        <form className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <input type="hidden" name="period" value="custom" />
          <input
            name="date_from"
            type="date"
            defaultValue={
              periodRange.period === "custom" ? periodRange.start : ""
            }
            className="field-input"
          />
          <input
            name="date_to"
            type="date"
            defaultValue={
              periodRange.period === "custom" ? periodRange.end : ""
            }
            className="field-input"
          />
          <button
            className={
              periodRange.period === "custom" ? "btn-primary" : "btn-secondary"
            }
          >
            Apply custom range
          </button>
        </form>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Owner / Anas LYD"
          value={formatFinanceMoney(balances.owner_lyd, "LYD")}
          note="Owner account. Not business profit."
          tone={balances.owner_lyd < 0 ? "negative" : "strong"}
        />
        <StatCard
          label="Owner / Anas USD"
          value={formatFinanceMoney(balances.owner_usd, "USD")}
          note="Owner account. Not business profit."
          tone={balances.owner_usd < 0 ? "negative" : "strong"}
        />
        <StatCard
          label="Snacky LYD"
          value={formatFinanceMoney(balances.snacky_lyd, "LYD")}
          note="Business LYD only"
          tone={balances.snacky_lyd < 0 ? "negative" : "strong"}
        />
        <StatCard
          label="Snacky USD"
          value={formatFinanceMoney(balances.snacky_usd, "USD")}
          note="Business USD only"
          tone={balances.snacky_usd < 0 ? "negative" : "strong"}
        />
      </section>

      {exchangeRate > 0 ? (
        <section className="surface-card mb-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Exchange rate note
          </div>
          <div className="mt-2 text-sm text-slate-700">
            USD conversion is available at 1 USD = {exchangeRate} LYD, but
            balances remain separated by account and currency.
          </div>
        </section>
      ) : null}

      <section className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`LYD In ${periodRange.suffix}`}
          value={formatFinanceMoney(periodMoneyInLyd, "LYD")}
          note="Active LYD inflows only"
          tone="positive"
        />
        <StatCard
          label={`LYD Out ${periodRange.suffix}`}
          value={formatFinanceMoney(periodMoneyOutLyd, "LYD")}
          note="Active LYD outflows only"
          tone="negative"
        />
        <StatCard
          label={`LYD Net ${periodRange.suffix}`}
          value={formatFinanceMoney(periodNetLyd, "LYD")}
          note="LYD money in minus LYD money out"
          tone={periodNetLyd < 0 ? "negative" : "positive"}
        />
        <StatCard
          label={`LYD Profit ${periodRange.suffix}`}
          value={formatFinanceMoney(periodProfitLyd, "LYD")}
          note="Income minus real expenses. Owner funding/withdrawal excluded."
          tone={periodProfitLyd < 0 ? "negative" : "positive"}
        />
        <StatCard
          label={`USD In ${periodRange.suffix}`}
          value={formatFinanceMoney(periodMoneyInUsd, "USD")}
          note="Active USD inflows only"
          tone="positive"
        />
        <StatCard
          label={`USD Out ${periodRange.suffix}`}
          value={formatFinanceMoney(periodMoneyOutUsd, "USD")}
          note="Active USD outflows only"
          tone="negative"
        />
        <StatCard
          label={`USD Net ${periodRange.suffix}`}
          value={formatFinanceMoney(periodNetUsd, "USD")}
          note="USD money in minus USD money out"
          tone={periodNetUsd < 0 ? "negative" : "positive"}
        />
        <StatCard
          label={`USD Profit ${periodRange.suffix}`}
          value={formatFinanceMoney(periodProfitUsd, "USD")}
          note="Income minus real expenses. Owner funding/withdrawal excluded."
          tone={periodProfitUsd < 0 ? "negative" : "positive"}
        />
      </section>

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-1 border-b border-slate-200 pb-4">
          <h2 className="text-base font-semibold text-slate-900">
            Finance Settings
          </h2>
          <p className="text-sm text-slate-500">
            Opening balance is the reconciled account balance on {cutoffDate}.
            Only active ledger rows after that date affect running balances.
          </p>
        </div>
        <form
          action={updateFinanceSettings}
          className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6 md:items-end"
        >
          <FormField label="Snacky LYD opening">
            <input
              name="opening_balance_snacky_lyd"
              type="number"
              step="0.01"
              defaultValue={
                openingBalanceIsSet
                  ? Number(openingBalances.snacky_lyd ?? 0)
                  : ""
              }
              className="field-input"
            />
          </FormField>
          <FormField label="Snacky USD opening">
            <input
              name="opening_balance_snacky_usd"
              type="number"
              step="0.01"
              defaultValue={
                openingBalanceIsSet
                  ? Number(openingBalances.snacky_usd ?? 0)
                  : ""
              }
              className="field-input"
            />
          </FormField>
          <FormField label="Owner LYD opening">
            <input
              name="opening_balance_owner_lyd"
              type="number"
              step="0.01"
              defaultValue={
                openingBalanceIsSet
                  ? Number(openingBalances.owner_lyd ?? 0)
                  : ""
              }
              className="field-input"
            />
          </FormField>
          <FormField label="Owner USD opening">
            <input
              name="opening_balance_owner_usd"
              type="number"
              step="0.01"
              defaultValue={
                openingBalanceIsSet
                  ? Number(openingBalances.owner_usd ?? 0)
                  : ""
              }
              className="field-input"
            />
          </FormField>
          <FormField label="Opening balance date">
            <input
              name="opening_balance_date"
              type="date"
              defaultValue={settings?.opening_balance_date ?? cutoffDate}
              className="field-input"
            />
          </FormField>
          <FormField label="Reconciliation cutoff">
            <input
              name="reconciliation_cutoff_date"
              type="date"
              defaultValue={cutoffDate}
              className="field-input"
            />
          </FormField>
          <FormField label="USD to LYD rate">
            <input
              name="exchange_rate_usd_to_lyd"
              type="number"
              step="0.0001"
              min="0"
              defaultValue={exchangeRate > 0 ? exchangeRate : ""}
              className="field-input"
            />
          </FormField>
          <input type="hidden" name="default_currency" value={currency} />
          <button className="btn-primary">Save settings</button>
        </form>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-3">
        <StatCard
          label="Needs Review"
          value={String(reviewCount)}
          note="Imported rows waiting for finance cleanup"
        />
        <StatCard
          label="Confirmed"
          value={String(
            rows.filter((row) => row.review_status === "confirmed").length,
          )}
        />
        <StatCard
          label="Reviewed"
          value={String(
            rows.filter((row) => row.review_status === "reviewed").length,
          )}
        />
      </section>

      {reviewGroups.length ? (
        <section className="surface-card mb-6">
          <div className="flex flex-col gap-2 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Import Review Summary
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Rows waiting for one-by-one confirmation or classification.
              </p>
            </div>
            <SecondaryButton href="/finance/import/review">
              Open row review
            </SecondaryButton>
          </div>
          <div className="mt-4 grid gap-3">
            {buildFinanceClarificationPrompts(reviewGroups)
              .slice(0, 4)
              .map((prompt, index) => (
                <div
                  key={`${prompt}-${index}`}
                  className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
                >
                  {prompt}
                </div>
              ))}
          </div>
        </section>
      ) : null}

      {!latestRows.length ? (
        <EmptyState
          title="No finance transactions yet"
          body="Import the historical finance file or add a manual money in/out transaction."
        />
      ) : (
        <DataTable
          headers={[
            "Date",
            "Direction",
            "Kind",
            "Type",
            "Description",
            "Amount",
            "Review",
          ]}
        >
          {latestRows.map((row) => (
            <tr key={row.id}>
              <td>{row.transaction_date}</td>
              <td>
                <StatusBadge status={row.direction.replace("_", " ")} />
              </td>
              <td>{row.transaction_kind.replaceAll("_", " ")}</td>
              <td>{row.transaction_type ?? "-"}</td>
              <td>{row.description ?? "-"}</td>
              <td>
                {formatFinanceMoney(amount(row), row.currency ?? currency)}
              </td>
              <td>
                <StatusBadge
                  status={row.needs_review ? "needs_review" : row.review_status}
                />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <div className="mt-4">
        <Link href="/finance/transactions" className="link-secondary">
          Open all transactions
        </Link>
      </div>
    </>
  );
}
