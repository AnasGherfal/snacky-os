import Link from "next/link";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ error?: string; module?: string }> }) {
  const { error = "", module = "" } = await searchParams;
  const moduleQuery = module === "finance" ? "?module=finance" : "";
  const profile = await requireCurrentProfileForPath("/purchases");
  const canCreatePurchase = isOwnerAdminRole(profile?.role) || isSupervisorRole(profile?.role) || profile?.role === "warehouse";
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Purchases unavailable" body="Supabase is not configured, so Snacky OS cannot load purchases." />
      </>
    );
  }
  const { data: purchases, error: purchasesError } = await supabase
    .from("purchase_orders")
    .select("id, order_date, receipt_number, total_amount, manual_total_lyd, calculated_total_lyd, payment_method, payment_status, status, created_at, supplier:suppliers(name), created_by_member:team_members!purchase_orders_created_by_fkey(full_name)")
    .order("order_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (purchasesError) {
    console.error("[purchases] Failed to load purchases", purchasesError);
    return (
      <>
        <ErrorState title="Could not load purchases" body="Snacky OS could not load supplier purchase records from Supabase." action={<SecondaryButton href="/purchases">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Receive supplier stock into storage through the inventory ledger."
        breadcrumbs={[
          { label: module === "finance" ? "Finance" : "Inventory", href: module === "finance" ? "/finance" : "/inventory" },
          { label: "Purchases" },
        ]}
        action={canCreatePurchase ? <PrimaryButton href={`/purchases/new${moduleQuery}`}>New purchase</PrimaryButton> : null}
      />
      {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {!purchases?.length ? (
        <EmptyState title="No purchases yet" body="Create a purchase when stock arrives from a supplier." />
      ) : (
        <>
          <MobileCardList>
            {purchases.map((purchase: any) => {
              const calculatedTotal = Number(purchase.calculated_total_lyd ?? purchase.total_amount ?? 0);
              const receiptTotal = purchase.manual_total_lyd === null || purchase.manual_total_lyd === undefined ? null : Number(purchase.manual_total_lyd);
              const displayTotal = receiptTotal ?? Number(purchase.total_amount ?? calculatedTotal);
              const difference = receiptTotal === null ? null : receiptTotal - calculatedTotal;
              return (
                <MobileRecordCard key={purchase.id}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="break-words text-base font-semibold text-slate-900">{purchase.supplier?.name ?? "Unknown supplier"}</h2>
                      <p className="mt-1 text-xs text-slate-500">{purchase.order_date} - Receipt {purchase.receipt_number ?? "-"}</p>
                    </div>
                    <StatusBadge status={purchase.status} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label="Receipt total">{lyd(displayTotal)}</MobileField>
                    <MobileField label="Calculated">{lyd(calculatedTotal)}</MobileField>
                    <MobileField label="Difference">{difference === null ? "-" : lyd(difference)}</MobileField>
                    <MobileField label="Payment"><StatusBadge status={purchase.payment_status ?? "paid"} /></MobileField>
                    <MobileField label="Method">{String(purchase.payment_method ?? "-").replaceAll("_", " ")}</MobileField>
                    <MobileField label="Created by">{purchase.created_by_member?.full_name ?? "-"}</MobileField>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <Link href={`/purchases/${purchase.id}${moduleQuery}`} className="btn-secondary w-full">View</Link>
                    {canCreatePurchase && purchase.status === "draft" ? <Link href={`/purchases/${purchase.id}/edit${moduleQuery}`} className="btn-secondary w-full">Edit</Link> : null}
                  </div>
                </MobileRecordCard>
              );
            })}
          </MobileCardList>
          <DataTable className="hidden md:block" headers={["Date", "Supplier", "Receipt", "Calculated", "Receipt total", "Difference", "Payment", "Payment status", "Status", "Created by", "Actions"]}>
            {purchases.map((purchase: any) => {
              const calculatedTotal = Number(purchase.calculated_total_lyd ?? purchase.total_amount ?? 0);
              const receiptTotal = purchase.manual_total_lyd === null || purchase.manual_total_lyd === undefined ? null : Number(purchase.manual_total_lyd);
              const displayTotal = receiptTotal ?? Number(purchase.total_amount ?? calculatedTotal);
              const difference = receiptTotal === null ? null : receiptTotal - calculatedTotal;
              return (
                <tr key={purchase.id}>
                  <td>{purchase.order_date}</td>
                  <td>{purchase.supplier?.name ?? "-"}</td>
                  <td>{purchase.receipt_number ?? "-"}</td>
                  <td>{lyd(calculatedTotal)}</td>
                  <td>{lyd(displayTotal)}</td>
                  <td>{difference === null ? "-" : lyd(difference)}</td>
                  <td>{String(purchase.payment_method ?? "-").replaceAll("_", " ")}</td>
                  <td><StatusBadge status={purchase.payment_status ?? "paid"} /></td>
                  <td><StatusBadge status={purchase.status} /></td>
                  <td>{purchase.created_by_member?.full_name ?? "-"}</td>
                  <td><div className="flex flex-wrap gap-2"><Link href={`/purchases/${purchase.id}${moduleQuery}`} className="btn-secondary">View</Link>{canCreatePurchase && purchase.status === "draft" ? <Link href={`/purchases/${purchase.id}/edit${moduleQuery}`} className="btn-secondary">Edit</Link> : null}</div></td>
                </tr>
              );
            })}
          </DataTable>
        </>
      )}
    </>
  );
}
