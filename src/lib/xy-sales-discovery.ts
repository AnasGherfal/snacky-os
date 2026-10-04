import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  callXyApiRaw,
  getXyVmsConfig,
  type XySalesDiscoveryEndpoint,
} from "@/lib/xy-vms-api";

type JsonRecord = Record<string, unknown>;

const CANDIDATES: XySalesDiscoveryEndpoint[] = [
  "queryOrder",
  "queryOrderDetail",
  "queryOrderDetails",
  "queryMachineOrder",
  "queryMachineOrderDetail",
  "querySale",
  "querySaleDetail",
  "querySaleDetails",
  "queryMachineSale",
  "queryTrade",
  "queryTradeDetail",
  "queryTradeDetails",
  "queryTransaction",
  "queryTransactionDetail",
  "queryTransactionDetails",
];

function arrayify(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is JsonRecord => Boolean(row && typeof row === "object" && !Array.isArray(row)));
  }
  if (!value || typeof value !== "object") return [];
  const record = value as JsonRecord;
  for (const key of ["rows", "records", "list", "items", "data", "result"]) {
    if (Array.isArray(record[key])) return arrayify(record[key]);
    if (record[key] && typeof record[key] === "object") {
      const nested = arrayify(record[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function responseShape(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
  const rows = arrayify(value);
  const first = rows[0] ?? null;
  return {
    top_level_keys: record ? Object.keys(record).sort().slice(0, 50) : [],
    row_count_detected: rows.length,
    first_row_keys: first ? Object.keys(first).sort().slice(0, 80) : [],
  };
}

function safeMessage(value: unknown) {
  return String(value ?? "").slice(0, 500);
}

export type XySalesDiscoverySummary = {
  endpoint: string;
  http_status: number | null;
  xy_code: string | null;
  message: string | null;
  request_params: string[];
  response_shape: ReturnType<typeof responseShape>;
  error: string | null;
};

async function createRun() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const config = getXyVmsConfig();

  const { data, error } = await supabase
    .from("vms_sync_runs")
    .insert({
      provider: "xy",
      sync_type: "sales_endpoint_discovery",
      status: "running",
      endpoint: "read-only query* discovery",
      merchant_id_masked: config.maskedMerchantId,
      request_summary: {
        candidate_count: CANDIDATES.length,
        mode: "read_only",
        note: "One-row signed probes; response values are not persisted.",
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) throw new Error(`Could not create XY discovery run: ${error?.message ?? "missing id"}`);
  return { supabase, runId: String(data.id), config };
}

export async function discoverXySalesEndpoints() {
  const { supabase, runId, config } = await createRun();
  const summaries: XySalesDiscoverySummary[] = [];

  for (const endpoint of CANDIDATES) {
    const params = {
      shbh: config.merchantId,
      pageNum: 1,
      pageSize: 1,
    };

    try {
      const result = await callXyApiRaw(endpoint, params);
      const response = result.response as JsonRecord;
      summaries.push({
        endpoint,
        http_status: result.httpStatus,
        xy_code: response.code === undefined || response.code === null ? null : String(response.code),
        message: response.message === undefined || response.message === null ? null : safeMessage(response.message),
        request_params: Object.keys(params).sort(),
        response_shape: responseShape(response.data ?? response),
        error: null,
      });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : null;
      const response = error && typeof error === "object" && "response" in error
        ? (error as { response?: unknown }).response
        : null;
      const responseRecord = response && typeof response === "object" && !Array.isArray(response)
        ? response as JsonRecord
        : null;

      summaries.push({
        endpoint,
        http_status: Number.isFinite(status) ? status : null,
        xy_code: responseRecord?.code === undefined || responseRecord?.code === null ? null : String(responseRecord.code),
        message: responseRecord?.message === undefined || responseRecord?.message === null
          ? null
          : safeMessage(responseRecord.message),
        request_params: Object.keys(params).sort(),
        response_shape: responseShape(responseRecord?.data ?? responseRecord),
        error: error instanceof Error ? safeMessage(error.message) : safeMessage(error),
      });
    }
  }

  const interesting = summaries.filter((row) => {
    if (row.http_status && row.http_status !== 404) return true;
    if (row.xy_code && !["404", "H0404"].includes(row.xy_code)) return true;
    if (row.message && !/not found|404/i.test(row.message)) return true;
    return row.response_shape.first_row_keys.length > 0;
  });

  const status = interesting.length ? "completed_with_warnings" : "completed";
  const message = interesting.length
    ? `XY sales endpoint discovery found ${interesting.length} candidate response(s) worth reviewing.`
    : "XY sales endpoint discovery completed; no candidate endpoint returned a distinguishable response.";

  const { error: updateError } = await supabase
    .from("vms_sync_runs")
    .update({
      status,
      row_count: summaries.length,
      rows_imported: 0,
      rows_updated: 0,
      rows_skipped: 0,
      error_count: 0,
      message,
      response_summary: {
        candidate_count: summaries.length,
        interesting_count: interesting.length,
        candidates: summaries,
      },
      errors: [],
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (updateError) throw new Error(`Could not save XY discovery result: ${updateError.message}`);

  return {
    runId,
    candidateCount: summaries.length,
    interestingCount: interesting.length,
    candidates: summaries,
  };
}
