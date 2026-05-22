import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { accountLabel, formatFinanceMoney } from "@/lib/finance-balance";
import { applyHighConfidenceFinanceSuggestions, confirmFinanceReviewGroup, importHistoricalFinanceTransactions } from "@/lib/finance-actions";
import { buildFinanceClarificationPrompts, buildFinanceReviewGroups, classifyFinanceRows, FINANCE_SOURCE_FILE, FINANCE_SOURCE_SHEET, readFinanceImportRows } from "@/lib/finance-import";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type FinanceImportParams = {
  tab?: string;
  total?: string;
  imported?: string;
  autoClassified?: string;
  needsReview?: string;
  ignored?: string;
  error?: string;
};

type ImportDisplayRow = {
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

function cell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  return String(value);
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
    raw_amount: row.record.signed_amount || row.record.transaction || null,
    direction: row.direction,
    raw_direction: row.record.money_flow ?? null,
    currency: row.currency,
    account_id: row.accountId,
    transaction_effect: row.transactionEffect,
    source_account_id: row.sourceAccountId,
    destination_account_id: row.destinationAccountId,
    category: row.categoryForTransaction,
    raw_category: row.record.final_bucket || row.record.bucket_override || row.record.auto_bucket || row.record.transaction_type || null,
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

function confidence(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function groupDisplayRows(rows: ImportDisplayRow[]) {
  const groups = new Map<string, ImportDisplayRow[]>();
  for (const row of rows.filter((item) => item.import_status === "needs_review")) {
    const key = row.review_group_key || row.review_reason || "needs_review";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return Array.from(groups.entries())
    .map(([key, groupRows]) => {
      const first = groupRows[0];
      const totalAmount = groupRows.reduce((total, row) => total + Math.abs(Number(row.amount ?? row.raw_amount ?? 0)), 0);
      const exampleDescriptions = Array.from(new Set(groupRows.map((row) => cell(row.original_description) === "-" ? cell(row.raw_category) : cell(row.original_description)))).slice(0, 3);
      return {
        key,
        title: first.clarification_question || `${groupRows.length} transactions need clarification`,
        count: groupRows.length,
        totalAmount,
        currency: first.suggested_currency || first.currency || "LYD",
        exampleDescriptions,
        suggestedCategory: first.suggested_category || first.category,
        suggestedAccount: first.suggested_account || first.account_id,
        suggestedMachine: first.suggested_machine,
        suggestedSourceAccount: first.suggested_source_account,
        suggestedDestinationAccount: first.suggested_destination_account,
        confidenceScore: confidence(first.confidence_score),
        question: first.clarification_question || "What should Snacky OS do with this group?",
        reason: first.review_reason || "Needs review",
        canConfirm: groupRows.every((row) => row.transaction_date && row.direction && row.amount !== null && (row.suggested_category || row.category) && (row.suggested_account || row.account_id)),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export default async function FinanceImportPage({ searchParams }: { searchParams: Promise<FinanceImportParams> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");

  const params = await searchParams;
  const activeTab = params.tab === "needs_review" ? "needs_review" : "summary";
  const supabase = getSupabaseServerClient();
  const sourceRows = await readFinanceImportRows().catch(() => []);
  const [stagedResult, existingResult] = supabase
    ? await Promise.all([
        safeSupabaseQuery<ImportDisplayRow>(
          supabase
            .from("finance_import_rows")
            .select("source_file, source_sheet, source_row, import_status, transaction_date, raw_date, amount, raw_amount, direction, raw_direction, currency, account_id, transaction_effect, source_account_id, destination_account_id, category, raw_category, original_description, review_reason, review_group_key, suggested_category, suggested_account, suggested_currency, suggested_machine, suggested_source_account, suggested_destination_account, confidence_score, clarification_question, financial_transaction_id")
            .eq("source_file", FINANCE_SOURCE_FILE)
            .eq("source_sheet", FINANCE_SOURCE_SHEET)
            .order("source_row", { ascending: true }),
        ),
        safeSupabaseQuery<any>(
          supabase
            .from("financial_transactions")
            .select("id, source_file, source_sheet, source_row, transaction_date, amount, signed_amount, currency, account_id, source_account_id, destination_account_id, transaction_effect, description, original_description")
            .limit(20000),
        ),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const stagedRows = !stagedResult.error && stagedResult.data?.length ? (stagedResult.data as ImportDisplayRow[]) : [];
  const previewClassified = stagedRows.length ? [] : classifyFinanceRows(sourceRows, ((existingResult.data ?? []) as any[]));
  const preview = stagedRows.length ? [] : previewRows(previewClassified);
  const rows = stagedRows.length ? stagedRows : preview;
  const attentionRows = rows.filter((row) => !["imported", "auto_classified", "confirmed"].includes(row.import_status));
  const importedCount = countStatus(rows, "imported") + countStatus(rows, "auto_classified") + countStatus(rows, "confirmed");
  const autoClassifiedCount = countStatus(rows, "auto_classified");
  const needsReviewCount = countStatus(rows, "needs_review");
  const ignoredCount = countStatus(rows, "ignored") + countStatus(rows, "skipped");
  const totalRows = rows.length || sourceRows.length;
  const stagedReviewGroups = groupDisplayRows(rows);
  const previewReviewGroups = buildFinanceReviewGroups(previewClassified);
  const reviewGroups = stagedRows.length ? stagedReviewGroups : previewReviewGroups;
  const clarificationPrompts = stagedRows.length
    ? stagedReviewGroups.slice(0, 10).map((group) => group.question)
    : buildFinanceClarificationPrompts(previewReviewGroups);
  const loadWarning = stagedResult.error?.message || existingResult.error?.message || null;

  return (
    <>
      <PageHeader
        title="Finance Import"
        subtitle="Import clear spreadsheet rows automatically and stage only unclear rows for review."
        action={<SecondaryButton href="/finance">Back to finance</SecondaryButton>}
      />
      {params.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{params.error}</div> : null}
      {loadWarning ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Finance import history could not be loaded, so this page is showing a fresh preview from the source file. {loadWarning}
        </div>
      ) : null}
      {params.imported !== undefined ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          Checked {params.total ?? totalRows} rows. Imported {params.imported} valid rows, auto-classified {params.autoClassified ?? 0}, staged {params.needsReview ?? 0} for review, ignored {params.ignored ?? 0}.
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Import valid spreadsheet rows automatically</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-500">
              Source: {FINANCE_SOURCE_FILE}. Rows with valid account, currency, amount, and category are imported. Ambiguous rows are grouped into a few clarification questions.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <form action={applyHighConfidenceFinanceSuggestions}>
              <SecondaryButton type="submit">Apply High-Confidence Suggestions</SecondaryButton>
            </form>
            <form action={importHistoricalFinanceTransactions}>
              <PrimaryButton>Import Valid Rows</PrimaryButton>
            </form>
          </div>
        </div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-5">
        <StatCard label="Total Rows" value={totalRows} note={stagedRows.length ? "Last import result" : "Preview before import"} />
        <StatCard label="Imported / Confirmed" value={importedCount} />
        <StatCard label="Auto-Classified" value={autoClassifiedCount} note="High-confidence suggestions" />
        <StatCard label="Needs Review" value={needsReviewCount} />
        <StatCard label="Ignored" value={ignoredCount} note="Duplicates or mirrored transfer rows" />
      </section>

      {clarificationPrompts.length ? (
        <section className="surface-card mb-6">
          <h2 className="text-lg font-semibold text-slate-900">Clarification Needed</h2>
          <div className="mt-3 grid gap-3">
            {clarificationPrompts.map((prompt, index) => (
              <div key={`${prompt}-${index}`} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{prompt}</div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mb-5 flex flex-wrap gap-2">
        <Link href="/finance/import" className={activeTab === "summary" ? "btn-primary" : "btn-secondary"}>Summary</Link>
        <Link href="/finance/import?tab=needs_review" className={activeTab === "needs_review" ? "btn-primary" : "btn-secondary"}>Needs Review</Link>
      </div>

      {activeTab === "needs_review" ? (
        !reviewGroups.length ? (
          <EmptyState title="No rows need review" body="The current import has no unclear rows. Clear rows can be imported automatically." />
        ) : (
          <DataTable headers={["Group", "Examples", "Total", "Suggestion", "Confidence", "Question", "Action"]}>
            {reviewGroups.map((group) => (
              <tr key={group.key}>
                <td>
                  <div className="font-medium text-slate-900">{group.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{group.count} rows</div>
                </td>
                <td className="max-w-md">{group.exampleDescriptions.join(" / ")}</td>
                <td>{formatFinanceMoney(group.totalAmount, group.currency)}</td>
                <td className="max-w-sm">
                  <div>{group.suggestedCategory ?? "-"}</div>
                  <div className="text-xs text-slate-500">
                    {group.suggestedSourceAccount && group.suggestedDestinationAccount
                      ? `${accountLabel(group.suggestedSourceAccount)} -> ${accountLabel(group.suggestedDestinationAccount)}`
                      : accountLabel(group.suggestedAccount)}
                  </div>
                  {group.suggestedMachine ? <div className="text-xs text-slate-500">Machine: {group.suggestedMachine}</div> : null}
                </td>
                <td><StatusBadge status={`${Math.round(group.confidenceScore <= 1 ? group.confidenceScore * 100 : group.confidenceScore)}%`} /></td>
                <td className="max-w-md">{group.question}</td>
                <td>
                  {group.canConfirm ? (
                    <form action={confirmFinanceReviewGroup}>
                      <input type="hidden" name="review_group_key" value={group.key} />
                      <button className="btn-secondary">Confirm group</button>
                    </form>
                  ) : (
                    <span className="text-sm text-slate-500">Needs answer</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )
      ) : !rows.length ? (
        <EmptyState title="No finance import rows found" body="The source file could not be read or has no rows." />
      ) : !attentionRows.length ? (
        <EmptyState title="No row-by-row review needed" body={`${importedCount} clear rows are ready to import automatically. Nothing needs manual review.`} />
      ) : (
        <section>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Rows needing attention</h2>
              <p className="mt-1 text-sm text-slate-500">Clear rows are not shown here because they do not need review.</p>
            </div>
            {reviewGroups.length ? <SecondaryButton href="/finance/import?tab=needs_review">Review unclear rows</SecondaryButton> : null}
          </div>
          <DataTable headers={["Source row", "Status", "Reason", "Date", "Direction", "Category", "Description"]}>
            {attentionRows.slice(0, 20).map((row) => (
              <tr key={`${row.source_file}-${row.source_sheet}-${row.source_row}`}>
                <td>{cell(row.source_sheet)}:{cell(row.source_row)}</td>
                <td><StatusBadge status={row.import_status} /></td>
                <td className="max-w-xs text-xs text-slate-500">{cell(row.review_reason ?? (row.import_status === "ignored" || row.import_status === "skipped" ? "Duplicate or ignored by import safeguards" : "-"))}</td>
                <td>{cell(row.transaction_date ?? row.raw_date)}</td>
                <td>{cell(row.direction?.replace("_", " ") ?? row.raw_direction)}</td>
                <td>{cell(row.category ?? row.raw_category)}</td>
                <td className="max-w-md">{cell(row.original_description)}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      )}
    </>
  );
}
