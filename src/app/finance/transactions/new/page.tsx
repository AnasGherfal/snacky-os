import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { LocalDraftForm } from "@/components/LocalDraft";
import { ManualFinanceTransactionFields } from "@/components/ManualFinanceTransactionFields";
import { FormField, FormPageLayout, FormSection, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canEditFinancialTransactions } from "@/lib/authz";
import { DEFAULT_FINANCE_CATEGORIES, type FinanceCategoryOption } from "@/lib/finance-categories";
import { createManualFinancialTransaction } from "@/lib/finance-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function NewFinanceTransactionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canEditFinancialTransactions({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");
  const { error } = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseServerClient();
  const [{ data: purchases }, { data: machines }, { data: locations }, { data: routes }, categoriesResult] = supabase
    ? await Promise.all([
        supabase.from("purchase_orders").select("id, receipt_number, order_date, status").order("order_date", { ascending: false }).limit(200),
        supabase.from("machines").select("id, name, machine_code").order("name").limit(200),
        supabase.from("locations").select("id, name").order("name").limit(200),
        supabase.from("routes").select("id, route_date, status").order("route_date", { ascending: false }).limit(200),
        supabase.from("finance_categories").select("id, name, type").eq("is_active", true).order("name"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [], error: null }];
  const categories = (categoriesResult.error ? DEFAULT_FINANCE_CATEGORIES : (categoriesResult.data ?? DEFAULT_FINANCE_CATEGORIES)) as FinanceCategoryOption[];

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="New financial transaction"
          subtitle="Manual money in/out after the historical import."
          breadcrumbs={[
            { label: "Finance", href: "/finance" },
            { label: "Transactions", href: "/finance/transactions" },
            { label: "New transaction" },
          ]}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <LocalDraftForm action={createManualFinancialTransaction} formType="finance-transaction" draftKeyParts={["new"]} className="space-y-5">
          <FormSection title="Money movement">
            <ManualFinanceTransactionFields categories={categories} defaults={{ transactionDate: today, direction: "money_out", accountId: "snacky_lyd" }} />
          </FormSection>
          <FormSection title="Details">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Payment method"><select name="payment_method" className="field-input"><option value="">Not set</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="other">Other</option></select></FormField>
              <FormField label="Transaction type"><input name="transaction_type" placeholder="Rent, salary, maintenance, owner transfer..." className="field-input" /></FormField>
              <FormField label="Location"><input name="location" className="field-input" /></FormField>
              <FormField label="Bucket"><input name="bucket" placeholder="Inventory, Inflow, Operations..." className="field-input" /></FormField>
              <FormField label="Final bucket"><input name="final_bucket" className="field-input" /></FormField>
              <FormField label="Related purchase"><select name="related_purchase_id" className="field-input"><option value="">None</option>{(purchases ?? []).map((purchase: any) => <option key={purchase.id} value={purchase.id}>{purchase.receipt_number ?? purchase.id.slice(0, 8)} - {purchase.order_date}</option>)}</select></FormField>
              <FormField label="Related route"><select name="related_route_id" className="field-input"><option value="">None</option>{(routes ?? []).map((route: any) => <option key={route.id} value={route.id}>{route.route_date} - {route.status}</option>)}</select></FormField>
              <FormField label="Related machine"><select name="related_machine_id" className="field-input"><option value="">None</option>{(machines ?? []).map((machine: any) => <option key={machine.id} value={machine.id}>{machine.machine_code ?? machine.name} - {machine.name}</option>)}</select></FormField>
              <FormField label="Related location"><select name="related_location_id" className="field-input"><option value="">None</option>{(locations ?? []).map((location: any) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></FormField>
              <FormField label="Receipt URL"><input name="receipt_url" type="url" className="field-input" /></FormField>
              <FormField label="Description"><textarea name="description" rows={4} className="field-input" /></FormField>
              <FormField label="Notes"><textarea name="notes" rows={4} className="field-input" /></FormField>
            </div>
          </FormSection>
          <div className="flex gap-3"><FormSubmitButton pendingLabel="Saving transaction...">Save transaction</FormSubmitButton><SecondaryButton href="/finance/transactions">Cancel</SecondaryButton></div>
        </LocalDraftForm>
      </FormPageLayout>
    </>
  );
}
