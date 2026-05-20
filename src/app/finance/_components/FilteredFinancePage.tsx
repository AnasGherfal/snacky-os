import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { isBalanceAffectingTransaction, signedAmount } from "@/lib/finance-balance";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export type FinanceFilteredPageConfig = {
  title: string;
  subtitle: string;
  breadcrumbLabel: string;
  emptyTitle: string;
  emptyBody: string;
  filter: (row: any) => boolean;
};

function categoryLabel(row: any) {
  return row.final_bucket ?? row.transaction_type ?? String(row.transaction_kind ?? "transaction").replaceAll("_", " ");
}

export function financeRowText(row: any) {
  return [row.transaction_kind, row.transaction_type, row.description, row.notes, row.final_bucket, row.payment_method]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export async function FilteredFinancePage(config: FinanceFilteredPageConfig) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Finance unavailable" body="Supabase is not configured, so Snacky OS cannot load finance data." />
      </>
    );
  }

  const { data, error } = await supabase
    .from("financial_transactions")
    .select("id, transaction_date, direction, transaction_kind, transaction_type, description, notes, signed_amount, final_bucket, payment_method, transaction_status, review_status, needs_review")
    .eq("transaction_status", "active")
    .order("transaction_date", { ascending: false })
    .limit(1000);

  if (error) {
    console.error("[finance] Failed to load filtered finance page", error);
    return (
      <>
        <ErrorState title="Could not load finance" body="Snacky OS could not load active financial transactions from Supabase." action={<SecondaryButton href="/finance">Retry</SecondaryButton>} />
      </>
    );
  }

  const rows = ((data ?? []) as any[]).filter(config.filter);
  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const total = balanceRows.reduce((sum, row) => sum + signedAmount(row), 0);

  return (
    <>
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        breadcrumbs={[
          { label: "Finance", href: "/finance" },
          { label: config.breadcrumbLabel },
        ]}
        action={<SecondaryButton href="/finance/transactions">Open ledger</SecondaryButton>}
      />

      <section className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Rows shown</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{rows.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Balance-impact total</div>
          <div className={`mt-1 text-3xl font-semibold ${total < 0 ? "text-rose-700" : "text-emerald-700"}`}>{lyd(total)}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Source</div>
          <div className="mt-2 text-base font-semibold text-slate-900">Active finance ledger</div>
        </div>
      </section>

      {!rows.length ? (
        <EmptyState title={config.emptyTitle} body={config.emptyBody} />
      ) : (
        <DataTable headers={["Date", "Direction", "Category", "Amount", "Description", "Payment", "Review", "Actions"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.transaction_date}</td>
              <td><StatusBadge status={String(row.direction ?? "").replaceAll("_", " ")} /></td>
              <td className="font-medium text-slate-900">{categoryLabel(row)}</td>
              <td className={`font-semibold ${Number(row.signed_amount ?? 0) < 0 ? "text-rose-700" : "text-emerald-700"}`}>{lyd(Number(row.signed_amount ?? 0))}</td>
              <td className="max-w-md">{row.description ?? row.notes ?? "-"}</td>
              <td>{row.payment_method ? String(row.payment_method).replaceAll("_", " ") : "-"}</td>
              <td><StatusBadge status={row.needs_review ? "needs_review" : row.review_status} /></td>
              <td><Link href={`/finance/transactions/${row.id}`} className="btn-secondary">View</Link></td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
