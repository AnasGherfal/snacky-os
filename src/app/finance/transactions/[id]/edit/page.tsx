import { notFound, redirect } from "next/navigation";
import { FinanceTransactionStatusActions } from "@/components/FinanceTransactionStatusActions";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { LocalDraftForm } from "@/components/LocalDraft";
import { ManualFinanceTransactionFields } from "@/components/ManualFinanceTransactionFields";
import { FormField, FormPageLayout, FormSection, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canEditFinancialTransactions } from "@/lib/authz";
import { DEFAULT_FINANCE_CATEGORIES, type FinanceCategoryOption } from "@/lib/finance-categories";
import { updateFinancialTransaction } from "@/lib/finance-actions";
import { formatFinanceMoney } from "@/lib/finance-balance";
import { resolvePurchaseFinanceTransactionDate } from "@/lib/purchase-finance-date";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function sourceLabel(transaction: any) {
  if (transaction.source_sheet) return `${transaction.source_sheet}:${transaction.source_row}`;
  if (transaction.related_purchase_id) return "Purchase";
  if (transaction.related_cash_collection_id) return "Cash collection";
  return "Manual";
}

function optionLabel(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "-";
}

export default async function EditFinanceTransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canEditFinancialTransactions({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");

  const { id } = await params;
  const { error } = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: transaction }, { data: purchases }, { data: machines }, { data: locations }, { data: routes }, categoriesResult] = await Promise.all([
    supabase.from("financial_transactions").select("*").eq("id", id).maybeSingle(),
    supabase.from("purchase_orders").select("*").order("order_date", { ascending: false }).limit(200),
    supabase.from("machines").select("id, name, machine_code").order("name").limit(200),
    supabase.from("locations").select("id, name").order("name").limit(200),
    supabase.from("routes").select("id, route_date, status").order("route_date", { ascending: false }).limit(200),
    supabase.from("finance_categories").select("id, name, type").eq("is_active", true).order("name"),
  ]);
  if (!transaction) notFound();

  const row = transaction as any;
  const linkedPurchase = row.related_purchase_id ? (purchases ?? []).find((purchase: any) => purchase.id === row.related_purchase_id) : null;
  const linkedSource = row.related_purchase_id ? "purchase" : row.related_cash_collection_id ? "cash collection" : "";
  const transactionDateDefault =
    linkedPurchase && row.transaction_kind === "product_purchase"
      ? resolvePurchaseFinanceTransactionDate(linkedPurchase, row.transaction_date)
      : row.transaction_date;
  const categories = (categoriesResult.error ? DEFAULT_FINANCE_CATEGORIES : (categoriesResult.data ?? DEFAULT_FINANCE_CATEGORIES)) as FinanceCategoryOption[];
  const flowDirection = row.transaction_effect === "transfer" ? "transfer" : row.direction === "money_in" ? "money_in" : "money_out";

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={row.needs_review ? "Review transaction" : "Edit transaction"}
          subtitle="Update the finance ledger safely. Voiding or archiving keeps the audit trail."
          breadcrumbs={[
            { label: "Finance", href: "/finance" },
            { label: "Transactions", href: "/finance/transactions" },
            { label: row.description ? String(row.description).slice(0, 40) : id.slice(0, 8), href: `/finance/transactions/${id}` },
            { label: row.needs_review ? "Review transaction" : "Edit transaction" },
          ]}
          action={<SecondaryButton href={`/finance/transactions/${id}`}>Back to detail</SecondaryButton>}
        />
        {error ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800 shadow-lg">{error}</div> : null}

        <section className="surface-card">
          <div className="grid gap-4 md:grid-cols-4">
            <div><div className="text-xs font-medium uppercase text-slate-500">Source</div><div className="mt-1 font-semibold text-slate-900">{sourceLabel(row)}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Kind</div><div className="mt-1">{optionLabel(row.transaction_kind)}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Current amount</div><div className="mt-1 font-semibold text-slate-900">{formatFinanceMoney(Number(row.signed_amount ?? 0), row.currency ?? "LYD")}</div></div>
            <div><div className="text-xs font-medium uppercase text-slate-500">Status</div><div className="mt-1 flex flex-wrap gap-2"><StatusBadge status={row.transaction_status ?? "active"} /><StatusBadge status={row.needs_review ? "needs_review" : row.review_status} /></div></div>
          </div>
        </section>
        {linkedSource ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            This transaction is linked to a purchase/cash collection. Source: {linkedSource}. Owner/admin/finance users may edit date and amount when a correction is needed.
          </div>
        ) : null}
        {row.transaction_status === "voided" ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-700">
            This transaction is voided and does not affect finance balances.
          </div>
        ) : null}

        <LocalDraftForm action={updateFinancialTransaction} formType="finance-transaction" draftKeyParts={[id]} className="space-y-5">
          <input type="hidden" name="id" value={id} />
          <FormSection title="Transaction details">
            <ManualFinanceTransactionFields
              categories={categories}
              defaults={{
                transactionDate: transactionDateDefault,
                direction: flowDirection,
                accountId: row.account_id ?? "snacky_lyd",
                sourceAccountId: row.source_account_id ?? "owner_lyd",
                destinationAccountId: row.destination_account_id ?? "snacky_lyd",
                category: row.category ?? row.final_bucket ?? row.transaction_type ?? "",
                amount: Number(row.amount ?? 0),
                payerText: row.payer_text ?? null,
                payeeText: row.paid_to_text ?? row.payee_text ?? null,
                counterpartyText: row.counterparty_text ?? null,
              }}
            />
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <FormField label="Payment method">
                <select name="payment_method" defaultValue={row.payment_method ?? ""} className="field-input">
                  <option value="">Not set</option>
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="card">Card</option>
                  <option value="cheque">Cheque</option>
                  <option value="other">Other</option>
                </select>
              </FormField>
              <FormField label="Transaction type"><input name="transaction_type" defaultValue={row.transaction_type ?? ""} className="field-input" /></FormField>
              <FormField label="Related purchase">
                <select name="related_purchase_id" defaultValue={row.related_purchase_id ?? ""} className="field-input">
                  <option value="">None</option>
                  {(purchases ?? []).map((purchase: any) => <option key={purchase.id} value={purchase.id}>{purchase.receipt_number ?? purchase.id.slice(0, 8)} - {purchase.order_date}</option>)}
                </select>
              </FormField>
              <FormField label="Related route">
                <select name="related_route_id" defaultValue={row.related_route_id ?? ""} className="field-input">
                  <option value="">None</option>
                  {(routes ?? []).map((route: any) => <option key={route.id} value={route.id}>{route.route_date} - {route.status}</option>)}
                </select>
              </FormField>
              <FormField label="Related machine">
                <select name="related_machine_id" defaultValue={row.related_machine_id ?? ""} className="field-input">
                  <option value="">None</option>
                  {(machines ?? []).map((machine: any) => <option key={machine.id} value={machine.id}>{machine.machine_code ?? machine.name} - {machine.name}</option>)}
                </select>
              </FormField>
              <FormField label="Related location">
                <select name="related_location_id" defaultValue={row.related_location_id ?? ""} className="field-input">
                  <option value="">None</option>
                  {(locations ?? []).map((location: any) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </FormField>
              <FormField label="Location text"><input name="location" defaultValue={row.location ?? ""} className="field-input" /></FormField>
              <FormField label="Receipt URL"><input name="receipt_url" type="url" defaultValue={row.receipt_url ?? ""} className="field-input" /></FormField>
              <div className="md:col-span-2">
                <FormField label="Description"><textarea name="description" rows={4} defaultValue={row.description ?? ""} className="field-input" /></FormField>
              </div>
              <div className="md:col-span-2">
                <FormField label="Notes"><textarea name="notes" rows={3} defaultValue={row.notes ?? ""} className="field-input" /></FormField>
              </div>
            </div>
          </FormSection>

          <FormSection title="Review state">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
                <input name="needs_review" type="checkbox" defaultChecked={Boolean(row.needs_review)} className="mt-1" />
                <span><span className="block font-semibold text-slate-900">Needs review</span><span className="text-slate-500">Keep this transaction in the review queue.</span></span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
                <input name="mark_reviewed" type="checkbox" defaultChecked={Boolean(row.needs_review)} className="mt-1" />
                <span><span className="block font-semibold text-slate-900">Mark reviewed</span><span className="text-slate-500">Clear review after saving these corrections.</span></span>
              </label>
              <div className="md:col-span-2">
                <FormField label="Review notes"><textarea name="review_notes" rows={3} defaultValue={row.review_notes ?? ""} className="field-input" /></FormField>
              </div>
            </div>
          </FormSection>

          <div className="flex flex-wrap gap-3"><FormSubmitButton pendingLabel="Saving transaction...">Save transaction</FormSubmitButton><SecondaryButton href={`/finance/transactions/${id}`}>Cancel</SecondaryButton></div>
        </LocalDraftForm>

        <FormSection title="Void or archive">
          <p className="text-sm text-slate-500">Voiding or archiving keeps the transaction record for audit and removes it from balance calculations.</p>
          <FinanceTransactionStatusActions id={id} status={row.transaction_status ?? "active"} />
        </FormSection>
      </FormPageLayout>
    </>
  );
}
