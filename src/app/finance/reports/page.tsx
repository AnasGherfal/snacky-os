/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from "next/navigation";
import {
  DataTable,
  EmptyState,
  PageHeader,
  SecondaryButton,
} from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import {
  formatFinanceMoney,
  isBalanceAffectingTransaction,
  signedAmount,
} from "@/lib/finance-balance";
import {
  FINANCE_TRANSACTIONS_TABLE,
  loadFinanceLedgerRows,
  supabaseErrorDetails,
} from "@/lib/finance-ledger";

export const dynamic = "force-dynamic";

export default async function FinanceReportsPage() {
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
  )
    redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  const result = supabase
    ? await loadFinanceLedgerRows({
        label: "finance reports",
        buildQuery: (columns, level) => {
          let query = supabase
            .from(FINANCE_TRANSACTIONS_TABLE)
            .select(columns.join(", "))
            .order("transaction_date", { ascending: false })
            .limit(2000);
          if (level !== "legacy")
            query = query.eq("transaction_status", "active");
          return query;
        },
      })
    : {
        data: [],
        error: null,
        warning: null,
        selectedColumns: [],
        count: 0,
        level: "legacy" as const,
      };
  if (result.error) {
    console.error("[finance] Reports fell back to empty ledger rows", {
      table: FINANCE_TRANSACTIONS_TABLE,
      selected_columns: result.selectedColumns,
      supabase_error: supabaseErrorDetails(result.error),
    });
  }
  const rows = result.data.filter(
    (row) => row.transaction_status === "active",
  ) as any[];
  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const totals = balanceRows.reduce(
    (sum, row) => {
      const currency =
        String(row.currency ?? "LYD").toUpperCase() === "USD" ? "USD" : "LYD";
      const signed = signedAmount(row);
      if (row.direction === "money_in") sum.in[currency] += signed;
      if (row.direction === "money_out") sum.out[currency] += Math.abs(signed);
      sum.net[currency] += signed;
      return sum;
    },
    {
      in: { LYD: 0, USD: 0 },
      out: { LYD: 0, USD: 0 },
      net: { LYD: 0, USD: 0 },
    },
  );
  const byBucket = new Map<string, number>();
  balanceRows
    .filter((row) => String(row.currency ?? "LYD").toUpperCase() !== "USD")
    .forEach((row) =>
      byBucket.set(
        row.final_bucket ?? "Unbucketed",
        (byBucket.get(row.final_bucket ?? "Unbucketed") ?? 0) +
          signedAmount(row),
      ),
    );
  const bucketRows = Array.from(byBucket.entries())
    .map(([bucket, amount]) => ({ bucket, amount }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return (
    <>
      <PageHeader
        title="Finance Reports"
        subtitle="Active money in/out from Snacky OS financial transactions."
        action={
          <SecondaryButton href="/finance">Back to finance</SecondaryButton>
        }
      />
      {result.warning || result.error ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {result.error
            ? "No finance transactions loaded. Reports are available, but the ledger query failed while the schema is being repaired."
            : result.warning}
        </div>
      ) : null}
      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">LYD net</div>
          <div className="mt-1 text-3xl font-semibold">
            {formatFinanceMoney(totals.net.LYD, "LYD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">USD net</div>
          <div className="mt-1 text-3xl font-semibold">
            {formatFinanceMoney(totals.net.USD, "USD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">LYD in / out</div>
          <div className="mt-1 text-lg font-semibold">
            {formatFinanceMoney(totals.in.LYD, "LYD")} /{" "}
            {formatFinanceMoney(totals.out.LYD, "LYD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Needs review</div>
          <div className="mt-1 text-3xl font-semibold">
            {rows.filter((row) => row.needs_review).length}
          </div>
        </div>
      </section>
      {!bucketRows.length ? (
        <EmptyState
          title="No finance data yet"
          body="Import historical transactions or add manual transactions to populate reports."
        />
      ) : (
        <DataTable headers={["Bucket", "Net amount"]}>
          {bucketRows.map((row) => (
            <tr key={row.bucket}>
              <td>{row.bucket}</td>
              <td className="font-semibold">
                {formatFinanceMoney(row.amount, "LYD")}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
