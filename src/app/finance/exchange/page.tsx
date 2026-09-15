import Link from "next/link";
import { BusinessRecordForm } from "@/components/BusinessRecordForm";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { accountLabel, formatFinanceMoney } from "@/lib/finance-balance";
import { businessDate } from "@/lib/business-record-validation";

export const dynamic = "force-dynamic";
export default async function CurrencyExchangePage() {
  const profile = await requireCurrentProfileForPath("/finance/exchange");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Currency exchanges unavailable" body="Could not connect to Finance. Nothing has been recorded." />;
  const { data: exchanges, error } = await supabase.from("financial_transactions")
    .select("id, transaction_date, amount, transfer_destination_amount, source_account_id, destination_account_id, exchange_rate_usd_to_lyd, transaction_status, notes")
    .eq("source_type", "currency_exchange").order("transaction_date", { ascending: false }).order("created_at", { ascending: false }).limit(100);
  if (error) return <ErrorState title="Could not load currency exchanges" body="The currency-exchange database update may not be active, or Finance could not be loaded. Retry before recording an exchange." action={<SecondaryButton href="/finance/exchange">Retry</SecondaryButton>} />;
  return <>
    <PageHeader title="Buy USD / شراء الدولار" subtitle="Record the LYD you paid and the USD you received. This is an account transfer, not a supplier payment." breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: "Buy USD" }]} />
    {hasPermission(profile, "finance.edit") ? <BusinessRecordForm kind="exchange" userId={profile.id} today={businessDate()} /> : null}
    <section className="surface-card mt-6">
      <h2 className="mb-4 text-lg font-semibold">Currency exchange history / سجل شراء الدولار</h2>
      {!exchanges?.length ? <EmptyState title="No exchanges recorded here yet" body="New exchanges will appear here and in Finance → Transactions. Historical imports remain in their existing ledger records." /> : <DataTable headers={["Date", "LYD paid", "USD received", "Accounts", "LYD per USD", "Status", "Note", "Record"]}>
        {exchanges.map((entry) => <tr key={entry.id}>
          <td>{entry.transaction_date}</td><td>{formatFinanceMoney(Number(entry.amount), "LYD")}</td><td>{formatFinanceMoney(Number(entry.transfer_destination_amount), "USD")}</td>
          <td>{accountLabel(entry.source_account_id)} → {accountLabel(entry.destination_account_id)}</td><td>{Number(entry.exchange_rate_usd_to_lyd).toFixed(6)}</td>
          <td><StatusBadge status={entry.transaction_status} /></td><td>{entry.notes ?? "—"}</td><td><Link className="link-secondary" href={`/finance/transactions/${entry.id}`}>View</Link></td>
        </tr>)}
      </DataTable>}
      {exchanges && exchanges.length >= 100 ? <p className="mt-3 text-sm">Showing the latest 100 exchanges. <Link className="underline" href="/finance/transactions">Open the full Finance ledger.</Link></p> : null}
    </section>
  </>;
}
