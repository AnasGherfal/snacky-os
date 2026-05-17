import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { reviewFinancialTransaction } from "@/lib/finance-actions";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function canAccess(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return profile && canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });
}

export default async function FinanceTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; review?: string; direction?: string; kind?: string; date_from?: string; date_to?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!canAccess(profile)) redirect("/unauthorized");
  const params = await searchParams;
  const supabase = getSupabaseServerClient();

  let query = supabase
    ?.from("financial_transactions")
    .select("id, transaction_date, direction, transaction_kind, transaction_type, location, description, amount, signed_amount, final_bucket, review_status, needs_review, source_sheet, source_row, related_purchase_id, related_cash_collection_id, created_at")
    .order("transaction_date", { ascending: false })
    .limit(500);

  if (query && params.review === "needs_review") query = query.eq("needs_review", true);
  if (query && params.direction) query = query.eq("direction", params.direction);
  if (query && params.kind) query = query.eq("transaction_kind", params.kind);
  if (query && params.date_from) query = query.gte("transaction_date", params.date_from);
  if (query && params.date_to) query = query.lte("transaction_date", params.date_to);

  const { data } = query ? await query : { data: [] };
  const search = String(params.q ?? "").trim().toLowerCase();
  const rows = ((data ?? []) as any[]).filter((row) => {
    if (!search) return true;
    return [row.transaction_type, row.location, row.description, row.final_bucket, row.source_sheet].join(" ").toLowerCase().includes(search);
  });

  return (
    <AppShell>
      <PageHeader title="Financial Transactions" subtitle="Money in/out ledger. Spreadsheet rows are import history only; Snacky OS is the source of truth." action={<PrimaryButton href="/finance/transactions/new">Add transaction</PrimaryButton>} />

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <input name="q" defaultValue={params.q ?? ""} placeholder="Search description, location, bucket..." className="field-input xl:col-span-2" />
          <select name="review" defaultValue={params.review ?? ""} className="field-input"><option value="">All review states</option><option value="needs_review">Needs review</option></select>
          <select name="direction" defaultValue={params.direction ?? ""} className="field-input"><option value="">All directions</option><option value="money_in">Money in</option><option value="money_out">Money out</option></select>
          <select name="kind" defaultValue={params.kind ?? ""} className="field-input"><option value="">All kinds</option><option value="spreadsheet_import">Spreadsheet import</option><option value="manual_money_in">Manual money in</option><option value="manual_money_out">Manual money out</option><option value="product_purchase">Product purchase</option><option value="cash_collection">Cash collection</option></select>
          <input name="date_from" type="date" defaultValue={params.date_from ?? ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={params.date_to ?? ""} className="field-input" />
          <div className="flex gap-2"><button className="btn-primary">Filter</button><Link href="/finance/transactions" className="btn-secondary">Reset</Link></div>
        </form>
      </section>

      {!rows.length ? (
        <EmptyState title="No finance transactions found" body="Import the historical CSV or add manual transactions to populate this ledger." />
      ) : (
        <DataTable headers={["Date", "Direction", "Type", "Description", "Location", "Amount", "Bucket", "Source", "Review"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.transaction_date}</td>
              <td><StatusBadge status={row.direction.replace("_", " ")} /></td>
              <td>{row.transaction_type ?? row.transaction_kind.replaceAll("_", " ")}</td>
              <td className="max-w-md">{row.description ?? "-"}</td>
              <td>{row.location ?? "-"}</td>
              <td className="font-semibold">{lyd(Number(row.signed_amount ?? 0))}</td>
              <td>{row.final_bucket ?? "-"}</td>
              <td>{row.source_sheet ? `${row.source_sheet}:${row.source_row}` : row.related_purchase_id ? "purchase" : row.related_cash_collection_id ? "cash collection" : "manual"}</td>
              <td>
                {row.needs_review ? (
                  <details>
                    <summary className="cursor-pointer"><StatusBadge status="needs_review" /></summary>
                    <form action={reviewFinancialTransaction} className="mt-3 grid min-w-80 gap-2 rounded-lg border border-slate-200 bg-white p-3">
                      <input type="hidden" name="id" value={row.id} />
                      <input type="date" name="transaction_date" defaultValue={row.transaction_date} className="field-input" />
                      <select name="direction" defaultValue={row.direction} className="field-input"><option value="money_in">Money in</option><option value="money_out">Money out</option></select>
                      <input name="transaction_type" defaultValue={row.transaction_type ?? ""} placeholder="Transaction type" className="field-input" />
                      <input name="location" defaultValue={row.location ?? ""} placeholder="Location" className="field-input" />
                      <textarea name="description" defaultValue={row.description ?? ""} rows={3} className="field-input" />
                      <input name="amount" type="number" step="0.01" defaultValue={row.amount} className="field-input" />
                      <input name="final_bucket" defaultValue={row.final_bucket ?? ""} placeholder="Final bucket" className="field-input" />
                      <textarea name="review_notes" rows={2} placeholder="Review notes" className="field-input" />
                      <button className="btn-primary">Mark reviewed</button>
                    </form>
                  </details>
                ) : <StatusBadge status={row.review_status} />}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
