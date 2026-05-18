import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { importHistoricalFinanceTransactions } from "@/lib/finance-actions";
import { classifyFinanceRows, FINANCE_SOURCE_FILE, FINANCE_SOURCE_SHEET, readFinanceImportRows } from "@/lib/finance-import";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type FinanceImportParams = {
  tab?: string;
  total?: string;
  imported?: string;
  needsReview?: string;
  skipped?: string;
  error?: string;
};

type ImportDisplayRow = {
  source_file: string;
  source_sheet: string;
  source_row: number;
  import_status: "imported" | "needs_review" | "skipped";
  transaction_date: string | null;
  raw_date: string | null;
  amount: number | string | null;
  raw_amount: string | null;
  direction: string | null;
  raw_direction: string | null;
  category: string | null;
  raw_category: string | null;
  original_description: string | null;
  review_reason: string | null;
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
    category: row.category,
    raw_category: row.record.final_bucket || row.record.bucket_override || row.record.auto_bucket || row.record.transaction_type || null,
    original_description: row.originalDescription || null,
    review_reason: row.reasons.join("; ") || null,
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

export default async function FinanceImportPage({ searchParams }: { searchParams: Promise<FinanceImportParams> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) redirect("/unauthorized");

  const params = await searchParams;
  const activeTab = params.tab === "needs_review" ? "needs_review" : "summary";
  const supabase = getSupabaseServerClient();
  const sourceRows = await readFinanceImportRows().catch(() => []);
  const [stagedResult, existingResult] = supabase
    ? await Promise.all([
        safeSupabaseQuery<ImportDisplayRow>(
          supabase
            .from("finance_import_rows")
            .select("source_file, source_sheet, source_row, import_status, transaction_date, raw_date, amount, raw_amount, direction, raw_direction, category, raw_category, original_description, review_reason, financial_transaction_id")
            .eq("source_file", FINANCE_SOURCE_FILE)
            .eq("source_sheet", FINANCE_SOURCE_SHEET)
            .order("source_row", { ascending: true }),
        ),
        safeSupabaseQuery<any>(
          supabase
            .from("financial_transactions")
            .select("id, source_file, source_sheet, source_row, transaction_date, signed_amount, description, original_description")
            .limit(20000),
        ),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const stagedRows = !stagedResult.error && stagedResult.data?.length ? (stagedResult.data as ImportDisplayRow[]) : [];
  const preview = stagedRows.length ? [] : previewRows(classifyFinanceRows(sourceRows, ((existingResult.data ?? []) as any[])));
  const rows = stagedRows.length ? stagedRows : preview;
  const reviewRows = rows.filter((row) => row.import_status === "needs_review");
  const attentionRows = rows.filter((row) => row.import_status !== "imported");
  const importedCount = countStatus(rows, "imported");
  const needsReviewCount = countStatus(rows, "needs_review");
  const skippedCount = countStatus(rows, "skipped");
  const totalRows = rows.length || sourceRows.length;
  const loadWarning = stagedResult.error?.message || existingResult.error?.message || null;

  return (
    <AppShell>
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
          Checked {params.total ?? totalRows} rows. Imported {params.imported} valid rows, staged {params.needsReview ?? 0} for review, skipped {params.skipped ?? 0}.
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Import valid spreadsheet rows automatically</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-500">
              Source: {FINANCE_SOURCE_FILE}. Rows with valid date, amount, direction, and category do not need review. Only duplicates or unclear rows are shown for action.
            </p>
          </div>
          <form action={importHistoricalFinanceTransactions}>
            <PrimaryButton>Import Valid Rows</PrimaryButton>
          </form>
        </div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <StatCard label="Total Rows" value={totalRows} note={stagedRows.length ? "Last import result" : "Preview before import"} />
        <StatCard label="Imported Automatically" value={importedCount} />
        <StatCard label="Needs Review" value={needsReviewCount} />
        <StatCard label="Skipped" value={skippedCount} note="Existing source rows" />
      </section>

      <div className="mb-5 flex flex-wrap gap-2">
        <Link href="/finance/import" className={activeTab === "summary" ? "btn-primary" : "btn-secondary"}>Summary</Link>
        <Link href="/finance/import?tab=needs_review" className={activeTab === "needs_review" ? "btn-primary" : "btn-secondary"}>Needs Review</Link>
      </div>

      {activeTab === "needs_review" ? (
        !reviewRows.length ? (
          <EmptyState title="No rows need review" body="The current import has no unclear rows. Clear rows can be imported automatically." />
        ) : (
          <DataTable headers={["Source row", "Reason", "Date", "Amount", "Direction", "Category", "Original description"]}>
            {reviewRows.map((row) => (
              <tr key={`${row.source_file}-${row.source_sheet}-${row.source_row}`}>
                <td>{cell(row.source_sheet)}:{cell(row.source_row)}</td>
                <td className="max-w-xs"><StatusBadge status="needs_review" /><div className="mt-2 text-xs text-slate-500">{cell(row.review_reason ?? "Needs review")}</div></td>
                <td>{cell(row.transaction_date ?? row.raw_date)}</td>
                <td>{cell(row.amount ?? row.raw_amount)}</td>
                <td>{cell(row.direction?.replace("_", " ") ?? row.raw_direction)}</td>
                <td>{cell(row.category ?? row.raw_category)}</td>
                <td className="max-w-md">{cell(row.original_description)}</td>
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
            {reviewRows.length ? <SecondaryButton href="/finance/import?tab=needs_review">Review unclear rows</SecondaryButton> : null}
          </div>
          <DataTable headers={["Source row", "Status", "Reason", "Date", "Direction", "Category", "Description"]}>
            {attentionRows.slice(0, 20).map((row) => (
              <tr key={`${row.source_file}-${row.source_sheet}-${row.source_row}`}>
                <td>{cell(row.source_sheet)}:{cell(row.source_row)}</td>
                <td><StatusBadge status={row.import_status} /></td>
                <td className="max-w-xs text-xs text-slate-500">{cell(row.review_reason ?? (row.import_status === "skipped" ? "Already imported from this source row" : "-"))}</td>
                <td>{cell(row.transaction_date ?? row.raw_date)}</td>
                <td>{cell(row.direction?.replace("_", " ") ?? row.raw_direction)}</td>
                <td>{cell(row.category ?? row.raw_category)}</td>
                <td className="max-w-md">{cell(row.original_description)}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      )}
    </AppShell>
  );
}
