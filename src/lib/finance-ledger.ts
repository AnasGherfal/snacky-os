/* eslint-disable @typescript-eslint/no-explicit-any */
export const FINANCE_TRANSACTIONS_TABLE = "financial_transactions";

export const FINANCE_TRANSACTION_FULL_COLUMNS = [
  "id",
  "transaction_date",
  "transaction_datetime",
  "direction",
  "transaction_kind",
  "transaction_type",
  "location",
  "description",
  "notes",
  "amount",
  "signed_amount",
  "currency",
  "account_id",
  "account_key",
  "transaction_effect",
  "source_account_id",
  "destination_account_id",
  "import_status",
  "category",
  "bucket",
  "final_bucket",
  "payment_method",
  "transaction_status",
  "review_status",
  "needs_review",
  "source_sheet",
  "source_row",
  "related_purchase_id",
  "linked_purchase_id",
  "source_type",
  "source_id",
  "related_cash_collection_id",
  "linked_cash_collection_id",
  "related_route_id",
  "related_machine_id",
  "related_location_id",
  "receipt_url",
  "counterparty_text",
  "payer_text",
  "paid_to_text",
  "is_void",
  "voided_at",
  "void_reason",
  "created_at",
  "updated_at",
  "created_by",
] as const;

export const FINANCE_TRANSACTION_STABLE_COLUMNS = [
  "id",
  "transaction_date",
  "direction",
  "transaction_kind",
  "transaction_type",
  "location",
  "description",
  "notes",
  "amount",
  "signed_amount",
  "currency",
  "account_id",
  "transaction_effect",
  "source_account_id",
  "destination_account_id",
  "import_status",
  "category",
  "bucket",
  "final_bucket",
  "payment_method",
  "transaction_status",
  "review_status",
  "needs_review",
  "is_void",
  "voided_at",
  "source_sheet",
  "source_row",
  "related_purchase_id",
  "related_cash_collection_id",
  "related_route_id",
  "related_machine_id",
  "related_location_id",
  "receipt_url",
  "created_at",
] as const;

export const FINANCE_TRANSACTION_LEGACY_COLUMNS = [
  "id",
  "transaction_date",
  "direction",
  "transaction_kind",
  "transaction_type",
  "location",
  "description",
  "amount",
  "signed_amount",
  "bucket",
  "bucket_override",
  "final_bucket",
  "review_status",
  "needs_review",
  "source_sheet",
  "source_row",
  "related_purchase_id",
  "related_cash_collection_id",
  "created_by",
  "created_at",
  "updated_at",
] as const;

export type FinanceLedgerLevel = "full" | "stable" | "legacy";

export type FinanceLedgerQueryResult<T = any> = {
  data: T[];
  count: number | null;
  error: unknown | null;
  level: FinanceLedgerLevel;
  selectedColumns: readonly string[];
  warning: string | null;
};

export function supabaseErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return {
      code: null,
      message:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
      details: null,
      hint: null,
    };
  }
  const row = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return {
    code: row.code ?? null,
    message:
      row.message ??
      (error instanceof Error ? error.message : "Unknown database error"),
    details: row.details ?? null,
    hint: row.hint ?? null,
  };
}

export function financeErrorText(error: unknown) {
  const details = supabaseErrorDetails(error);
  return [details.code, details.message, details.details, details.hint]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
}

export function missingColumnFromError(
  error: unknown,
  selectedColumns: readonly string[],
) {
  const text = financeErrorText(error);
  return (
    selectedColumns.find((column) => text.includes(column.toLowerCase())) ??
    null
  );
}

export function isFinanceColumnOrSchemaError(error: unknown) {
  const text = financeErrorText(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return (
    code === "42703" ||
    code === "PGRST204" ||
    text.includes("schema cache") ||
    (text.includes("column") && text.includes("does not exist"))
  );
}

export function isFinancePermissionError(error: unknown) {
  const text = financeErrorText(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return (
    code === "42501" ||
    text.includes("permission denied") ||
    text.includes("row-level security") ||
    text.includes("rls")
  );
}

export function isFinanceRowVoided(row: any) {
  return Boolean(row?.is_void || row?.voided_at);
}

export function isVisibleFinanceLedgerRow(row: any) {
  return !isFinanceRowVoided(row);
}

export function applyVisibleFinanceLedgerFilter(query: any, level: FinanceLedgerLevel) {
  if (level === "legacy") return query;
  return query.or("is_void.eq.false,is_void.is.null");
}

export function financeCategoryLabel(row: any) {
  for (const value of [
    row?.category,
    row?.final_bucket,
    row?.transaction_type,
    row?.bucket,
  ]) {
    const label = String(value ?? "").trim();
    if (label) return label;
  }
  return "Uncategorized";
}

export function normalizeFinanceLedgerRow(row: any) {
  const amount = Math.abs(Number(row.amount ?? row.signed_amount ?? 0));
  const direction = row.direction === "money_in" ? "money_in" : "money_out";
  const signed = Number.isFinite(Number(row.signed_amount))
    ? Number(row.signed_amount)
    : direction === "money_out"
      ? -amount
      : amount;
  return {
    ...row,
    amount,
    signed_amount: signed,
    currency: row.currency ?? "LYD",
    account_id:
      row.account_id ??
      row.account_key ??
      row.source_account_id ??
      "snacky_lyd",
    account_key:
      row.account_key ??
      row.account_id ??
      row.source_account_id ??
      "snacky_lyd",
    is_void: row.is_void ?? false,
    category: financeCategoryLabel(row),
    transaction_status: isFinanceRowVoided(row) ? "voided" : "active",
    import_status:
      row.import_status ?? (row.needs_review ? "needs_review" : "imported"),
    payment_method: row.payment_method ?? null,
    notes: row.notes ?? null,
  };
}

export async function loadFinanceLedgerRows({
  buildQuery,
  label,
}: {
  label: string;
  buildQuery: (
    columns: readonly string[],
    level: FinanceLedgerLevel,
  ) => PromiseLike<{
    data: any[] | null;
    count?: number | null;
    error: unknown | null;
  }>;
}): Promise<FinanceLedgerQueryResult> {
  const attempts: { level: FinanceLedgerLevel; columns: readonly string[] }[] =
    [
      { level: "full", columns: FINANCE_TRANSACTION_FULL_COLUMNS },
      { level: "stable", columns: FINANCE_TRANSACTION_STABLE_COLUMNS },
      { level: "legacy", columns: FINANCE_TRANSACTION_LEGACY_COLUMNS },
    ];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    const result = await buildQuery(attempt.columns, attempt.level);
    if (!result.error) {
      const missing = lastError
        ? missingColumnFromError(
            lastError,
            attempts[attempt.level === "stable" ? 0 : 1]?.columns ?? [],
          )
        : null;
      const warning =
        attempt.level === "full"
          ? null
          : missing
            ? `Finance ledger loaded with ${attempt.level} columns because column "${missing}" is missing from the active Supabase schema.`
            : `Finance ledger loaded with ${attempt.level} columns because the latest finance schema is not fully available.`;
      return {
        data: ((result.data ?? []) as any[]).map(normalizeFinanceLedgerRow),
        count: result.count ?? null,
        error: null,
        level: attempt.level,
        selectedColumns: attempt.columns,
        warning,
      };
    }
    lastError = result.error;
    console.error(`[finance] ${label} failed with ${attempt.level} schema`, {
      table: FINANCE_TRANSACTIONS_TABLE,
      selected_columns: attempt.columns,
      missing_column: missingColumnFromError(result.error, attempt.columns),
      supabase_error: supabaseErrorDetails(result.error),
    });
    if (!isFinanceColumnOrSchemaError(result.error)) break;
  }
  return {
    data: [],
    count: 0,
    error: lastError,
    level: "legacy",
    selectedColumns: FINANCE_TRANSACTION_LEGACY_COLUMNS,
    warning: "No finance transactions loaded.",
  };
}
