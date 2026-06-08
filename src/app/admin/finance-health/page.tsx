import { redirect } from "next/navigation";
import {
  DataTable,
  EmptyState,
  PageHeader,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import {
  FINANCE_TRANSACTION_FULL_COLUMNS,
  FINANCE_TRANSACTIONS_TABLE,
  supabaseErrorDetails,
} from "@/lib/finance-ledger";
import { getSupabaseServerClient } from "@/lib/supabase-server";

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
  failed_sync_count?: number;
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

async function countRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  table: string,
) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });
  if (error) return { count: 0, error };
  return { count: count ?? 0, error: null };
}

async function loadFallbackHealth(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
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

export default async function FinanceHealthPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <EmptyState
        title="Finance health unavailable"
        body="Supabase is not configured, so Snacky OS cannot audit the finance ledger."
      />
    );
  }

  const healthResult = await supabase.rpc("finance_health_report");
  const fallback = healthResult.error
    ? await loadFallbackHealth(supabase)
    : null;
  const report = (
    healthResult.error ? fallback?.report : healthResult.data
  ) as HealthReport;
  const rpcError = healthResult.error
    ? supabaseErrorDetails(healthResult.error)
    : null;
  if (healthResult.error)
    console.error(
      "[finance-health] finance_health_report RPC failed",
      rpcError,
    );

  const cards = [
    { label: "Transactions", value: report.transactions_count },
    { label: "Purchases", value: report.purchases_count },
    { label: "Cash collections", value: report.cash_collections_count },
    {
      label: "Purchases missing finance",
      value: report.purchases_missing_finance_transaction,
    },
    {
      label: "Cash missing finance",
      value: report.cash_collections_missing_finance_transaction,
    },
    { label: "Failed sync count", value: report.failed_sync_count },
  ];
  const missingColumns = report.missing_columns ?? [];

  return (
    <>
      <PageHeader
        title="Finance Health"
        subtitle="Admin-only ledger health checks for schema drift, source linkage, and sync gaps. Finance feature work is frozen until this page and the ledger load cleanly."
        breadcrumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Finance Health" },
        ]}
        action={
          <SecondaryButton href="/finance/transactions">
            Open ledger
          </SecondaryButton>
        }
      />

      {rpcError ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Finance health RPC is not installed yet. Showing fallback table counts
          only. Supabase returned {String(rpcError.code ?? "an error")}:{" "}
          {String(rpcError.message ?? "Unknown database error")}.
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {numberValue(card.value)}
            </div>
          </div>
        ))}
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
