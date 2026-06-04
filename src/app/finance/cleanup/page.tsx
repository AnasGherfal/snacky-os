import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canEditFinancialTransactions, canViewFinancials } from "@/lib/authz";
import { accountCurrency, accountLabel, FINANCE_RECONCILIATION_CUTOFF_DATE, formatFinanceMoney } from "@/lib/finance-balance";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type CleanupIssue = {
  key: string;
  title: string;
  rows: any[];
  description: string;
};

function financeAllowed(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return profile && canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });
}

function text(row: any) {
  return [row.category, row.final_bucket, row.transaction_type, row.description, row.notes, row.counterparty_text, row.payer_text, row.paid_to_text, row.payee_text].map((value) => String(value ?? "").toLowerCase()).join(" ");
}

function hasOwnerFundingText(row: any) {
  const value = text(row);
  return value.includes("owner funding") || value.includes("to snacky") || value.includes("funding");
}

function hasOwnerWithdrawalText(row: any) {
  const value = text(row);
  return value.includes("owner withdrawal") || value.includes("owner draw") || value.includes("anas");
}

function addIssue(issues: CleanupIssue[], key: string, title: string, description: string, rows: any[]) {
  if (rows.length) issues.push({ key, title, description, rows });
}

function duplicateRows(rows: any[]) {
  const byKey = new Map<string, any[]>();
  rows.forEach((row) => {
    const sourceKey = row.source_file && row.source_sheet && row.source_row ? `source:${row.source_file}:${row.source_sheet}:${row.source_row}` : "";
    const businessKey = `business:${row.transaction_date}:${row.amount}:${row.currency}:${String(row.description ?? row.original_description ?? "").trim().toLowerCase()}:${row.account_id ?? ""}:${row.transaction_effect ?? ""}`;
    const key = sourceKey || businessKey;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  });
  return Array.from(byKey.values()).filter((group) => group.length > 1).flat();
}

function cleanupIssues(rows: any[]) {
  const activeRows = rows.filter((row) => (row.transaction_status ?? "active") === "active");
  const issues: CleanupIssue[] = [];

  addIssue(
    issues,
    "from_to_not_transfer",
    "Transaction has from/to but is not a transfer",
    "These rows have source or destination accounts even though the transaction effect is income or expense.",
    activeRows.filter((row) => row.transaction_effect !== "transfer" && (row.source_account_id || row.destination_account_id)),
  );
  addIssue(
    issues,
    "owner_funding_income",
    "Owner funding counted as revenue",
    "Owner funding should be a transfer from Owner to Snacky, not income/profit.",
    activeRows.filter((row) => row.transaction_effect === "income" && hasOwnerFundingText(row)),
  );
  addIssue(
    issues,
    "owner_withdrawal_expense",
    "Owner withdrawal counted as expense",
    "Owner withdrawal should be a transfer from Snacky to Owner, not business expense/profit loss.",
    activeRows.filter((row) => row.transaction_effect === "expense" && hasOwnerWithdrawalText(row)),
  );
  addIssue(
    issues,
    "missing_category",
    "Missing category",
    "These rows need a category before finance reporting can be trusted.",
    activeRows.filter((row) => !String(row.category ?? row.final_bucket ?? "").trim()),
  );
  addIssue(
    issues,
    "wrong_currency",
    "Wrong currency",
    "Account currency and row currency do not match, or a transfer crosses currencies without an exchange workflow.",
    activeRows.filter((row) => {
      if (row.transaction_effect === "transfer") {
        return !row.source_account_id || !row.destination_account_id || accountCurrency(row.source_account_id) !== accountCurrency(row.destination_account_id) || accountCurrency(row.source_account_id) !== row.currency;
      }
      return row.account_id && accountCurrency(row.account_id) !== row.currency;
    }),
  );
  addIssue(
    issues,
    "blank_account",
    "Blank account",
    "These rows do not have the account needed to calculate balances.",
    activeRows.filter((row) => row.transaction_effect === "transfer" ? !row.source_account_id || !row.destination_account_id : !row.account_id),
  );
  addIssue(
    issues,
    "duplicate_import_row",
    "Duplicate import row",
    "Potential duplicate source rows or duplicate business rows after the cutoff.",
    duplicateRows(activeRows),
  );

  return issues;
}

export default async function FinanceCleanupPage() {
  const profile = await getCurrentProfile();
  if (!financeAllowed(profile)) redirect("/unauthorized");
  const canEdit = profile && canEditFinancialTransactions({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return <EmptyState title="Finance cleanup unavailable" body="Supabase is not configured." />;
  }

  const { data, error } = await supabase
    .from("financial_transactions")
    .select("id, transaction_date, direction, transaction_kind, transaction_type, description, notes, amount, signed_amount, currency, account_id, transaction_effect, source_account_id, destination_account_id, category, final_bucket, payer_text, paid_to_text, payee_text, counterparty_text, source_file, source_sheet, source_row, original_description, transaction_status, import_status, needs_review")
    .gt("transaction_date", FINANCE_RECONCILIATION_CUTOFF_DATE)
    .order("transaction_date", { ascending: false })
    .limit(10000);

  const rows = (data ?? []) as any[];
  const issues = cleanupIssues(rows);

  return (
    <>
      <PageHeader
        title="Finance Cleanup / Needs Review"
        subtitle={`Diagnostics for active finance rows after ${FINANCE_RECONCILIATION_CUTOFF_DATE}. Opening balances and older rows are not included.`}
        breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: "Cleanup" }]}
        action={<SecondaryButton href="/finance/transactions?review=needs_review">Open review queue</SecondaryButton>}
      />
      {error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Could not load cleanup diagnostics: {error.message}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 md:grid-cols-3">
        <div className="surface-card"><div className="text-sm text-slate-500">Rows checked</div><div className="mt-1 text-3xl font-semibold">{rows.length}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Issue groups</div><div className="mt-1 text-3xl font-semibold">{issues.length}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Rows needing attention</div><div className="mt-1 text-3xl font-semibold">{new Set(issues.flatMap((issue) => issue.rows.map((row) => row.id))).size}</div></div>
      </section>

      {!issues.length ? (
        <EmptyState title="No cleanup issues found" body="Post-cutoff finance rows passed the current diagnostics." />
      ) : (
        <div className="space-y-6">
          {issues.map((issue) => (
            <section key={issue.key} className="surface-card">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{issue.title}</h2>
                  <p className="mt-1 text-sm text-slate-500">{issue.description}</p>
                </div>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">{issue.rows.length} row{issue.rows.length === 1 ? "" : "s"}</span>
              </div>
              <DataTable headers={["Date", "Category", "Amount", "Account", "Effect", "Source", "Action"]}>
                {issue.rows.slice(0, 20).map((row) => (
                  <tr key={`${issue.key}-${row.id}`}>
                    <td>{row.transaction_date}</td>
                    <td>{row.category ?? row.final_bucket ?? "-"}</td>
                    <td>{formatFinanceMoney(Number(row.signed_amount ?? row.amount ?? 0), row.currency ?? "LYD")}</td>
                    <td>{row.transaction_effect === "transfer" ? `${accountLabel(row.source_account_id)} -> ${accountLabel(row.destination_account_id)}` : accountLabel(row.account_id)}</td>
                    <td><StatusBadge status={row.transaction_effect ?? row.direction} /></td>
                    <td>{row.source_sheet ? `${row.source_sheet}:${row.source_row}` : row.transaction_kind}</td>
                    <td>{canEdit ? <Link href={`/finance/transactions/${row.id}/edit`} className="btn-secondary">Fix</Link> : <Link href={`/finance/transactions/${row.id}`} className="btn-secondary">View</Link>}</td>
                  </tr>
                ))}
              </DataTable>
              {issue.rows.length > 20 ? <p className="mt-3 text-sm text-slate-500">Showing first 20 rows in this group.</p> : null}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
