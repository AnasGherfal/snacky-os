/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import {
  formatFinanceMoney,
  isBalanceAffectingTransaction,
  signedAmount,
} from "@/lib/finance-balance";
import {
  FINANCE_TRANSACTIONS_TABLE,
  type FinanceLedgerLevel,
  isFinancePermissionError,
  loadFinanceLedgerRows,
  supabaseErrorDetails,
} from "@/lib/finance-ledger";
import {
  cleanSearchParams,
  getPagination,
  SearchParamsRecord,
} from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export type FinanceFilteredPageConfig = {
  title: string;
  subtitle: string;
  breadcrumbLabel: string;
  emptyTitle: string;
  emptyBody: string;
  basePath: string;
  searchParams?: SearchParamsRecord;
  applyQuery?: (query: any, level: FinanceLedgerLevel) => any;
  filter: (row: any) => boolean;
};

function categoryLabel(row: any) {
  return (
    row.category ??
    row.final_bucket ??
    row.transaction_type ??
    String(row.transaction_kind ?? "transaction").replaceAll("_", " ")
  );
}

export function financeRowText(row: any) {
  return [
    row.transaction_kind,
    row.transaction_type,
    row.description,
    row.notes,
    row.final_bucket,
    row.payment_method,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export async function FilteredFinancePage(config: FinanceFilteredPageConfig) {
  const profile = await getCurrentProfile();
  if (
    !profile ||
    !canViewFinancials({
      id: profile.id,
      role: profile.role,
      roles: profile.roles,
      canAddProducts: profile.can_add_products,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    })
  ) {
    redirect("/unauthorized");
  }

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

  const params = cleanSearchParams(config.searchParams ?? {});
  const { page, pageSize, from, to } = getPagination(params);
  const result = await loadFinanceLedgerRows({
    label: `filtered finance page ${config.basePath}`,
    buildQuery: (columns, level) => {
      let query = supabase
        .from(FINANCE_TRANSACTIONS_TABLE)
        .select(columns.join(", "), { count: "exact" })
        .order("transaction_date", { ascending: false });
      if (level !== "legacy") query = query.eq("transaction_status", "active");
      if (config.applyQuery) query = config.applyQuery(query, level);
      return query.range(from, to);
    },
  });

  if (result.error) {
    const details = supabaseErrorDetails(result.error);
    const permissionFailure = isFinancePermissionError(result.error);
    console.error(
      "[finance] Filtered finance page fell back to an empty state",
      {
        table: FINANCE_TRANSACTIONS_TABLE,
        selected_columns: result.selectedColumns,
        supabase_error: details,
        base_path: config.basePath,
      },
    );
    if (permissionFailure) {
      return (
        <>
          <ErrorState
            title="Finance permission required"
            body={`Supabase denied SELECT on ${FINANCE_TRANSACTIONS_TABLE}: ${String(details.message ?? "Permission denied")}.`}
            action={<SecondaryButton href="/finance">Retry</SecondaryButton>}
          />
        </>
      );
    }
  }

  const rows = result.data
    .filter((row) => row.transaction_status === "active")
    .filter(config.filter);
  const count = result.count;
  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const totals = balanceRows.reduce(
    (sum, row) => {
      const currency =
        String(row.currency ?? "LYD").toUpperCase() === "USD" ? "USD" : "LYD";
      sum[currency] += signedAmount(row);
      return sum;
    },
    { LYD: 0, USD: 0 },
  );

  return (
    <>
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        breadcrumbs={[
          { label: "Finance", href: "/finance" },
          { label: config.breadcrumbLabel },
        ]}
        action={
          <SecondaryButton href="/finance/transactions">
            Open ledger
          </SecondaryButton>
        }
      />

      {result.warning || result.error ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {result.error
            ? "No finance transactions loaded. The ledger query failed, but this page is available for navigation while the schema is repaired."
            : result.warning}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Rows shown</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">
            {rows.length}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Balance-impact LYD</div>
          <div
            className={`mt-1 text-3xl font-semibold ${totals.LYD < 0 ? "text-rose-700" : "text-emerald-700"}`}
          >
            {formatFinanceMoney(totals.LYD, "LYD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Balance-impact USD</div>
          <div
            className={`mt-1 text-3xl font-semibold ${totals.USD < 0 ? "text-rose-700" : "text-emerald-700"}`}
          >
            {formatFinanceMoney(totals.USD, "USD")}
          </div>
        </div>
      </section>

      {!rows.length ? (
        <EmptyState title={config.emptyTitle} body={config.emptyBody} />
      ) : (
        <>
          <DataTable
            headers={[
              "Date",
              "Direction",
              "Category",
              "Amount",
              "Description",
              "Payment",
              "Review",
              "Actions",
            ]}
          >
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.transaction_date}</td>
                <td>
                  <StatusBadge
                    status={String(row.direction ?? "").replaceAll("_", " ")}
                  />
                </td>
                <td className="font-medium text-slate-900">
                  {categoryLabel(row)}
                </td>
                <td
                  className={`font-semibold ${Number(row.signed_amount ?? 0) < 0 ? "text-rose-700" : "text-emerald-700"}`}
                >
                  {formatFinanceMoney(
                    Number(row.signed_amount ?? 0),
                    row.currency ?? "LYD",
                  )}
                </td>
                <td className="max-w-md">
                  {row.description ?? row.notes ?? "-"}
                </td>
                <td>
                  {row.payment_method
                    ? String(row.payment_method).replaceAll("_", " ")
                    : "-"}
                </td>
                <td>
                  <StatusBadge
                    status={
                      row.needs_review ? "needs_review" : row.review_status
                    }
                  />
                </td>
                <td>
                  <Link
                    href={`/finance/transactions/${row.id}`}
                    className="btn-secondary"
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls
            basePath={config.basePath}
            searchParams={params}
            page={page}
            pageSize={pageSize}
            totalCount={count ?? 0}
            itemLabel="transactions"
          />
        </>
      )}
    </>
  );
}
