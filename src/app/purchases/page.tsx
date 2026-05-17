import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error = "" } = await searchParams;
  const supabase = getSupabaseServerClient();
  const { data: purchases } = supabase
    ? await supabase
        .from("purchase_orders")
        .select("id, order_date, receipt_number, total_amount, manual_total_lyd, calculated_total_lyd, payment_method, status, created_at, supplier:suppliers(name), created_by_member:team_members!purchase_orders_created_by_fkey(full_name)")
        .order("order_date", { ascending: false })
        .order("created_at", { ascending: false })
    : { data: [] };

  return (
    <AppShell>
      <PageHeader title="Purchases" subtitle="Receive supplier stock into storage through the inventory ledger." action={<PrimaryButton href="/purchases/new">New purchase</PrimaryButton>} />
      {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {!purchases?.length ? (
        <EmptyState title="No purchases yet" body="Create a purchase when stock arrives from a supplier." />
      ) : (
        <DataTable headers={["Date", "Supplier", "Receipt", "Total", "Payment", "Status", "Created by", "Actions"]}>
          {purchases.map((purchase: any) => (
            <tr key={purchase.id}>
              <td>{purchase.order_date}</td>
              <td>{purchase.supplier?.name ?? "-"}</td>
              <td>{purchase.receipt_number ?? "-"}</td>
              <td>{lyd(Number(purchase.manual_total_lyd ?? purchase.total_amount ?? purchase.calculated_total_lyd ?? 0))}</td>
              <td>{String(purchase.payment_method ?? "-").replaceAll("_", " ")}</td>
              <td><StatusBadge status={purchase.status} /></td>
              <td>{purchase.created_by_member?.full_name ?? "-"}</td>
              <td><div className="flex flex-wrap gap-2"><Link href={`/purchases/${purchase.id}`} className="btn-secondary">View</Link>{purchase.status === "draft" ? <Link href={`/purchases/${purchase.id}/edit`} className="btn-secondary">Edit</Link> : null}</div></td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
