import "server-only";

type SupabaseLike = {
  from: (table: string) => any;
};

type MonthlyProfitBatchRow = {
  id?: unknown;
  report_type?: unknown;
  status?: unknown;
  is_active?: unknown;
  rows_found?: unknown;
  row_count?: unknown;
  rows_imported?: unknown;
  report_start_date?: unknown;
  report_end_date?: unknown;
  file_name?: unknown;
  original_file_name?: unknown;
  deleted_at?: unknown;
};

type MonthlyProfitSavedRow = {
  business_month?: unknown;
  report_start_date?: unknown;
  report_end_date?: unknown;
};

export type MonthlyProfitActivationResult =
  | {
      ok: true;
      batchId: string;
      rowCount: number;
      businessMonth: string;
      reportStartDate: string;
      reportEndDate: string;
      deactivatedBatchIds: string[];
    }
  | {
      ok: false;
      batchId: string;
      code: string | null;
      message: string;
      details: string | null;
    };

function text(value: unknown) {
  return String(value ?? "").trim();
}

function wholeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function dateOnly(value: unknown) {
  const candidate = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function monthStartFromDate(value: unknown) {
  const date = dateOnly(value);
  return date ? `${date.slice(0, 7)}-01` : null;
}

function monthEnd(monthStart: string) {
  const date = new Date(`${monthStart}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function errorPayload(error: unknown) {
  if (!error || typeof error !== "object") {
    return { code: null, message: text(error) || "Unknown database error", details: null };
  }
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return {
    code: text(row.code) || null,
    message: text(row.message) || text(row.details) || "Unknown database error",
    details: [text(row.details), text(row.hint)].filter(Boolean).join(" - ") || null,
  };
}

export function monthlyProfitBatchMonth(row: Pick<MonthlyProfitBatchRow, "report_start_date" | "report_end_date">) {
  return monthStartFromDate(row.report_start_date) ?? monthStartFromDate(row.report_end_date);
}

function savedRowsMonth(rows: MonthlyProfitSavedRow[]) {
  const months = Array.from(new Set(
    rows
      .map((row) => monthStartFromDate(row.business_month) ?? monthStartFromDate(row.report_start_date) ?? monthStartFromDate(row.report_end_date))
      .filter((value): value is string => Boolean(value)),
  ));
  return months.length === 1 ? months[0] : null;
}

function rangeFromSavedRows(rows: MonthlyProfitSavedRow[], fallbackMonth: string) {
  const starts = rows.map((row) => dateOnly(row.report_start_date)).filter((value): value is string => Boolean(value)).sort();
  const ends = rows.map((row) => dateOnly(row.report_end_date)).filter((value): value is string => Boolean(value)).sort();
  return {
    reportStartDate: starts[0] ?? fallbackMonth,
    reportEndDate: ends.at(-1) ?? monthEnd(fallbackMonth),
  };
}

export async function ensureMonthlyProfitBatchActivated({
  supabase,
  batchId,
  actorId,
}: {
  supabase: SupabaseLike;
  batchId: string;
  actorId?: string | null;
}): Promise<MonthlyProfitActivationResult> {
  const cleanBatchId = text(batchId);
  if (!cleanBatchId) {
    return { ok: false, batchId: "", code: "INVALID_BATCH", message: "Monthly Product Profit batch id is required.", details: null };
  }

  const batchResult = await supabase
    .from("vms_import_batches")
    .select("id, report_type, status, is_active, rows_found, row_count, rows_imported, report_start_date, report_end_date, file_name, original_file_name, deleted_at")
    .eq("id", cleanBatchId)
    .maybeSingle();

  if (batchResult.error || !batchResult.data?.id) {
    const error = errorPayload(batchResult.error ?? { code: "NOT_FOUND", message: "Monthly Product Profit import batch was not found." });
    return { ok: false, batchId: cleanBatchId, ...error };
  }

  const batch = batchResult.data as MonthlyProfitBatchRow;
  if (text(batch.report_type) !== "monthly_product_profit") {
    return {
      ok: false,
      batchId: cleanBatchId,
      code: "WRONG_REPORT_TYPE",
      message: "Only Monthly Product Profit imports can use this activation repair.",
      details: `report_type=${text(batch.report_type) || "unknown"}`,
    };
  }

  const [countResult, savedRowsResult] = await Promise.all([
    supabase
      .from("vms_monthly_product_profit")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", cleanBatchId),
    supabase
      .from("vms_monthly_product_profit")
      .select("business_month, report_start_date, report_end_date")
      .eq("import_batch_id", cleanBatchId)
      .limit(5000),
  ]);

  if (countResult.error || savedRowsResult.error) {
    const error = errorPayload(countResult.error ?? savedRowsResult.error);
    return { ok: false, batchId: cleanBatchId, ...error };
  }

  const savedRows = (savedRowsResult.data ?? []) as MonthlyProfitSavedRow[];
  const persistedRowCount = Math.max(wholeNumber(countResult.count), savedRows.length);
  if (persistedRowCount <= 0) {
    return {
      ok: false,
      batchId: cleanBatchId,
      code: "NO_MONTHLY_ROWS",
      message: "This batch has no saved Monthly Product Profit rows to activate.",
      details: "Reprocess the file or upload it again before activating it.",
    };
  }

  const businessMonth = savedRowsMonth(savedRows) ?? monthlyProfitBatchMonth(batch);
  if (!businessMonth) {
    return {
      ok: false,
      batchId: cleanBatchId,
      code: "MISSING_MONTH",
      message: "Snacky OS could not determine the sales month for this Monthly Product Profit batch.",
      details: "The batch and saved rows are missing a usable report date.",
    };
  }

  const { reportStartDate, reportEndDate } = rangeFromSavedRows(savedRows, businessMonth);
  const now = new Date().toISOString();
  const activationPayload = {
    status: "imported",
    is_active: true,
    report_type: "monthly_product_profit",
    rows_found: Math.max(persistedRowCount, wholeNumber(batch.rows_found)),
    row_count: Math.max(persistedRowCount, wholeNumber(batch.row_count)),
    rows_imported: persistedRowCount,
    report_start_date: reportStartDate,
    report_end_date: reportEndDate,
    imported_by: actorId ?? null,
    imported_at: now,
    updated_at: now,
    deleted_at: null,
    disabled_at: null,
    latest_error: null,
    last_error: null,
  };

  const activationResult = await supabase
    .from("vms_import_batches")
    .update(activationPayload)
    .eq("id", cleanBatchId)
    .select("id, status, is_active, rows_imported, report_start_date, report_end_date")
    .maybeSingle();

  if (activationResult.error || !activationResult.data?.id || activationResult.data.is_active === false) {
    const error = errorPayload(activationResult.error ?? { code: "ACTIVATION_NOT_SAVED", message: "Monthly Product Profit activation did not persist." });
    return { ok: false, batchId: cleanBatchId, ...error };
  }

  const olderBatchesResult = await supabase
    .from("vms_import_batches")
    .select("id, report_start_date, report_end_date")
    .eq("report_type", "monthly_product_profit")
    .eq("is_active", true)
    .is("deleted_at", null)
    .neq("id", cleanBatchId)
    .limit(5000);

  if (olderBatchesResult.error) {
    await supabase.from("vms_import_batches").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", cleanBatchId);
    const error = errorPayload(olderBatchesResult.error);
    return {
      ok: false,
      batchId: cleanBatchId,
      code: error.code,
      message: "The new monthly batch was kept inactive because Snacky OS could not verify older active files for the same month.",
      details: error.details ?? error.message,
    };
  }

  const deactivatedBatchIds = ((olderBatchesResult.data ?? []) as MonthlyProfitBatchRow[])
    .filter((row) => monthlyProfitBatchMonth(row) === businessMonth)
    .map((row) => text(row.id))
    .filter(Boolean);

  if (deactivatedBatchIds.length) {
    const deactivateResult = await supabase
      .from("vms_import_batches")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .in("id", deactivatedBatchIds);

    if (deactivateResult.error) {
      await supabase.from("vms_import_batches").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", cleanBatchId);
      const error = errorPayload(deactivateResult.error);
      return {
        ok: false,
        batchId: cleanBatchId,
        code: error.code,
        message: "The new monthly batch was kept inactive because older partial uploads for the same month could not be disabled safely.",
        details: error.details ?? error.message,
      };
    }
  }

  return {
    ok: true,
    batchId: cleanBatchId,
    rowCount: persistedRowCount,
    businessMonth,
    reportStartDate,
    reportEndDate,
    deactivatedBatchIds,
  };
}
