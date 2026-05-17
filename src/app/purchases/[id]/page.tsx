import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { cancelPurchase, receivePurchase } from "@/lib/purchase-actions";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function PurchaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; receiptUpload?: string }> }) {
  const { id } = await params;
  const { error = "", receiptUpload = "" } = await searchParams;
  const profile = await getCurrentProfile();
  const canManagePurchase = isOwnerAdminRole(profile?.role) || isSupervisorRole(profile?.role) || profile?.role === "warehouse";
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: purchase }, { data: lines }, { data: movements, count: movementCount }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, supplier_id, status, order_date, receipt_number, payment_method, receipt_url, total_amount, manual_total_lyd, calculated_total_lyd, total_adjustment_lyd, total_source, notes, received_at, supplier:suppliers(name), created_by_member:team_members!purchase_orders_created_by_fkey(full_name), received_by_member:team_members!purchase_orders_received_by_fkey(full_name)")
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
      .eq("reason", "purchase_received")
      .order("created_at", { ascending: false }),
  ]);
  if (!purchase) notFound();

  const purchaseRow = purchase as any;
  const lineRows = (lines ?? []) as any[];
  const movementRows = (movements ?? []) as any[];
  const isDraft = purchaseRow.status === "draft";
  const hasReceiptMovements = Number(movementCount ?? 0) > 0;
  const calculatedTotal = Number(purchaseRow.calculated_total_lyd ?? purchaseRow.total_amount ?? 0);
  const displayTotal = Number(purchaseRow.manual_total_lyd ?? purchaseRow.total_amount ?? calculatedTotal);
  const totalAdjustment = Number(purchaseRow.total_adjustment_lyd ?? displayTotal - calculatedTotal);

  return (
    <AppShell>
      <PageHeader title={`Purchase ${purchaseRow.receipt_number ?? purchaseRow.id.slice(0, 8)}`} subtitle="Supplier receipt, purchased items, and inventory receiving status." action={<SecondaryButton href="/purchases">Back to purchases</SecondaryButton>} />
      {error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {receiptUpload === "storage-unavailable" ? <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Receipt upload is unavailable locally. You can paste a receipt URL instead.</div> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="surface-card">
          <div className="grid gap-4 md:grid-cols-2">
            <div><div className="text-xs font-medium uppercase text-slate-500">Purchase date</div><div className="font-medium">{purchaseRow.order_date}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Supplier</div><div className="font-medium">{purchaseRow.supplier?.name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Payment method</div><div className="font-medium">{String(purchaseRow.payment_method ?? "-").replaceAll("_", " ")}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Status</div><StatusBadge status={purchaseRow.status} /></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Created by</div><div>{purchaseRow.created_by_member?.full_name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Received by</div><div>{purchaseRow.received_by_member?.full_name ?? "-"}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Receipt</div>{purchaseRow.receipt_url ? <a className="link-secondary" href={purchaseRow.receipt_url} target="_blank" rel="noreferrer">Open receipt</a> : <span>-</span>}</div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Inventory movement</div><div>{hasReceiptMovements ? "Created" : "Not created"}</div></div>
          </div>
          {purchaseRow.notes ? <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{purchaseRow.notes}</p> : null}
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
            {canManagePurchase && isDraft ? <Link href={`/purchases/${id}/edit`} className="btn-secondary w-full">Edit purchase</Link> : null}
            {canManagePurchase && isDraft ? (
              <form action={receivePurchase}>
                <input type="hidden" name="id" value={id} />
                <button className="btn-primary w-full">Receive into storage</button>
              </form>
            ) : null}
            {canManagePurchase && isDraft ? (
              <form action={cancelPurchase}>
                <input type="hidden" name="id" value={id} />
                <button className="btn-secondary w-full">Cancel purchase</button>
              </form>
            ) : null}
            {purchaseRow.status === "received" ? <Link href="/inventory" className="btn-secondary w-full">View storage inventory</Link> : null}
          </div>
        </section>
      </div>

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
            <p className="text-sm text-slate-500">Storage increases created when this purchase is received.</p>
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
    </AppShell>
  );
}
