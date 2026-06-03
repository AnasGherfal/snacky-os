import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { accountLabel, formatFinanceMoney } from "@/lib/finance-balance";
import { confirmFinanceImportRow, ignoreFinanceImportRow, importHistoricalFinanceTransactions, importUploadedFinanceTransactions } from "@/lib/finance-actions";
import { classifyFinanceRows, readFinanceImportRows } from "@/lib/finance-import";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type FinanceImportParams = {
  total?: string;
  imported?: string;
  autoClassified?: string;
  needsReview?: string;
  ignored?: string;
  confirmed?: string;
  error?: string;
};

type ImportDisplayRow = {
  id?: string | null;
  import_batch_id?: string | null;
  source_file: string;
  source_sheet: string;
  source_row: number;
  import_status: "imported" | "auto_classified" | "needs_review" | "confirmed" | "ignored" | "skipped";
  transaction_date: string | null;
  raw_date: string | null;
  amount: number | string | null;
  raw_amount: string | null;
  direction: string | null;
  raw_direction: string | null;
  currency?: string | null;
  account_id?: string | null;
  transaction_effect?: string | null;
  source_account_id?: string | null;
  destination_account_id?: string | null;
  category: string | null;
  raw_category: string | null;
  original_description: string | null;
  review_reason: string | null;
  review_group_key?: string | null;
  suggested_category?: string | null;
  suggested_account?: string | null;
  suggested_currency?: string | null;
  suggested_machine?: string | null;
  suggested_source_account?: string | null;
  suggested_destination_account?: string | null;
  confidence_score?: number | string | null;
  clarification_question?: string | null;
  financial_transaction_id?: string | null;
  raw_record?: Record<string, unknown> | null;
};

function countStatus(rows: ImportDisplayRow[], status: ImportDisplayRow["import_status"]) {
  return rows.filter((row) => row.import_status === status).length;
}

async function safeSupabaseQuery<T>(query: PromiseLike<{ data: T[] | null; error: { message?: string } | null }>) {
  try {
    return await query;
  } catch (error) {
    return { data: [], error: { message: error instanceof Error ? error.message : "Unable to load finance import rows." } };
  }
}

async function safeSupabaseSingle<T>(query: PromiseLike<{ data: T | null; error: { message?: string } | null }>) {
  try {
    return await query;
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : "Unable to load latest finance import." } };
  }
}

function cell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  return String(value);
}

function raw(row: ImportDisplayRow, key: string, sourceHeader?: string) {
  const record = row.raw_record ?? {};
  const value = record[key] ?? (sourceHeader ? record[sourceHeader] : undefined);
  return cell(value);
}

function previewRows(rows: ReturnType<typeof classifyFinanceRows>): ImportDisplayRow[] {
  return rows.map((row) => ({
    source_file: row.sourceFile,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    import_status: row.importStatus,
    transaction_date: row.transactionDate,
    raw_date: row.record.date ?? null,
    amount: row.amount,
    raw_amount: row.record.transaction ?? row.record.signed_amount ?? null,
    direction: row.direction,
    raw_direction: row.record.money_flow ?? null,
    currency: row.currency,
    account_id: row.accountId,
    transaction_effect: row.transactionEffect,
    source_account_id: row.sourceAccountId,
    destination_account_id: row.destinationAccountId,
    category: row.categoryForTransaction,
    raw_category: row.record.transaction_type ?? null,
    original_description: row.originalDescription || null,
    review_reason: row.reviewReason,
    review_group_key: row.reviewGroupKey,
    suggested_category: row.suggestedCategory,
    suggested_account: row.suggestedAccount,
    suggested_currency: row.suggestedCurrency,
    suggested_machine: row.suggestedMachine,
    suggested_source_account: row.suggestedSourceAccount,
    suggested_destination_account: row.suggestedDestinationAccount,
    confidence_score: row.confidenceScore,
    clarification_question: row.clarificationQuestion,
    raw_record: row.record,
  }));
}

function StatCard({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="surface-card">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</div>
      {note ? <div className="mt-2 text-xs text-slate-500">{note}</div> : null}
    </div>
  );
}

function canQuickConfirm(row: ImportDisplayRow) {
  return Boolean(row.id && row.transaction_date && row.amount !== null && row.direction && row.currency && row.account_id && row.category && row.import_status !== "ignored");
}

function rowSuggestion(row: ImportDisplayRow) {
  if (row.suggested_source_account && row.suggested_destination_account) {
    return `${accountLabel(row.suggested_source_account)} -> ${accountLabel(row.suggested_destination_account)}`;
  }
  const name = raw(row, "name", "Name");
  return `${accountLabel(row.suggested_account ?? row.account_id)}; Name: ${name}`;
}

function rowAmount(row: ImportDisplayRow) {
  const value = Number(row.amount ?? row.raw_amount ?? 0);
  return Number.isFinite(value) ? formatFinanceMoney(Math.abs(value), row.currency ?? row.suggested_currency ?? "LYD") : cell(row.raw_amount);
}

export default async function FinanceImportPage({ searchParams }: { searchParams: Promise<FinanceImportParams> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = getSupabaseServerClient();
  const sourceRows = await readFinanceImportRows().catch(() => []);
  const [latestBatchResult, existingResult] = supabase
    ? await Promise.all([
        safeSupabaseSingle<any>(
          supabase
            .from("finance_import_batches")
            .select("id, source_file, source_sheet, row_count, imported_count, auto_classified_count, confirmed_count, needs_review_count, ignored_count, imported_at")
            .order("imported_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ),
        safeSupabaseQuery<any>(
          supabase
            .from("financial_transactions")
            .select("id, source_file, source_sheet, source_row, transaction_date, amount, signed_amount, currency, account_id, source_account_id, destination_account_id, transaction_effect, description, original_description, final_bucket")
            .limit(50000),
        ),
      ])
    : [{ data: null, error: null }, { data: [], error: null }];

  const latestBatch = latestBatchResult.data;
  const stagedResult = supabase && latestBatch?.id
    ? await safeSupabaseQuery<ImportDisplayRow>(
        supabase
          .from("finance_import_rows")
          .select("id, import_batch_id, source_file, source_sheet, source_row, import_status, transaction_date, raw_date, amount, raw_amount, direction, raw_direction, currency, account_id, transaction_effect, source_account_id, destination_account_id, category, raw_category, original_description, review_reason, review_group_key, suggested_category, suggested_account, suggested_currency, suggested_machine, suggested_source_account, suggested_destination_account, confidence_score, clarification_question, financial_transaction_id, raw_record")
          .eq("import_batch_id", latestBatch.id)
          .order("source_row", { ascending: true })
          .limit(5000),
      )
    : { data: [], error: null };

  const stagedRows = !stagedResult.error && stagedResult.data?.length ? (stagedResult.data as ImportDisplayRow[]) : [];
  const previewClassified = stagedRows.length ? [] : classifyFinanceRows(sourceRows, ((existingResult.data ?? []) as any[]));
  const preview = stagedRows.length ? [] : previewRows(previewClassified);
  const rows = stagedRows.length ? stagedRows : preview;
  const totalRows = rows.length || sourceRows.length;
  const importedCount = countStatus(rows, "imported") + countStatus(rows, "auto_classified");
  const confirmedCount = countStatus(rows, "confirmed");
  const needsReviewCount = countStatus(rows, "needs_review");
  const ignoredCount = countStatus(rows, "ignored") + countStatus(rows, "skipped");
  const loadWarning = latestBatchResult.error?.message || stagedResult.error?.message || existingResult.error?.message || null;
  const sourceLabel = stagedRows[0]?.source_file ?? sourceRows[0]?.sourceFile ?? latestBatch?.source_file ?? "No CSV loaded";

  return (
    <>
      <PageHeader
        title="Finance Import Review"
        subtitle="Import the Snacky Transactions CSV exactly, keep every transaction row visible, and confirm or fix rows one at a time."
        action={<SecondaryButton href="/finance">Back to finance</SecondaryButton>}
      />
      {params.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{params.error}</div> : null}
      {params.confirmed ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">Confirmed source row {params.confirmed}.</div> : null}
      {params.ignored ? <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Ignored source row {params.ignored}.</div> : null}
      {loadWarning ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Finance import history could not be fully loaded. {loadWarning}
        </div>
      ) : null}
      {params.imported !== undefined ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          Checked {params.total ?? totalRows} rows. Imported {params.imported} clear rows and staged {params.needsReview ?? 0} for row-by-row review.
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Upload or restage transactions</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              Source: {sourceLabel}. The parser starts at the row with Date, Name, Transaction Amount, Currency, Money Flow, Transaction Type, Location, and Transaction Description.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <form action={importUploadedFinanceTransactions} className="flex flex-col gap-2 sm:flex-row">
              <input name="file" type="file" accept=".csv,text/csv" className="field-input sm:w-80" />
              <PrimaryButton>Import CSV</PrimaryButton>
            </form>
            <form action={importHistoricalFinanceTransactions}>
              <SecondaryButton type="submit">Restage bundled CSV</SecondaryButton>
            </form>
          </div>
        </div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-5">
        <StatCard label="Transaction Rows" value={totalRows} note={stagedRows.length ? "Latest staged import" : "Preview before staging"} />
        <StatCard label="Imported" value={importedCount} note="Clear rows inserted" />
        <StatCard label="Confirmed" value={confirmedCount} note="Reviewed row by row" />
        <StatCard label="Needs Review" value={needsReviewCount} />
        <StatCard label="Ignored" value={ignoredCount} note="Manual only" />
      </section>

      {!rows.length ? (
        <EmptyState title="No finance import rows found" body="Upload the Snacky Transactions CSV or add it to docs/current-data before importing." />
      ) : (
        <section>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Source rows</h2>
              <p className="mt-1 text-sm text-slate-500">Every transaction row is listed with its original CSV values and suggested Snacky OS classification.</p>
            </div>
            {stagedRows.length ? <SecondaryButton href="/finance/transactions">View transactions</SecondaryButton> : null}
          </div>
          <DataTable headers={["Row", "Original CSV", "Suggested", "Status", "Actions"]}>
            {rows.map((row) => (
              <tr key={`${row.source_file}-${row.source_sheet}-${row.source_row}`}>
                <td>
                  <div className="font-medium text-slate-900">#{row.source_row}</div>
                  <div className="mt-1 text-xs text-slate-500">{row.source_sheet}</div>
                </td>
                <td className="min-w-[26rem]">
                  <div className="grid gap-2 text-sm md:grid-cols-2">
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Date</span><div>{cell(row.transaction_date ?? row.raw_date ?? raw(row, "date", "Date"))}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Name</span><div>{raw(row, "name", "Name")}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Amount</span><div>{rowAmount(row)}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Currency</span><div>{cell(row.currency ?? raw(row, "currency", "Currency"))}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Money Flow</span><div>{cell(row.raw_direction ?? row.direction)}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Type</span><div>{cell(row.raw_category ?? row.category)}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Location</span><div>{raw(row, "location", "Location")}</div></div>
                    <div><span className="text-xs font-semibold uppercase text-slate-500">Description</span><div>{cell(row.original_description ?? raw(row, "transaction_description", "Transaction Description"))}</div></div>
                  </div>
                </td>
                <td className="max-w-xs">
                  <div className="font-medium text-slate-900">{cell(row.suggested_category ?? row.category)}</div>
                  <div className="mt-1 text-xs text-slate-500">{rowSuggestion(row)}</div>
                  {row.suggested_machine ? <div className="mt-1 text-xs text-slate-500">Location: {row.suggested_machine}</div> : null}
                  {row.transaction_date && row.transaction_date <= "2026-05-15" ? <div className="mt-1 text-xs text-slate-500">Historical: does not double-count current balance</div> : null}
                </td>
                <td>
                  <StatusBadge status={row.import_status} />
                  {row.review_reason ? <div className="mt-2 max-w-xs text-xs leading-5 text-amber-700">{row.review_reason}</div> : null}
                </td>
                <td>
                  {row.id ? (
                    <div className="flex flex-col gap-2">
                      {row.financial_transaction_id ? <Link href={`/finance/transactions/${row.financial_transaction_id}`} className="btn-secondary">View</Link> : null}
                      {canQuickConfirm(row) && row.import_status !== "confirmed" ? (
                        <form action={confirmFinanceImportRow}>
                          <input type="hidden" name="row_id" value={row.id} />
                          <button className="btn-primary">Confirm</button>
                        </form>
                      ) : null}
                      {row.import_status !== "ignored" ? <Link href={`/finance/import/review/${row.id}`} className="btn-secondary">Edit and confirm</Link> : null}
                      {row.import_status !== "ignored" ? (
                        <details className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                          <summary className="cursor-pointer text-xs font-semibold text-slate-500">Advanced</summary>
                          <form action={ignoreFinanceImportRow} className="mt-2">
                            <input type="hidden" name="row_id" value={row.id} />
                            <button className="btn-secondary w-full">Ignore row</button>
                          </form>
                        </details>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-sm text-slate-500">Import CSV to stage actions</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      )}
    </>
  );
}
