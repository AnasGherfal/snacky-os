import { redirect } from "next/navigation";
import { ManualFinanceTransactionFields } from "@/components/ManualFinanceTransactionFields";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canEditFinancialTransactions } from "@/lib/authz";
import { confirmFinanceImportRow } from "@/lib/finance-actions";
import { DEFAULT_FINANCE_CATEGORIES, type FinanceCategoryOption } from "@/lib/finance-categories";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function rawText(record: unknown, key: string, sourceHeader?: string) {
  if (!record || typeof record !== "object") return "";
  const row = record as Record<string, unknown>;
  const value = row[key] ?? (sourceHeader ? row[sourceHeader] : undefined);
  return value === null || value === undefined ? "" : String(value);
}

function display(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.trim() || "-";
}

function flowDirection(row: any): "money_in" | "money_out" | "transfer" {
  if (row.transaction_effect === "transfer") return "transfer";
  return row.direction === "money_in" ? "money_in" : "money_out";
}

export default async function FinanceImportRowReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canEditFinancialTransactions({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");

  const { id } = await params;
  const query = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/finance/import/review?error=Supabase%20is%20not%20configured.");

  const [{ data: row, error }, categoriesResult] = await Promise.all([
    supabase.from("finance_import_rows").select("*").eq("id", id).maybeSingle(),
    supabase.from("finance_categories").select("id, name, type, is_active").eq("is_active", true).order("name", { ascending: true }),
  ]);
  if (error) redirect(`/finance/import/review?error=${encodeURIComponent(error.message)}`);
  if (!row) redirect("/finance/import/review?error=Import%20row%20not%20found.");

  const categories: FinanceCategoryOption[] = categoriesResult.error
    ? DEFAULT_FINANCE_CATEGORIES
    : ((categoriesResult.data ?? []) as FinanceCategoryOption[]);
  const rawRecord = row.raw_record ?? {};
  const transactionDate = row.transaction_date ?? rawText(rawRecord, "date", "Date");
  const amount = row.amount ?? rawText(rawRecord, "transaction", "Transaction Amount");
  const category = row.category ?? row.suggested_category ?? "Uncategorized";
  const accountId = row.account_id ?? row.suggested_account ?? "snacky_lyd";
  const location = row.suggested_machine ?? rawText(rawRecord, "location", "Location");
  const description = row.original_description ?? rawText(rawRecord, "transaction_description", "Transaction Description");

  return (
    <>
      <PageHeader
        title={`Review Finance Row ${row.source_row}`}
        subtitle="Confirm the imported CSV row using the same account, direction, and category rules as manual transactions."
        action={<SecondaryButton href="/finance/import/review">Back to review</SecondaryButton>}
      />
      {query.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{query.error}</div> : null}

      <FormPageLayout>
        <FormSection title="Original CSV Row" description="These values came from the uploaded Snacky Transactions file.">
          <div className="grid gap-3 md:grid-cols-2">
            <div><div className="text-xs font-semibold uppercase text-slate-500">Date</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "date", "Date"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Name</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "name", "Name"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Transaction Amount</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "transaction", "Transaction Amount"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Currency</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "currency", "Currency"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Money Flow</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "money_flow", "Money Flow"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Transaction Type</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "transaction_type", "Transaction Type"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Location</div><div className="mt-1 text-sm text-slate-900">{display(rawText(rawRecord, "location", "Location"))}</div></div>
            <div><div className="text-xs font-semibold uppercase text-slate-500">Status</div><div className="mt-1"><StatusBadge status={row.import_status} /></div></div>
            <div className="md:col-span-2"><div className="text-xs font-semibold uppercase text-slate-500">Transaction Description</div><div className="mt-1 text-sm text-slate-900">{display(description)}</div></div>
            {row.review_reason ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 md:col-span-2">{row.review_reason}</div> : null}
          </div>
        </FormSection>

        <form action={confirmFinanceImportRow} className="space-y-5">
          <input type="hidden" name="row_id" value={row.id} />
          <FormSection title="Classify and Confirm">
            <ManualFinanceTransactionFields
              categories={categories}
              defaults={{
                transactionDate,
                direction: flowDirection(row),
                accountId,
                sourceAccountId: row.source_account_id ?? row.suggested_source_account,
                destinationAccountId: row.destination_account_id ?? row.suggested_destination_account,
                category,
                amount,
              }}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Location">
                <input name="location" defaultValue={location ?? ""} className="field-input" />
              </FormField>
              <FormField label="Description">
                <input name="description" defaultValue={description ?? ""} className="field-input" />
              </FormField>
              <FormField label="Notes" hint="Optional review note">
                <textarea name="notes" defaultValue={description ?? ""} rows={3} className="field-input" />
              </FormField>
            </div>
          </FormSection>
          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Confirm row</PrimaryButton>
            <SecondaryButton href="/finance/import/review">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </>
  );
}
