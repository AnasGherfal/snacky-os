import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { cancelPurchase, deleteDraftPurchase, markPurchasePaid, receivePurchase, voidReceivedPurchase } from "@/lib/purchase-actions";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { canManagePurchases } from "@/lib/authz";
import { accountLabel } from "@/lib/finance-balance";
import { lyd } from "@/lib/format";
import { dateOnly } from "@/lib/purchase-finance-date";
import { privateStorageObjectUrl, RECEIPT_IMAGE_BUCKET } from "@/lib/storage-buckets";

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

export default async function PurchaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; receiptUpload?: string; module?: string; purchaseSaved?: string; financeSync?: string }> }) {
  const { id } = await params;
  const { error = "", receiptUpload = "", module = "", purchaseSaved = "", financeSync = "" } = await searchParams;
  const moduleQuery = module === "finance" ? "?module=finance" : "";
  const profile = await requireCurrentProfileForPath(`/purchases/${id}`);
  const canManagePurchase = canManagePurchases(profile);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: purchase }, { data: lines }, { data: movements, count: movementCount }, { data: financeRows }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("*, supplier:suppliers(name), created_by_member:team_members!purchase_orders_created_by_fkey(full_name), received_by_member:team_members!purchase_orders_received_by_fkey(full_name)")
      .eq("id", id)
      .single(),
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
  ]);
  if (!purchase) notFound();

  const purchaseRow = purchase as any;
  const lineRows = (lines ?? []) as any[];
  const movementRows = (movements ?? []) as any[];
  const isDraft = purchaseRow.status === "draft";
  const hasReceiptMovements = movementRows.some((movement: any) => movement.reason === "purchase_received") || Number(movementCount ?? 0) > 0;
  const activeFinanceRows = (financeRows ?? []).filter((row: any) => row.transaction_status === "active");
  const hasActiveFinance = activeFinanceRows.length > 0;
  const activeFinanceTransaction = activeFinanceRows[0] ?? null;
  const linkedFinanceTransaction = activeFinanceTransaction ?? financeRows?.[0] ?? null;
  const paymentDate = dateOnly(purchaseRow.payment_date) ?? dateOnly(purchaseRow.paid_at);
  const linkedFinanceTransactionDate = dateOnly(linkedFinanceTransaction?.transaction_date);
  const calculatedTotal = Number(purchaseRow.calculated_total_lyd ?? purchaseRow.total_amount ?? 0);
  const displayTotal = Number(purchaseRow.manual_total_lyd ?? purchaseRow.total_amount ?? calculatedTotal);
  const totalAdjustment = Number(purchaseRow.total_adjustment_lyd ?? displayTotal - calculatedTotal);
  const receiptUploadMessage =
    receiptUpload === "storage-unavailable"
      ? "Storage is not configured in this environment. Use receipt URL for now."
      : receiptUpload === "invalid-file"
        ? "Receipt upload must be a PNG, JPG, WEBP, or PDF file that is 5MB or smaller. Use receipt URL for now."
        : "";
  const receiptUrl = String(purchaseRow.receipt_url ?? "").trim() || privateStorageObjectUrl(RECEIPT_IMAGE_BUCKET, purchaseRow.receipt_storage_path) || "";

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
            <div><div className="text-xs font-medium uppercase text-slate-500">Payment status</div><StatusBadge status={purchaseRow.payment_status ?? "paid"} /></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Payment date</div><div className="font-medium">{paymentDate ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Linked finance transaction date</div><div className="font-medium">{linkedFinanceTransactionDate ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Status</div><StatusBadge status={purchaseRow.status} /></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Created by</div><div>{purchaseRow.created_by_member?.full_name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Received by</div><div>{purchaseRow.received_by_member?.full_name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Voided at</div><div>{purchaseRow.voided_at ? new Date(purchaseRow.voided_at).toLocaleString("en-US") : "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Receipt</div>{receiptUrl ? <a className="link-secondary" href={receiptUrl} target="_blank" rel="noreferrer">Open receipt</a> : <span>-</span>}</div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Inventory movement</div><div>{hasReceiptMovements ? "Created" : "Not created"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Finance transaction status</div><div>{hasActiveFinance ? <Link href={`/finance/transactions/${activeFinanceTransaction.id}`} className="link-secondary">View finance transaction</Link> : "Not posted yet"}</div></div>
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
            {canManagePurchase && isDraft ? (
              <form action={receivePurchase}>
                <input type="hidden" name="id" value={id} />
                <button className="btn-primary w-full">Receive into storage</button>
              </form>
            ) : null}
            {canManagePurchase && purchaseRow.status === "received" && purchaseRow.payment_status !== "paid" && purchaseRow.payment_status !== "voided" ? (
              <ConfirmDialog
                action={markPurchasePaid}
                triggerLabel="Mark paid"
                title="Mark purchase paid?"
                description="Snacky OS will mark the purchase paid and create the linked money-out financial transaction if it does not already exist."
                confirmLabel="Mark paid"
                buttonClassName="btn-primary w-full"
                confirmButtonClassName="btn-primary"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
            {canManagePurchase && purchaseRow.status === "received" && purchaseRow.payment_status === "paid" && !hasActiveFinance ? (
              <ConfirmDialog
                action={markPurchasePaid}
                triggerLabel="Create payment transaction"
                title="Create missing payment transaction?"
                description="The purchase is marked paid but has no active product-purchase finance transaction. Snacky OS will create one without duplicating existing active records."
                confirmLabel="Create transaction"
                buttonClassName="btn-secondary w-full"
                confirmButtonClassName="btn-primary"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
            {canManagePurchase && isDraft ? (
              <ConfirmDialog
                action={cancelPurchase}
                triggerLabel="Cancel purchase"
                title="Cancel draft purchase?"
                description="The purchase will stay in history as cancelled. No inventory or finance movement will be created."
                confirmLabel="Cancel purchase"
                buttonClassName="btn-secondary w-full"
                confirmButtonClassName="btn-primary"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
            {canManagePurchase && isDraft ? (
              <ConfirmDialog
                action={deleteDraftPurchase}
                triggerLabel="Delete draft"
                title="Delete draft purchase permanently?"
                description="Draft purchases can be hard-deleted only before they create inventory or finance history."
                confirmLabel="Delete draft"
                buttonClassName="btn-danger w-full"
                confirmButtonClassName="btn-danger"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
            {canManagePurchase && purchaseRow.status === "received" ? (
              <ConfirmDialog
                action={voidReceivedPurchase}
                triggerLabel="Void received purchase"
                title="Void received purchase?"
                description="Snacky OS will create reversal inventory movements and void the linked finance transaction. The original purchase and movements stay in history."
                confirmLabel="Void purchase"
                buttonClassName="btn-danger w-full"
                confirmButtonClassName="btn-danger"
                hiddenFields={[{ name: "id", value: id }]}
              />
            ) : null}
            {purchaseRow.status === "received" ? <Link href="/inventory" className="btn-secondary w-full">View storage inventory</Link> : null}
          </div>
        </section>
      </div>

      <ReceiptPreviewSection purchase={purchaseRow} />

      <section className="surface-card mt-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Line items</h2>
        {!lineRows.length ? (
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
        {!movementRows.length ? (
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
