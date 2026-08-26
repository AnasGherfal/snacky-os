import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  DataTable,
  EmptyState,
  PageHeader,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { loadFinanceHealthDiagnostics } from "@/lib/finance-health";
import {
  FINANCE_TRANSACTION_FULL_COLUMNS,
  FINANCE_TRANSACTIONS_TABLE,
  supabaseErrorDetails,
} from "@/lib/finance-ledger";
import {
  getSupabaseAdminClient,
} from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type HealthReport = {
  schema_status?: string;
  missing_columns?: string[];
  transactions_count?: number;
  purchases_count?: number;
  cash_collections_count?: number;
  purchases_with_linked_finance_transaction?: number;
  cash_collections_with_linked_finance_transaction?: number;
  purchases_missing_finance_transaction?: number;
  cash_collections_missing_finance_transaction?: number;
  broken_link_count?: number;
  balance_inconsistency_count?: number;
  missing_category_count?: number;
  ignored_source_count?: number;
  failed_sync_count?: number;
  source_types_in_overview?: string[];
  schema_columns?: Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    ordinal_position: number;
  }>;
  constraints?: Array<{
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>;
  indexes?: Array<{ indexname: string; indexdef: string }>;
};

function numberValue(value: unknown) {
  return Number(value ?? 0).toLocaleString();
}

function moneyValue(value: number, currency = "LYD") {
  return `${currency} ${value.toFixed(2)}`;
}

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text || "-";
}

async function countRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  table: string,
) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });
  if (error) return { count: 0, error };
  return { count: count ?? 0, error: null };
}

async function loadFallbackHealth(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
) {
  const [purchases, cashCollections, transactions] = await Promise.all([
    countRows(supabase, "purchase_orders"),
    countRows(supabase, "cash_collections"),
    countRows(supabase, FINANCE_TRANSACTIONS_TABLE),
  ]);
  return {
    report: {
      schema_status: "rpc_unavailable",
      missing_columns: [],
      purchases_count: purchases.count,
      cash_collections_count: cashCollections.count,
      transactions_count: transactions.count,
      purchases_with_linked_finance_transaction: 0,
      cash_collections_with_linked_finance_transaction: 0,
      purchases_missing_finance_transaction: purchases.count,
      cash_collections_missing_finance_transaction: cashCollections.count,
      broken_link_count: 0,
      balance_inconsistency_count: 0,
      missing_category_count: 0,
      ignored_source_count: 0,
      failed_sync_count: purchases.count + cashCollections.count,
      schema_columns: [],
      constraints: [],
      indexes: [],
    } satisfies HealthReport,
    errors: [purchases.error, cashCollections.error, transactions.error]
      .filter(Boolean)
      .map(supabaseErrorDetails),
  };
}

function DiagnosticSection({
  title,
  description,
  table,
  emptyTitle,
  emptyBody,
}: {
  title: string;
  description: string;
  table: ReactNode;
  emptyTitle: string;
  emptyBody: string;
}) {
  const hasRows = Boolean(table);
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mb-3 text-sm text-slate-500">{description}</p>
      {hasRows ? table : <EmptyState title={emptyTitle} body={emptyBody} />}
    </section>
  );
}

export default async function FinanceHealthPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return (
      <EmptyState
        title="Finance health unavailable"
        body="Supabase is not configured, so Snacky OS cannot audit the finance ledger."
      />
    );
  }

  const [healthResult, diagnostics] = await Promise.all([
    supabase.rpc("finance_health_report"),
    loadFinanceHealthDiagnostics(supabase),
  ]);

  const fallback = healthResult.error ? await loadFallbackHealth(supabase) : null;
  const report = (
    healthResult.error ? fallback?.report : healthResult.data
  ) as HealthReport;
  const rpcError = healthResult.error
    ? supabaseErrorDetails(healthResult.error)
    : null;
  if (healthResult.error) {
    console.error(
      "[finance-health] finance_health_report RPC failed",
      rpcError,
    );
  }

  const diagnosticCount = {
    missingPurchases:
      report.purchases_missing_finance_transaction ??
      diagnostics.purchasesMissingFinance.length,
    missingCash:
      report.cash_collections_missing_finance_transaction ??
      diagnostics.cashCollectionsMissingFinance.length,
    brokenLinks:
      report.broken_link_count ?? diagnostics.brokenLinks.length,
    balanceIssues:
      report.balance_inconsistency_count ??
      diagnostics.balanceInconsistencies.length,
    missingCategories:
      report.missing_category_count ?? diagnostics.missingCategories.length,
    ignoredSource:
      report.ignored_source_count ?? diagnostics.ignoredSourceRows.length,
  };

  const cards = [
    { label: "Transactions", value: report.transactions_count, tone: "text-slate-900" },
    { label: "Purchases missing finance", value: diagnosticCount.missingPurchases, tone: "text-rose-700" },
    { label: "Cash missing finance", value: diagnosticCount.missingCash, tone: "text-rose-700" },
    { label: "Broken links", value: diagnosticCount.brokenLinks, tone: "text-amber-700" },
    { label: "Balance inconsistencies", value: diagnosticCount.balanceIssues, tone: "text-amber-700" },
    { label: "Missing categories", value: diagnosticCount.missingCategories, tone: "text-sky-700" },
    { label: "Ignored source rows", value: diagnosticCount.ignoredSource, tone: "text-violet-700" },
    { label: "Failed sync count", value: report.failed_sync_count, tone: "text-rose-700" },
  ];
  const missingColumns = report.missing_columns ?? [];

  return (
    <>
      <PageHeader
        title="Finance Health"
        subtitle="Finance is the source of truth. Every purchase and counted cash collection should land in financial_transactions with the right direction, amount, category, and live source link."
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Finance Health" }]}
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/finance">
              Open finance
            </SecondaryButton>
            <SecondaryButton href="/finance/transactions">
              Open ledger
            </SecondaryButton>
          </div>
        }
      />

      {rpcError ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Finance health RPC is not installed yet. Showing fallback table counts
          plus direct diagnostics from the current ledger. Supabase returned{" "}
          {String(rpcError.code ?? "an error")}:{" "}
          {String(rpcError.message ?? "Unknown database error")}.
        </div>
      ) : null}

      {diagnostics.errors.length ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-semibold">Some finance diagnostics could not fully load</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {diagnostics.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Schema status
          </div>
          <div className="mt-3">
            <StatusBadge status={report.schema_status ?? "unknown"} />
          </div>
          <p className="mt-3 text-sm text-slate-500">
            {missingColumns.length
              ? `Missing columns: ${missingColumns.join(", ")}`
              : "All expected ledger columns are present."}
          </p>
        </div>
        {cards.map((card) => (
          <div key={card.label} className="surface-card">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {card.label}
            </div>
            <div className={`mt-2 text-3xl font-semibold ${card.tone}`}>
              {numberValue(card.value)}
            </div>
          </div>
        ))}
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">
            Purchase sync
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Non-voided purchases with value should always have one active
            finance transaction linked by both source and purchase ids.
          </p>
          <dl className="mt-4 grid gap-3 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <dt>Total purchases expected in finance</dt>
              <dd className="font-semibold text-slate-900">
                {numberValue(report.purchases_count)}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
              <dt>Purchases with finance transaction</dt>
              <dd className="font-semibold">
                {numberValue(report.purchases_with_linked_finance_transaction)}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-rose-900">
              <dt>Purchases missing finance transaction</dt>
              <dd className="font-semibold">
                {numberValue(diagnosticCount.missingPurchases)}
              </dd>
            </div>
          </dl>
        </div>

        <div className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">
            Cash sync
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Counted cash collections should always have one active money-in
            finance transaction linked by both source and cash ids.
          </p>
          <dl className="mt-4 grid gap-3 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <dt>Total cash collections expected in finance</dt>
              <dd className="font-semibold text-slate-900">
                {numberValue(report.cash_collections_count)}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
              <dt>Cash with finance transaction</dt>
              <dd className="font-semibold">
                {numberValue(report.cash_collections_with_linked_finance_transaction)}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-rose-900">
              <dt>Cash missing finance transaction</dt>
              <dd className="font-semibold">
                {numberValue(diagnosticCount.missingCash)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <DiagnosticSection
        title="Purchases Missing Finance Transactions"
        description="Every valued purchase should have a linked money-out finance transaction."
        emptyTitle="No purchase sync gaps"
        emptyBody="Every purchase that should be represented in finance already has a linked finance row."
        table={
          diagnostics.purchasesMissingFinance.length ? (
            <DataTable headers={["Purchase", "Date", "Supplier", "Status", "Amount"]}>
              {diagnostics.purchasesMissingFinance.map((purchase) => (
                <tr key={purchase.id}>
                  <td>
                    <Link href={`/purchases/${purchase.id}`} className="font-medium text-slate-900 hover:underline">
                      {purchase.receiptNumber || purchase.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{textValue(purchase.orderDate)}</td>
                  <td>{textValue(purchase.supplierName)}</td>
                  <td>{textValue(`${purchase.status ?? "-"} / ${purchase.paymentStatus ?? "-"}`)}</td>
                  <td>{moneyValue(purchase.amount)}</td>
                </tr>
              ))}
            </DataTable>
          ) : null
        }
      />

      <DiagnosticSection
        title="Cash Collections Missing Finance Transactions"
        description="Every counted cash collection should have a linked money-in finance transaction."
        emptyTitle="No cash sync gaps"
        emptyBody="Every counted cash collection already has a linked finance row."
        table={
          diagnostics.cashCollectionsMissingFinance.length ? (
            <DataTable headers={["Collection", "Collected", "Machine", "Review", "Amount"]}>
              {diagnostics.cashCollectionsMissingFinance.map((cash) => (
                <tr key={cash.id}>
                  <td>
                    <Link href={`/cash-collections/${cash.id}`} className="font-medium text-slate-900 hover:underline">
                      {cash.cashBagId || cash.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{textValue(cash.collectedAt)}</td>
                  <td>{textValue(cash.machineName)}</td>
                  <td>{textValue(cash.reviewStatus)}</td>
                  <td>{moneyValue(cash.actualCashCollected)}</td>
                </tr>
              ))}
            </DataTable>
          ) : null
        }
      />

      <DiagnosticSection
        title="Broken Source Links"
        description="These finance rows no longer line up cleanly with their purchase or cash source record."
        emptyTitle="No broken source links"
        emptyBody="Every source-generated finance row still points to a valid purchase or cash collection."
        table={
          diagnostics.brokenLinks.length ? (
            <DataTable headers={["Finance row", "Source", "Linked id", "Reason", "Date"]}>
              {diagnostics.brokenLinks.map((issue) => (
                <tr key={`${issue.financeTransactionId}-${issue.reason}`}>
                  <td>
                    <Link href={`/finance/transactions/${issue.financeTransactionId}`} className="font-medium text-slate-900 hover:underline">
                      {issue.financeTransactionId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{textValue(`${issue.sourceType} / ${issue.sourceId ?? "-"}`)}</td>
                  <td>{textValue(issue.linkedId)}</td>
                  <td className="max-w-xl break-words text-sm">{issue.reason}</td>
                  <td>{textValue(issue.transactionDate)}</td>
                </tr>
              ))}
            </DataTable>
          ) : null
        }
      />

      <DiagnosticSection
        title="Balance Inconsistencies"
        description="These linked rows disagree with their source record on direction, signed amount, transaction effect, or source amount."
        emptyTitle="No balance inconsistencies"
        emptyBody="Source-generated finance rows match their purchase and cash source amounts and directions."
        table={
          diagnostics.balanceInconsistencies.length ? (
            <DataTable headers={["Source", "Finance row", "Source amount", "Finance amount", "Issue"]}>
              {diagnostics.balanceInconsistencies.map((issue) => (
                <tr key={`${issue.financeTransactionId}-${issue.sourceId}`}>
                  <td>
                    <div className="font-medium text-slate-900">{issue.label}</div>
                    <div className="text-xs text-slate-500">{issue.sourceType} / {issue.sourceId.slice(0, 8)}</div>
                  </td>
                  <td>
                    <Link href={`/finance/transactions/${issue.financeTransactionId}`} className="font-medium text-slate-900 hover:underline">
                      {issue.financeTransactionId.slice(0, 8)}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {textValue(issue.direction)} / {textValue(issue.transactionEffect)}
                    </div>
                  </td>
                  <td>{moneyValue(issue.sourceAmount)}</td>
                  <td>
                    <div>{moneyValue(issue.financeAmount)}</div>
                    <div className="text-xs text-slate-500">Signed {issue.signedAmount.toFixed(2)}</div>
                  </td>
                  <td className="max-w-xl break-words text-sm">{issue.issue}</td>
                </tr>
              ))}
            </DataTable>
          ) : null
        }
      />

      <DiagnosticSection
        title="Missing Categories"
        description='Any finance row without a category should fall back to "Uncategorized" instead of staying blank.'
        emptyTitle="No category gaps"
        emptyBody="Recent finance rows all have category, transaction type, and final bucket values."
        table={
          diagnostics.missingCategories.length ? (
            <DataTable headers={["Finance row", "Source", "Category label", "Transaction type", "Final bucket"]}>
              {diagnostics.missingCategories.map((issue) => (
                <tr key={issue.financeTransactionId}>
                  <td>
                    <Link href={`/finance/transactions/${issue.financeTransactionId}`} className="font-medium text-slate-900 hover:underline">
                      {issue.financeTransactionId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{textValue(issue.sourceType)}</td>
                  <td>{textValue(issue.category)}</td>
                  <td>{textValue(issue.transactionType)}</td>
                  <td>{textValue(issue.finalBucket)}</td>
                </tr>
              ))}
            </DataTable>
          ) : null
        }
      />

      <DiagnosticSection
        title="Ignored Source Rows"
        description="Source-generated finance rows should never be hidden with ignored or skipped import statuses."
        emptyTitle="No ignored source rows"
        emptyBody="All purchase and cash source rows are visible in the finance ledger."
        table={
          diagnostics.ignoredSourceRows.length ? (
            <DataTable headers={["Finance row", "Source", "Import status", "Description", "Date"]}>
              {diagnostics.ignoredSourceRows.map((issue) => (
                <tr key={issue.financeTransactionId}>
                  <td>
                    <Link href={`/finance/transactions/${issue.financeTransactionId}`} className="font-medium text-slate-900 hover:underline">
                      {issue.financeTransactionId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{textValue(`${issue.sourceType} / ${issue.sourceId ?? "-"}`)}</td>
                  <td>{textValue(issue.importStatus)}</td>
                  <td className="max-w-xl break-words text-sm">{textValue(issue.description)}</td>
                  <td>{textValue(issue.transactionDate)}</td>
                </tr>
              ))}
            </DataTable>
          ) : null
        }
      />

      <section className="mb-6 surface-card">
        <h2 className="text-base font-semibold text-slate-900">
          Overview source types
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          The default finance overview should include purchase, cash_collection,
          manual, and import rows without hiding source-generated money
          movements.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(report.source_types_in_overview ?? [
            "purchase",
            "cash_collection",
            "manual",
            "import",
          ]).map((sourceType) => (
            <span
              key={sourceType}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
            >
              {sourceType}
            </span>
          ))}
        </div>
      </section>

      <section className="mb-6 surface-card">
        <h2 className="text-base font-semibold text-slate-900">
          Selected column contract
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Finance pages try these ledger columns first, then fall back to older
          safe subsets if Supabase reports schema drift.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {FINANCE_TRANSACTION_FULL_COLUMNS.map((column) => (
            <span
              key={column}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${missingColumns.includes(column) ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-700"}`}
            >
              {column}
            </span>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">
          financial_transactions columns
        </h2>
        {report.schema_columns?.length ? (
          <DataTable headers={["Column", "Type", "Nullable", "Default"]}>
            {report.schema_columns.map((column) => (
              <tr key={column.column_name}>
                <td className="font-medium text-slate-900">
                  {column.column_name}
                </td>
                <td>{column.data_type}</td>
                <td>{column.is_nullable}</td>
                <td className="max-w-md break-words text-xs">
                  {column.column_default ?? "-"}
                </td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState
            title="Schema details unavailable"
            body="Install the finance health migration to show every column, constraint, and index."
          />
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">
          Constraints
        </h2>
        {report.constraints?.length ? (
          <DataTable headers={["Constraint", "Type", "Definition"]}>
            {report.constraints.map((constraint) => (
              <tr key={constraint.constraint_name}>
                <td className="font-medium text-slate-900">
                  {constraint.constraint_name}
                </td>
                <td>{constraint.constraint_type}</td>
                <td className="max-w-xl break-words text-xs">
                  {constraint.definition || "-"}
                </td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState
            title="No constraints loaded"
            body="Constraint details are available after the finance health RPC is installed."
          />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Indexes</h2>
        {report.indexes?.length ? (
          <DataTable headers={["Index", "Definition"]}>
            {report.indexes.map((index) => (
              <tr key={index.indexname}>
                <td className="font-medium text-slate-900">
                  {index.indexname}
                </td>
                <td className="max-w-3xl break-words text-xs">
                  {index.indexdef}
                </td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState
            title="No indexes loaded"
            body="Index details are available after the finance health RPC is installed."
          />
        )}
      </section>
    </>
  );
}
