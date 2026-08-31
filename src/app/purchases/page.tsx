import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { canManagePurchases } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { privateStorageObjectUrl, RECEIPT_IMAGE_BUCKET } from "@/lib/storage-buckets";

export const dynamic = "force-dynamic";

type PaymentSummary = {
  purchase_order_id: string;
  total_amount_lyd: number | string;
  paid_amount_lyd: number | string;
  remaining_amount_lyd: number | string;
  payment_status: string;
  last_paid_at: string | null;
  payment_count: number;
};

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { error?: string; module?: string }> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const error = String(params.error ?? "");
  const sourceModule = String(params.module ?? "");
  const moduleQuery = sourceModule === "finance" ? "?module=finance" : "";
  const profile = await requireCurrentProfileForPath("/purchases");
  const canCreatePurchase = canManagePurchases(profile);
  const supabase = await getAuthenticatedSupabaseServerClient();

  if (!supabase) {
    return <ErrorState title="Purchases unavailable" body="Supabase is not configured, so Snacky OS cannot load purchases." />;
  }

  const { data: purchases, count, error: purchasesError } = await supabase
    .from("purchase_orders")
    .select("id, order_date, receipt_number, receipt_url, receipt_storage_path, total_amount, manual_total_lyd, calculated_total_lyd, payment_method, status, created_at, supplier:suppliers(name), created_by_member:team_members!purchase_orders_created_by_fkey(full_name)", { count: "exact" })
    .order("order_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (purchasesError) {
    console.error("[purchases] Failed to load purchases", purchasesError);
    return <ErrorState title="Could not load purchases" body="Snacky OS could not load supplier purchase records from Supabase." action={<SecondaryButton href="/purchases">Retry</SecondaryButton>} />;
  }

  const purchaseIds = (purchases ?? []).map((purchase: any) => String(purchase.id));
  const summaryResult = purchaseIds.length
    ? await supabase
        .from("purchase_payment_summary")
        .select("purchase_order_id, total_amount_lyd, paid_amount_lyd, remaining_amount_lyd, payment_status, last_paid_at, payment_count")
        .in("purchase_order_id", purchaseIds)
    : { data: [] as PaymentSummary[], error: null };

  if (summaryResult.error) {
    console.error("[purchases] Failed to load derived supplier payment totals", summaryResult.error);
  }

  const paymentDataAvailable = !summaryResult.error;
  const paymentByPurchase = new Map<string, PaymentSummary>(
    ((summaryResult.data ?? []) as PaymentSummary[]).map((row) => [String(row.purchase_order_id), row]),
  );

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Receive supplier stock and track every supplier payment separately."
        breadcrumbs={[
          { label: sourceModule === "finance" ? "Finance" : "Inventory", href: sourceModule === "finance" ? "/finance" : "/inventory" },
          { label: "Purchases" },
        ]}
        action={canCreatePurchase ? <PrimaryButton href={`/purchases/new${moduleQuery}`}>New purchase</PrimaryButton> : null}
      />
      {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {!paymentDataAvailable ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          Supplier payment totals are temporarily unavailable. Snacky OS will not guess from the old status label; open a purchase after the payment ledger is restored.
        </div>
      ) : null}
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
              const receiptUrl = String(purchase.receipt_url ?? "").trim() || privateStorageObjectUrl(RECEIPT_IMAGE_BUCKET, purchase.receipt_storage_path);
              const payment = paymentByPurchase.get(String(purchase.id));
              const paymentStatus = paymentDataAvailable && payment ? payment.payment_status : "unknown";

              return (
                <MobileRecordCard key={purchase.id}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="flex flex-wrap items-center gap-2 break-words text-base font-semibold text-slate-900">
                        <span>{purchase.supplier?.name ?? "Unknown supplier"}</span>
                        {receiptUrl ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Receipt</span> : null}
                      </h2>
                      <p className="mt-1 text-xs text-slate-500">{purchase.order_date} - Receipt {purchase.receipt_number ?? "-"}</p>
                    </div>
                    <StatusBadge status={purchase.status} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label="Receipt total">{lyd(displayTotal)}</MobileField>
                    <MobileField label="Calculated">{lyd(calculatedTotal)}</MobileField>
                    <MobileField label="Difference">{difference === null ? "-" : lyd(difference)}</MobileField>
                    <MobileField label="Paid">{paymentDataAvailable && payment ? lyd(Number(payment.paid_amount_lyd)) : "-"}</MobileField>
                    <MobileField label="Remaining">{paymentDataAvailable && payment ? lyd(Number(payment.remaining_amount_lyd)) : "-"}</MobileField>
                    <MobileField label="Payment"><StatusBadge status={paymentStatus} /></MobileField>
                    <MobileField label="Method">{String(purchase.payment_method ?? "-").replaceAll("_", " ")}</MobileField>
                    <MobileField label="Created by">{purchase.created_by_member?.full_name ?? "-"}</MobileField>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <Link href={`/purchases/${purchase.id}${moduleQuery}`} className="btn-secondary w-full">View</Link>
                    {receiptUrl ? <a href={receiptUrl} target="_blank" rel="noreferrer" className="btn-secondary w-full">View Receipt</a> : null}
                    {canCreatePurchase && purchase.status === "draft" ? <Link href={`/purchases/${purchase.id}/edit${moduleQuery}`} className="btn-secondary w-full">Edit</Link> : null}
                  </div>
                </MobileRecordCard>
              );
            })}
          </MobileCardList>

          <DataTable className="hidden md:block" headers={["Date", "Supplier", "Receipt", "Calculated", "Receipt total", "Difference", "Paid", "Remaining", "Payment status", "Status", "Created by", "Actions"]}>
            {purchases.map((purchase: any) => {
              const calculatedTotal = Number(purchase.calculated_total_lyd ?? purchase.total_amount ?? 0);
              const receiptTotal = purchase.manual_total_lyd === null || purchase.manual_total_lyd === undefined ? null : Number(purchase.manual_total_lyd);
              const displayTotal = receiptTotal ?? Number(purchase.total_amount ?? calculatedTotal);
              const difference = receiptTotal === null ? null : receiptTotal - calculatedTotal;
              const payment = paymentByPurchase.get(String(purchase.id));
              const paymentStatus = paymentDataAvailable && payment ? payment.payment_status : "unknown";

              return (
                <tr key={purchase.id}>
                  <td>{purchase.order_date}</td>
                  <td>{purchase.supplier?.name ?? "-"}</td>
                  <td>{purchase.receipt_number ?? "-"}</td>
                  <td>{lyd(calculatedTotal)}</td>
                  <td>{lyd(displayTotal)}</td>
                  <td>{difference === null ? "-" : lyd(difference)}</td>
                  <td>{paymentDataAvailable && payment ? lyd(Number(payment.paid_amount_lyd)) : "-"}</td>
                  <td>{paymentDataAvailable && payment ? lyd(Number(payment.remaining_amount_lyd)) : "-"}</td>
                  <td><StatusBadge status={paymentStatus} /></td>
                  <td><StatusBadge status={purchase.status} /></td>
                  <td>{purchase.created_by_member?.full_name ?? "-"}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/purchases/${purchase.id}${moduleQuery}`} className="btn-secondary">View</Link>
                      {canCreatePurchase && purchase.status === "draft" ? <Link href={`/purchases/${purchase.id}/edit${moduleQuery}`} className="btn-secondary">Edit</Link> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/purchases" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="purchases" />
        </>
      )}
    </>
  );
}
