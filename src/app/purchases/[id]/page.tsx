import Link from "next/link";
import { notFound } from "next/navigation";
import { PersistentPurchaseConfirmDialog, PurchaseOperationForm } from "@/components/PurchaseOperationForm";
import { cancelPurchase, receivePurchase, recordPurchasePayment, voidPurchasePayment, voidReceivedPurchase } from "@/lib/purchase-actions";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { canManagePurchases, canRecordPurchasePayments, isAdminRole } from "@/lib/authz";
import { accountLabel } from "@/lib/finance-balance";
import { lyd } from "@/lib/format";
import { dateOnly } from "@/lib/purchase-finance-date";
import { privateStorageObjectUrl, RECEIPT_IMAGE_BUCKET } from "@/lib/storage-buckets";

function tripoliDateInputValue(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatReceiptType(url: string | null | undefined, contentType?: string | null) {
  const explicit = String(contentType ?? "").trim();
  if (explicit) return explicit;
  const lower = String(url ?? "").toLowerCase().split("?")[0];
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "file";
}

function ReceiptPreviewSection({ purchase }: { purchase: any }) {
  const receiptUrl = String(purchase.receipt_url ?? "").trim() || privateStorageObjectUrl(RECEIPT_IMAGE_BUCKET, purchase.receipt_storage_path) || "";
  const contentType = formatReceiptType(receiptUrl, purchase.receipt_content_type);
  const isImage = contentType.startsWith("image/");
  const receiptLabel = purchase.receipt_file_name ?? purchase.receipt_number ?? "Receipt";

  return (
    <section className="surface-card mt-6">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Receipt preview</h2>
          <p className="text-sm text-slate-500">{receiptUrl ? "Supplier receipt attachment saved with this purchase." : "No supplier receipt attachment is saved yet."}</p>
        </div>
        {receiptUrl ? <a href={receiptUrl} target="_blank" rel="noreferrer" className="btn-secondary">View Receipt</a> : null}
      </div>
      {!receiptUrl ? (
        <EmptyState title="No receipt attached" body="Upload a receipt while creating or editing the draft purchase." />
      ) : isImage ? (
        <a href={receiptUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-slate-200 bg-white">
          <img src={receiptUrl} alt={receiptLabel} className="max-h-[34rem] w-full object-contain" />
        </a>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-slate-200 bg-slate-50 p-6 text-center">
          <div className="text-sm font-medium text-slate-900">{receiptLabel}</div>
          <div className="mt-1 text-xs text-slate-500">{contentType === "application/pdf" ? "PDF receipt" : "Receipt file"}</div>
          <a href={receiptUrl} target="_blank" rel="noreferrer" className="btn-primary mt-4">View Receipt</a>
        </div>
      )}
    </section>
  );
}

export const dynamic = "force-dynamic";

export default async function PurchaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; financeWarning?: string; receiptUpload?: string; module?: string; purchaseSaved?: string; financeSync?: string; paymentRecorded?: string; paymentVoided?: string; purchaseReceived?: string; purchaseCancelled?: string; purchaseVoided?: string }> }) {
  const { id } = await params;
  const {
    error = "",
    financeWarning = "",
    receiptUpload = "",
    module = "",
    purchaseSaved = "",
    financeSync = "",
    paymentRecorded = "",
    paymentVoided = "",
    purchaseReceived = "",
    purchaseCancelled = "",
    purchaseVoided = "",
  } = await searchParams;
  const moduleQuery = module === "finance" ? "?module=finance" : "";
  const profile = await requireCurrentProfileForPath(`/purchases/${id}`);
  const canManagePurchase = canManagePurchases(profile);
  const canRecordPayment = canRecordPurchasePayments(profile);
  const canAdministerPurchaseInventory = isAdminRole(profile);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return <ErrorState title="Purchase unavailable" body="Snacky OS could not connect to the purchase database. No missing purchase or empty history is being inferred." action={<SecondaryButton href={`/purchases${moduleQuery}`}>Back to purchases</SecondaryButton>} />;
  }

  const [
    { data: purchase, error: purchaseError },
    { data: lines, error: linesError },
    { data: movements, count: movementCount, error: movementsError },
    { data: legacyFinanceRows, error: legacyFinanceRowsError },
    { data: paymentSummary, error: paymentSummaryError },
    { data: payments, error: paymentsError },
    { data: receivingStorageLocations, error: receivingStorageLocationsError },
  ] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("*, supplier:suppliers(name), created_by_member:team_members!purchase_orders_created_by_fkey(full_name), received_by_member:team_members!purchase_orders_received_by_fkey(full_name)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("purchase_order_lines")
      .select("id, line_position, boxes_qty, units_per_box, loose_units_qty, total_units, ordered_qty, received_qty, unit_cost, line_total, unit_cost_lyd, line_total_lyd, product:products(id, sku, name)")
      .eq("purchase_order_id", id)
      .order("line_position")
      .order("created_at"),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, to_entity_type, reason, related_purchase_line_id, unit_cost_lyd, line_total_lyd, notes, created_at, product:products(name, sku), created_by_member:team_members(full_name)", { count: "exact" })
      .eq("related_purchase_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("financial_transactions")
      .select("id, amount, signed_amount, transaction_date, transaction_status, review_status, related_purchase_id, linked_purchase_id, source_type, source_id")
      .or(`related_purchase_id.eq.${id},linked_purchase_id.eq.${id},and(source_type.eq.purchase,source_id.eq.${id})`)
      .order("transaction_date", { ascending: false }),
    supabase
      .from("purchase_payment_summary")
      .select("purchase_order_id, total_amount_lyd, paid_amount_lyd, remaining_amount_lyd, payment_status, last_paid_at, payment_count")
      .eq("purchase_order_id", id)
      .maybeSingle(),
    supabase
      .from("purchase_payments")
      .select("id, amount_lyd, paid_at, payment_method, account_id, reference, note, finance_transaction_id, created_at, voided_at, void_reason, recorded_by_member:team_members!purchase_payments_recorded_by_fkey(full_name)")
      .eq("purchase_order_id", id)
      .order("paid_at", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("storage_locations")
      .select("id, name, location_type")
      .eq("active", true)
      .in("location_type", ["main_storage", "vehicle", "temporary", "other"])
      .order("name"),
  ]);
  if (purchaseError) {
    console.error("[purchases:detail] Failed to load purchase", { purchase_id: id, supabase_error: purchaseError });
    return <ErrorState title="Could not load purchase" body="Snacky OS could not verify this purchase record. Retry; no missing purchase, empty items, or missing inventory history is being inferred." action={<SecondaryButton href={`/purchases/${id}${moduleQuery}`}>Retry</SecondaryButton>} />;
  }
  if (!purchase) notFound();
  if (linesError) console.error("[purchases:detail] Failed to load purchase lines", { purchase_id: id, supabase_error: linesError });
  if (movementsError) console.error("[purchases:detail] Failed to load inventory movements", { purchase_id: id, supabase_error: movementsError });

  const paymentFinanceIds = (payments ?? [])
    .map((payment: any) => String(payment.finance_transaction_id ?? ""))
    .filter(Boolean);
  const paymentFinanceResult = paymentFinanceIds.length
    ? await supabase
        .from("financial_transactions")
        .select("id, amount, signed_amount, transaction_date, transaction_status, review_status, related_purchase_id, linked_purchase_id, source_type, source_id")
        .in("id", paymentFinanceIds)
    : { data: [], error: null };
  const financeRows = Array.from(
    new Map(
      [...(legacyFinanceRows ?? []), ...(paymentFinanceResult.data ?? [])]
        .map((row: any) => [String(row.id), row]),
    ).values(),
  );
  const financeRowsAvailable = !legacyFinanceRowsError && !paymentFinanceResult.error;
  if (!financeRowsAvailable) {
    console.error("[purchases:detail] Could not load every linked supplier-payment finance row", {
      purchase_id: id,
      legacy_finance_error: legacyFinanceRowsError,
      payment_finance_error: paymentFinanceResult.error,
    });
  }

  const purchaseRow = purchase as any;
  const lineRows = (lines ?? []) as any[];
  const movementRows = (movements ?? []) as any[];
  const lineItemsAvailable = !linesError;
  const movementHistoryAvailable = !movementsError;
  const isDraft = purchaseRow.status === "draft";
  const hasReceiptMovements = movementHistoryAvailable && (movementRows.some((movement: any) => movement.reason === "purchase_received") || Number(movementCount ?? 0) > 0);
  const activeFinanceRows = financeRows.filter((row: any) => row.transaction_status === "active");
  const hasActiveFinance = activeFinanceRows.length > 0;
  const activeFinanceTransaction = activeFinanceRows[0] ?? null;
  const linkedFinanceTransaction = activeFinanceTransaction ?? financeRows[0] ?? null;
  const paymentDate = dateOnly(purchaseRow.payment_date) ?? dateOnly(purchaseRow.paid_at);
  const linkedFinanceTransactionDate = dateOnly(linkedFinanceTransaction?.transaction_date);
  const calculatedTotal = Number(purchaseRow.calculated_total_lyd ?? purchaseRow.total_amount ?? 0);
  const displayTotal = Number(purchaseRow.manual_total_lyd ?? purchaseRow.total_amount ?? calculatedTotal);
  const totalAdjustment = Number(purchaseRow.total_adjustment_lyd ?? displayTotal - calculatedTotal);
  const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const accountingLineTotal = roundMoney(lineRows.reduce((sum, line) => sum + Number(line.line_total_lyd ?? line.line_total ?? 0), 0));
  const linesReconcile = lineItemsAvailable && lineRows.length > 0 && lineRows.every((line) => {
    const units = Number(line.total_units ?? 0);
    const unitCost = Number(line.unit_cost_lyd ?? line.unit_cost);
    const lineTotal = Number(line.line_total_lyd ?? line.line_total);
    return Number.isFinite(units) && units > 0
      && Number.isFinite(unitCost) && unitCost >= 0
      && Number.isFinite(lineTotal) && lineTotal >= 0
      && roundMoney(lineTotal) === roundMoney(unitCost * units);
  });
  const manualTotal = purchaseRow.manual_total_lyd === null ? null : Number(purchaseRow.manual_total_lyd);
  const recordedCalculatedTotal = Number(purchaseRow.calculated_total_lyd);
  const recordedTotal = Number(purchaseRow.total_amount);
  const selectedAccountingTotal = roundMoney(manualTotal ?? recordedCalculatedTotal);
  const expectedAdjustment = manualTotal === null ? null : roundMoney(selectedAccountingTotal - accountingLineTotal);
  const accountingHeaderReconciles = Number.isFinite(recordedCalculatedTotal)
    && recordedCalculatedTotal >= 0
    && roundMoney(recordedCalculatedTotal) === accountingLineTotal
    && Number.isFinite(recordedTotal)
    && recordedTotal >= 0
    && selectedAccountingTotal > 0
    && roundMoney(recordedTotal) === selectedAccountingTotal
    && (manualTotal === null
      ? purchaseRow.total_source === "calculated" && (purchaseRow.total_adjustment_lyd === null || roundMoney(Number(purchaseRow.total_adjustment_lyd)) === 0)
      : Number.isFinite(manualTotal) && manualTotal >= 0 && purchaseRow.total_source === "manual" && purchaseRow.total_adjustment_lyd !== null && roundMoney(Number(purchaseRow.total_adjustment_lyd)) === expectedAdjustment);
  const purchaseAccountingReady = linesReconcile && accountingHeaderReconciles;
  const paymentSummaryAvailable = !paymentSummaryError && Boolean(paymentSummary);
  const paymentHistoryAvailable = !paymentsError;
  const paymentSummaryRow = paymentSummary as any;
  const paymentRows = (payments ?? []) as any[];
  const receivingStorageRows = (receivingStorageLocations ?? []) as Array<{ id: string; name: string; location_type: string }>;
  const storedReceivingStorageLocationId = String(purchaseRow.receiving_storage_location_id ?? "");
  const defaultReceivingStorageLocationId = receivingStorageRows.some((location) => location.id === storedReceivingStorageLocationId)
    ? storedReceivingStorageLocationId
    : receivingStorageRows.length === 1
      ? String(receivingStorageRows[0].id)
      : "";
  const paidAmount = paymentSummaryAvailable ? Number(paymentSummaryRow.paid_amount_lyd ?? 0) : null;
  const remainingAmount = paymentSummaryAvailable ? Number(paymentSummaryRow.remaining_amount_lyd ?? 0) : null;
  const derivedPaymentStatus = paymentSummaryAvailable ? String(paymentSummaryRow.payment_status ?? "unknown") : "unknown";
  const canVoidPurchase =
    canAdministerPurchaseInventory &&
    purchaseRow.status === "received" &&
    purchaseAccountingReady &&
    movementHistoryAvailable &&
    paymentSummaryAvailable &&
    derivedPaymentStatus === "unpaid";
  const canAddPayment =
    canRecordPayment &&
    purchaseAccountingReady &&
    paymentSummaryAvailable &&
    purchaseRow.status === "received" &&
    derivedPaymentStatus !== "voided" &&
    Number(remainingAmount ?? 0) > 0;
  const existingPaymentAccount = String(purchaseRow.payment_account_id ?? "");
  const paymentAccountDefault = ["snacky_lyd", "owner_lyd"].includes(existingPaymentAccount)
    ? existingPaymentAccount
    : "snacky_lyd";

  const receiptUploadMessage =
    receiptUpload === "storage-unavailable"
      ? "Storage is not configured in this environment. Use receipt URL for now."
      : receiptUpload === "invalid-file"
        ? "Receipt upload must be a PNG, JPG, WEBP, or PDF file that is 5MB or smaller. Use receipt URL for now."
        : "";
  const receiptUrl = String(purchaseRow.receipt_url ?? "").trim() || privateStorageObjectUrl(RECEIPT_IMAGE_BUCKET, purchaseRow.receipt_storage_path) || "";

  if (receivingStorageLocationsError) {
    console.error("[purchases:detail] Failed to load receiving storage locations", {
      table_or_view: "storage_locations",
      purchase_id: id,
      current_user_id: profile.id,
      user_roles: profile.roles,
      supabase_error: receivingStorageLocationsError,
    });
  }

  return (
    <>
      <PageHeader
        title={`Purchase ${purchaseRow.receipt_number ?? purchaseRow.id.slice(0, 8)}`}
        subtitle="Supplier receipt, purchased items, and inventory receiving status."
        breadcrumbs={[
          { label: module === "finance" ? "Finance" : "Inventory", href: module === "finance" ? "/finance" : "/inventory" },
          { label: "Purchases", href: `/purchases${moduleQuery}` },
          { label: purchaseRow.receipt_number ?? purchaseRow.id.slice(0, 8) },
        ]}
        action={<SecondaryButton href={`/purchases${moduleQuery}`}>Back to purchases</SecondaryButton>}
      />
      {purchaseSaved === "draft" ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Purchase saved as draft.</div> : null}
      {purchaseSaved === "received" ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Purchase received and inventory updated.</div> : null}
      {paymentRecorded ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Supplier payment recorded. Paid and remaining balances were recalculated.</div> : null}
      {paymentVoided ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Supplier payment voided. The finance entry and remaining balance were updated together.</div> : null}
      {purchaseReceived ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Purchase received and inventory updated.</div> : null}
      {purchaseCancelled ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Draft purchase cancelled.</div> : null}
      {purchaseVoided ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">Unpaid purchase voided and inventory reversed.</div> : null}
      {!paymentSummaryAvailable ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          Payment totals are unavailable. Recording is disabled so Snacky OS cannot accidentally overpay this purchase.
        </div>
      ) : null}
      {lineItemsAvailable && !purchaseAccountingReady && purchaseRow.status !== "cancelled" && purchaseRow.status !== "voided" ? (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-900">
          Purchase accounting needs review: line quantities/costs and the recorded total do not reconcile to one positive payable amount. Receiving, supplier payment, and purchase void actions are locked; no automatic legacy repair was made.
        </div>
      ) : null}
      {financeWarning === "manual-review" ? <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Finance transaction was not created automatically. Review finance manually.</div> : null}
      {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {financeSync === "needs-repair" ? <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">Purchase saved, finance sync needs repair. Use the finance repair action on this purchase when the finance schema is fixed.</div> : null}
      {receiptUploadMessage ? <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{receiptUploadMessage}</div> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="surface-card">
          <div className="grid gap-4 md:grid-cols-2">
            <div><div className="text-xs font-medium uppercase text-slate-500">Purchase date</div><div className="font-medium">{purchaseRow.order_date}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Supplier</div><div className="font-medium">{purchaseRow.supplier?.name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Payment method</div><div className="font-medium">{String(purchaseRow.payment_method ?? "-").replaceAll("_", " ")}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Paying account</div><div className="font-medium">{accountLabel(purchaseRow.payment_account_id ?? "snacky_lyd")}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Payment status</div><StatusBadge status={derivedPaymentStatus} /></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Paid</div><div className="font-medium">{paidAmount === null ? "-" : lyd(paidAmount)}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Remaining</div><div className="font-medium">{remainingAmount === null ? "-" : lyd(remainingAmount)}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Last paid</div><div className="font-medium">{paymentSummaryAvailable && paymentSummaryRow.last_paid_at ? new Date(paymentSummaryRow.last_paid_at).toLocaleString("en-US") : paymentDate ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Linked finance transaction date</div><div className="font-medium">{linkedFinanceTransactionDate ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Status</div><StatusBadge status={purchaseRow.status} /></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Created by</div><div>{purchaseRow.created_by_member?.full_name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Received by</div><div>{purchaseRow.received_by_member?.full_name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Voided at</div><div>{purchaseRow.voided_at ? new Date(purchaseRow.voided_at).toLocaleString("en-US") : "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Receipt</div>{receiptUrl ? <a className="link-secondary" href={receiptUrl} target="_blank" rel="noreferrer">Open receipt</a> : <span>-</span>}</div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Inventory movement</div><div>{!movementHistoryAvailable ? "Unavailable — history could not be verified" : hasReceiptMovements ? "Created" : "Not created"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Finance transaction status</div><div>{!financeRowsAvailable ? "Unavailable — reload before making a correction" : hasActiveFinance ? <Link href={`/finance/transactions/${activeFinanceTransaction.id}`} className="link-secondary">View finance transaction</Link> : "Not posted yet"}</div></div>
          </div>
          {purchaseRow.notes ? <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{purchaseRow.notes}</p> : null}
          {purchaseRow.void_reason ? <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">Void reason: {purchaseRow.void_reason}</p> : null}
        </section>

        <section className="surface-card">
          <div className="text-xs font-medium uppercase text-slate-500">Purchase total</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{lyd(displayTotal)}</div>
          <div className="mt-3 space-y-1 text-sm text-slate-600">
            <div className="flex justify-between gap-3"><span>Calculated line total</span><span className="font-medium">{lyd(calculatedTotal)}</span></div>
            <div className="flex justify-between gap-3"><span>Receipt total</span><span className="font-medium">{purchaseRow.manual_total_lyd === null ? "-" : lyd(Number(purchaseRow.manual_total_lyd))}</span></div>
            {purchaseRow.manual_total_lyd !== null && Math.abs(totalAdjustment) >= 0.01 ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 font-medium text-amber-900">
                Receipt total differs from line items by {totalAdjustment.toFixed(2)} LYD.
              </div>
            ) : null}
          </div>
          <div className="mt-4 space-y-2">
            {canManagePurchase && isDraft ? <Link href={`/purchases/${id}/edit${moduleQuery}`} className="btn-secondary w-full">Edit purchase</Link> : null}
            <PurchaseOperationForm
              action={receivePurchase}
              purchaseId={id}
              operation="receive"
              initialSubmissionId={crypto.randomUUID()}
              confirmedSubmissionId={purchaseReceived}
              visible={canManagePurchase && isDraft}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
                <input type="hidden" name="id" value={id} />
                <label className="block text-xs font-medium text-slate-700">
                  Receiving storage / مخزن الاستلام
                  <select
                    className="input mt-1 w-full"
                    name="receiving_storage_location_id"
                    defaultValue={defaultReceivingStorageLocationId}
                    required
                    disabled={Boolean(receivingStorageLocationsError) || receivingStorageRows.length === 0 || !lineItemsAvailable || !movementHistoryAvailable || !purchaseAccountingReady}
                  >
                    <option value="">Select receiving storage / اختر مخزن الاستلام</option>
                    {receivingStorageRows.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name} ({String(location.location_type).replaceAll("_", " ")})
                      </option>
                    ))}
                  </select>
                </label>
                {receivingStorageLocationsError || receivingStorageRows.length === 0 || !lineItemsAvailable || !movementHistoryAvailable || !purchaseAccountingReady ? (
                  <p className="mt-2 text-xs font-medium text-amber-800">
                    Receiving is locked until an active physical storage location loads and purchase lines, inventory history, and accounting all verify successfully. / الاستلام متوقف حتى يتم التحقق من المخزن والأصناف والحركات والحسابات.
                  </p>
                ) : null}
                <button className="btn-primary mt-3 w-full" disabled={Boolean(receivingStorageLocationsError) || receivingStorageRows.length === 0 || !lineItemsAvailable || !movementHistoryAvailable || !purchaseAccountingReady}>Receive into storage</button>
            </PurchaseOperationForm>
            <PurchaseOperationForm
              action={recordPurchasePayment}
              purchaseId={id}
              operation="payment"
              initialSubmissionId={crypto.randomUUID()}
              confirmedSubmissionId={paymentRecorded}
              visible={canAddPayment}
              className="rounded-lg border border-slate-200 bg-slate-50 p-4"
            >
                <input type="hidden" name="purchase_order_id" value={id} />
                {module === "finance" ? <input type="hidden" name="module" value="finance" /> : null}
                <div className="mb-3">
                  <div className="text-sm font-semibold text-slate-900">Record supplier payment</div>
                  <div className="mt-1 text-xs text-slate-600">Remaining: {lyd(Number(remainingAmount ?? 0))}</div>
                </div>
                <label className="block text-xs font-medium text-slate-700">
                  Amount (LYD)
                  <input className="input mt-1 w-full" type="number" name="amount" min="0.01" max={Number(remainingAmount ?? 0).toFixed(2)} step="0.01" defaultValue={Number(remainingAmount ?? 0).toFixed(2)} required />
                </label>
                <label className="mt-3 block text-xs font-medium text-slate-700">
                  Payment date
                  <input className="input mt-1 w-full" type="date" name="paid_at" defaultValue={tripoliDateInputValue()} required />
                </label>
                <label className="mt-3 block text-xs font-medium text-slate-700">
                  Method
                  <select className="input mt-1 w-full" name="payment_method" defaultValue={purchaseRow.payment_method ?? "cash"}>
                    <option value="cash">Cash</option>
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="card">Card</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="mt-3 block text-xs font-medium text-slate-700">
                  Paying account
                  <select className="input mt-1 w-full" name="account_id" defaultValue={paymentAccountDefault}>
                    <option value="snacky_lyd">Snacky LYD</option>
                    <option value="owner_lyd">Owner LYD</option>
                  </select>
                </label>
                <label className="mt-3 block text-xs font-medium text-slate-700">
                  Reference
                  <input className="input mt-1 w-full" name="reference" placeholder="Receipt or transfer reference" />
                </label>
                <label className="mt-3 block text-xs font-medium text-slate-700">
                  Note
                  <textarea className="input mt-1 min-h-20 w-full" name="note" placeholder="Optional payment note" />
                </label>
                <button className="btn-primary mt-4 w-full" type="submit">Record payment</button>
            </PurchaseOperationForm>
            <PersistentPurchaseConfirmDialog
                purchaseId={id}
                operation="cancel"
                initialSubmissionId={crypto.randomUUID()}
                confirmedSubmissionId={purchaseCancelled}
                visible={canManagePurchase && isDraft}
                action={cancelPurchase}
                triggerLabel="Cancel purchase"
                title="Cancel draft purchase?"
                description="The purchase will stay in history as cancelled. No inventory or finance movement will be created."
                confirmLabel="Cancel purchase"
                buttonClassName="btn-secondary w-full"
                confirmButtonClassName="btn-primary"
                hiddenFields={[
                  { name: "id", value: id },
                ]}
              />
            <PersistentPurchaseConfirmDialog
                purchaseId={id}
                operation="void"
                initialSubmissionId={crypto.randomUUID()}
                confirmedSubmissionId={purchaseVoided}
                visible={canVoidPurchase}
                action={voidReceivedPurchase}
                triggerLabel="Void received purchase"
                title="Void received purchase?"
                description="Only an unpaid purchase can be voided. Snacky OS first checks storage stock and reservations, then reverses inventory only. If a supplier payment exists, record its refund or correction first; this action never changes finance silently."
                confirmLabel="Void purchase"
                buttonClassName="btn-danger w-full"
                confirmButtonClassName="btn-danger"
                hiddenFields={[
                  { name: "id", value: id },
                ]}
              />
            {canAdministerPurchaseInventory && purchaseRow.status === "received" && !canVoidPurchase ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
                This purchase cannot be voided while payment status is {derivedPaymentStatus.replaceAll("_", " ")}. Record the supplier refund or payment correction first; if payment data is unavailable, reload before trying again.
              </div>
            ) : null}
            {purchaseRow.status === "received" ? <Link href="/inventory" className="btn-secondary w-full">View storage inventory</Link> : null}
          </div>
        </section>
      </div>

      <section className="surface-card mt-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Supplier payment history</h2>
          <p className="text-sm text-slate-500">Each payment is posted separately to Finance. Partial payments remain visible until the balance reaches zero.</p>
        </div>
        {!paymentHistoryAvailable ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            Payment history is unavailable. No payment status is inferred from the old purchase label.
          </div>
        ) : !paymentRows.length ? (
          <EmptyState title="No payments recorded" body="This supplier purchase has not been settled yet." />
        ) : (
          <DataTable headers={["Paid at", "Amount", "Method", "Account", "Reference", "Recorded by", "Finance", "Status", "Note", "Action"]}>
            {paymentRows.map((payment: any) => (
              <tr key={payment.id}>
                <td>{new Date(payment.paid_at).toLocaleString("en-US")}</td>
                <td className="font-semibold">{lyd(Number(payment.amount_lyd ?? 0))}</td>
                <td>{String(payment.payment_method ?? "-").replaceAll("_", " ")}</td>
                <td>{accountLabel(payment.account_id ?? "snacky_lyd")}</td>
                <td>{payment.reference ?? "-"}</td>
                <td>{payment.recorded_by_member?.full_name ?? "-"}</td>
                <td>{payment.finance_transaction_id ? <Link href={`/finance/transactions/${payment.finance_transaction_id}`} className="link-secondary">View</Link> : "-"}</td>
                <td><StatusBadge status={payment.voided_at ? "voided" : "active"} /></td>
                <td>{payment.void_reason ?? payment.note ?? "-"}</td>
                <td>
                  <PersistentPurchaseConfirmDialog
                    purchaseId={id}
                    operation={`payment-void:${payment.id}`}
                    initialSubmissionId={crypto.randomUUID()}
                    confirmedSubmissionId={paymentVoided}
                    visible={canRecordPayment && !payment.voided_at}
                    action={voidPurchasePayment}
                    triggerLabel="Void payment"
                    title="Void supplier payment?"
                    description="This reverses only this supplier payment and its linked finance entry, then recalculates the purchase balance. It does not remove received inventory."
                    confirmLabel="Void payment"
                    buttonClassName="btn-secondary"
                    confirmButtonClassName="btn-danger"
                    hiddenFields={[
                      { name: "purchase_order_id", value: id },
                      { name: "purchase_payment_id", value: payment.id },
                      ...(module === "finance" ? [{ name: "module", value: "finance" }] : []),
                    ]}
                  />
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <ReceiptPreviewSection purchase={purchaseRow} />

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Line items</h2>
        {!lineItemsAvailable ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            Line items are unavailable. Snacky OS is not treating this query failure as an empty purchase; reload before receiving or paying it.
          </div>
        ) : !lineRows.length ? (
          <EmptyState title="No items" body="This purchase has no item lines." />
        ) : (
          <DataTable headers={["Product", "Boxes", "Units / Box", "Loose", "Total Units", "Unit Cost", "Line Total", "Received"]}>
            {lineRows.map((line: any) => (
              <tr key={line.id}>
                <td><div className="font-medium text-slate-900">{line.product?.name ?? "Unknown product"}</div><div className="text-xs text-slate-500">{line.product?.sku ?? "No SKU"}</div></td>
                <td>{line.boxes_qty}</td>
                <td>{line.units_per_box}</td>
                <td>{line.loose_units_qty}</td>
                <td className="font-semibold">{line.total_units || line.ordered_qty}</td>
                <td>{lyd(Number(line.unit_cost_lyd ?? line.unit_cost ?? 0))}</td>
                <td>{lyd(Number(line.line_total_lyd ?? line.line_total ?? 0))}</td>
                <td>{line.received_qty}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mt-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Inventory movements</h2>
            <p className="text-sm text-slate-500">Receipt movements and any reversal corrections linked to this purchase.</p>
          </div>
          <SecondaryButton href={`/inventory/movements?purchase_id=${id}`}>Open full log</SecondaryButton>
        </div>
        {!movementHistoryAvailable ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            Inventory movement history is unavailable. Snacky OS is not reporting that movements were never created; reload before a correction or void.
          </div>
        ) : !movementRows.length ? (
          <EmptyState title="No purchase movements" body="Draft purchases do not affect inventory until they are received." />
        ) : (
          <DataTable headers={["Created", "Product", "Qty", "From", "To", "Reason", "Unit Cost", "Line Total", "User", "Notes"]}>
            {movementRows.map((movement: any) => (
              <tr key={movement.id}>
                <td>{new Date(movement.created_at).toLocaleString("en-US")}</td>
                <td><div className="font-medium text-slate-900">{movement.product?.name ?? "Unknown product"}</div><div className="text-xs text-slate-500">{movement.product?.sku ?? "No SKU"}</div></td>
                <td>{movement.quantity}</td>
                <td><StatusBadge status={movement.from_entity_type} /></td>
                <td><StatusBadge status={movement.to_entity_type} /></td>
                <td><StatusBadge status={movement.reason} /></td>
                <td>{lyd(Number(movement.unit_cost_lyd ?? 0))}</td>
                <td>{lyd(Number(movement.line_total_lyd ?? 0))}</td>
                <td>{movement.created_by_member?.full_name ?? "-"}</td>
                <td>{movement.notes ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
