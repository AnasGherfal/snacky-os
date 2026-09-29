import { RefillForecastDashboard } from "@/components/RefillForecastDashboard";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  buildMachineRefillForecasts,
  type RefillFillLine,
  type RefillMachine,
  type RefillStockHistory,
} from "@/lib/refill-forecast";

type RefillRow = {
  machine_id: string | null;
  import_batch_id?: string | null;
  suggested_qty: number | string | null;
  final_qty_to_take: number | string | null;
};

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" ");
}

function isMissingColumn(error: unknown, columns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

async function loadForecastMachines(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>,
) {
  const enriched = await supabase
    .from("machines")
    .select("id, name, machine_code, status, refill_open_days, refill_critical_percent, refill_today_percent, refill_target_percent, refill_minimum_units, refill_manual_daily_units")
    .eq("status", "active")
    .order("name");

  if (!enriched.error || !isMissingColumn(enriched.error, [
    "refill_open_days",
    "refill_critical_percent",
    "refill_today_percent",
    "refill_target_percent",
    "refill_minimum_units",
    "refill_manual_daily_units",
  ])) return enriched;

  return supabase
    .from("machines")
    .select("id, name, machine_code, status")
    .eq("status", "active")
    .order("name");
}

export function DashboardForecastSkeleton({ locale }: { locale: "en" | "ar" }) {
  return (
    <section className="surface-card p-4" aria-busy="true">
      <h2 className="text-lg font-semibold">{locale === "ar" ? "توقعات التعبئة" : "Refill forecast"}</h2>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
      </div>
    </section>
  );
}

export async function DashboardRefillForecastSection({
  locale,
  refillRows,
}: {
  locale: "en" | "ar";
  refillRows: RefillRow[];
}) {
  const supabase = getSupabaseAdminClient() ?? await getAuthenticatedSupabaseServerClient();
  if (!supabase) return null;

  const now = new Date();
  // demandRates only uses samples ending in the last 14 days and rejects
  // sample gaps longer than 7 days, so 21 days is sufficient input history.
  const since = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString();

  const [machinesResult, latestStockResult, stockHistoryResult, fillLinesResult] = await Promise.all([
    loadForecastMachines(supabase),
    supabase
      .from("latest_vms_stock_by_slot")
      .select("machine_id, product_id, slot_code, current_qty, capacity, captured_at, import_batch_id")
      .eq("source_provider", "xy"),
    supabase
      .from("vms_stock_snapshots")
      .select("machine_id, product_id, slot_code, current_qty, capacity, captured_at, import_batch_id, sync_run_id, batch:vms_import_batches!inner(status, deleted_at)")
      .eq("source_provider", "xy")
      .eq("import_row_status", "imported")
      .in("batch.status", ["imported", "imported_with_warnings"])
      .is("batch.deleted_at", null)
      .gte("captured_at", since)
      .order("captured_at", { ascending: false })
      .limit(10000),
    supabase
      .from("route_stop_fill_lines")
      .select("machine_id, product_id, actual_qty, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  const errors = [machinesResult.error, latestStockResult.error, stockHistoryResult.error, fillLinesResult.error].filter(Boolean);
  if (errors.length) {
    console.error("[dashboard:forecast] Deferred refill forecast failed", {
      errors: errors.map(errorText),
    });
    return (
      <section className="surface-card p-4">
        <h2 className="text-lg font-semibold">{locale === "ar" ? "توقعات التعبئة" : "Refill forecast"}</h2>
        <p className="mt-2 text-sm text-slate-500">
          {locale === "ar" ? "تعذر تحميل توقعات التعبئة الآن. بقية لوحة التحكم متاحة." : "Refill forecast could not load right now. The rest of the dashboard is still available."}
        </p>
      </section>
    );
  }

  const latestStock = (latestStockResult.data ?? []) as RefillStockHistory[];
  const latestXyBatchIds = new Set(
    latestStock.map((row) => textValue(row.import_batch_id)).filter((id): id is string => Boolean(id)),
  );
  const xyRefillRows = latestXyBatchIds.size > 0
    ? refillRows.filter((row) => row.import_batch_id && latestXyBatchIds.has(row.import_batch_id))
    : [];

  const storageCoverageByMachine = new Map<string, { machineId: string; requestedUnits: number; fillableUnits: number }>();
  xyRefillRows.forEach((row) => {
    const machineId = textValue(row.machine_id);
    if (!machineId) return;
    const current = storageCoverageByMachine.get(machineId) ?? { machineId, requestedUnits: 0, fillableUnits: 0 };
    current.requestedUnits += Math.max(0, numberValue(row.suggested_qty));
    current.fillableUnits += Math.max(0, numberValue(row.final_qty_to_take));
    storageCoverageByMachine.set(machineId, current);
  });

  const forecasts = buildMachineRefillForecasts({
    machines: (machinesResult.data ?? []) as RefillMachine[],
    latestStock,
    stockHistory: (stockHistoryResult.data ?? []) as RefillStockHistory[],
    fills: (fillLinesResult.data ?? []) as RefillFillLine[],
    storageCoverage: Array.from(storageCoverageByMachine.values()),
    now,
  });

  return <RefillForecastDashboard forecasts={forecasts} variant="overview" locale={locale} />;
}
