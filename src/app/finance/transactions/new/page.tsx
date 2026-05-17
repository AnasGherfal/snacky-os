import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { createManualFinancialTransaction } from "@/lib/finance-actions";

export default async function NewFinanceTransactionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");
  const { error } = await searchParams;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="New financial transaction" subtitle="Manual money in/out after the historical import." />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <form action={createManualFinancialTransaction} className="space-y-5">
          <FormSection title="Transaction">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Date" required><input name="transaction_date" type="date" defaultValue={today} required className="field-input" /></FormField>
              <FormField label="Direction" required><select name="direction" className="field-input"><option value="money_out">Money out</option><option value="money_in">Money in</option></select></FormField>
              <FormField label="Amount" required><input name="amount" type="number" step="0.01" min="0.01" required className="field-input" /></FormField>
              <FormField label="Transaction type"><input name="transaction_type" placeholder="Rent, salary, maintenance, owner transfer..." className="field-input" /></FormField>
              <FormField label="Location"><input name="location" className="field-input" /></FormField>
              <FormField label="Bucket"><input name="bucket" placeholder="Inventory, Inflow, Operations..." className="field-input" /></FormField>
              <FormField label="Final bucket"><input name="final_bucket" className="field-input" /></FormField>
              <FormField label="Description"><textarea name="description" rows={4} className="field-input" /></FormField>
            </div>
          </FormSection>
          <div className="flex gap-3"><PrimaryButton>Save transaction</PrimaryButton><SecondaryButton href="/finance/transactions">Cancel</SecondaryButton></div>
        </form>
      </FormPageLayout>
    </AppShell>
  );
}
