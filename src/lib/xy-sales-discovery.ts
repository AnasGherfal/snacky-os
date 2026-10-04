import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
  callXyApiRaw,
  getXyVmsConfig,
  type XySalesDiscoveryEndpoint,
  type XyVmsParams,
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
  for (const key of ["rows", "records", "list", "items", "data", "result", "page", "content"]) {
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
    first_row_keys: first ? Object.keys(first).sort().slice(0, 100) : [],
  };
}

function safeMessage(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function tripoliDateTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.get("year")}-${map.get("month")}-${map.get("day")} ${map.get("hour")}:${map.get("minute")}:${map.get("second")}`;
}

function tripoliDate(date: Date) {
  return tripoliDateTime(date).slice(0, 10);
}

function discoveryVariants(merchantId: string, machineId: string | null) {
  const end = new Date();
  const start = new Date(end.getTime() - 72 * 60 * 60 * 1000);
  const merchant = { shbh: merchantId };
  const variants: Array<{ name: string; params: XyVmsParams }> = [
    { name: "merchant_only", params: merchant },
    { name: "page_num", params: { ...merchant, pageNum: 1, pageSize: 1 } },
    { name: "page_no", params: { ...merchant, pageNo: 1, pageSize: 1 } },
  ];

  if (machineId) {
    variants.push({
      name: "machine_page_num",
      params: { ...merchant, jqbh: machineId, pageNum: 1, pageSize: 1 },
    });
  }

  variants.push(
    {
      name: "start_end_time",
      params: {
        ...merchant,
        pageNum: 1,
        pageSize: 1,
        startTime: tripoliDateTime(start),
        endTime: tripoliDateTime(end),
      },
    },
    {
      name: "kssj_jssj",
      params: {
        ...merchant,
        pageNum: 1,
        pageSize: 1,
        kssj: tripoliDateTime(start),
        jssj: tripoliDateTime(end),
      },
    },
    {
      name: "start_end_date",
      params: {
        ...merchant,
        pageNum: 1,
        pageSize: 1,
        startDate: tripoliDate(start),
        endDate: tripoliDate(end),
      },
    },
  );

  return variants;
}

function parameterHint(message: string | null) {
  if (!message) return false;
  return /param|parameter|required|missing|不能为空|必填|参数|字段|时间|日期|页|merchant|machine|order|trade|sale|transaction/i.test(message);
}

function endpointConfidence(row: XySalesDiscoverySummary) {
  const code = String(row.xy_code ?? "");
  const shape = row.response_shape;
  if (shape.first_row_keys.length > 0 || shape.row_count_detected > 0) return 100;
  if (code === "1") return 80;
  if (parameterHint(row.message)) return 50;
  if (row.http_status && row.http_status >= 200 && row.http_status < 300 && row.message) return 20;
  return 0;
}

export type XySalesDiscoverySummary = {
  endpoint: string;
  variant: string;
  http_status: number | null;
  xy_code: string | null;
  message: string | null;
  request_params: string[];
  response_shape: ReturnType<typeof responseShape>;
  confidence: number;
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
        note: "Signed one-row probes. Discovery persists endpoint messages and field names, not transaction values.",
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) throw new Error(`Could not create XY discovery run: ${error?.message ?? "missing id"}`);
  return { supabase, runId: String(data.id), config };
}

async function firstXyMachineId(merchantId: string) {
  try {
    const result = await callXyApiRaw("queryMachine", { shbh: merchantId });
    return arrayify(result.response.data)
      .map((row) => String(row.jqbh ?? "").trim())
      .find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function probe(endpoint: XySalesDiscoveryEndpoint, variant: string, params: XyVmsParams): Promise<XySalesDiscoverySummary> {
  try {
    const result = await callXyApiRaw(endpoint, params);
    const response = result.response as JsonRecord;
    const summary: XySalesDiscoverySummary = {
      endpoint,
      variant,
      http_status: result.httpStatus,
      xy_code: response.code === undefined || response.code === null ? null : String(response.code),
      message: response.message === undefined || response.message === null ? null : safeMessage(response.message),
      request_params: Object.keys(params).sort(),
      response_shape: responseShape(response.data ?? response),
      confidence: 0,
      error: null,
    };
    summary.confidence = endpointConfidence(summary);
    return summary;
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

    const summary: XySalesDiscoverySummary = {
      endpoint,
      variant,
      http_status: Number.isFinite(status) ? status : null,
      xy_code: responseRecord?.code === undefined || responseRecord?.code === null ? null : String(responseRecord.code),
      message: responseRecord?.message === undefined || responseRecord?.message === null
        ? null
        : safeMessage(responseRecord.message),
      request_params: Object.keys(params).sort(),
      response_shape: responseShape(responseRecord?.data ?? responseRecord),
      confidence: 0,
      error: error instanceof Error ? safeMessage(error.message) : safeMessage(error),
    };
    summary.confidence = endpointConfidence(summary);
    return summary;
  }
}

export async function discoverXySalesEndpoints() {
  const { supabase, runId, config } = await createRun();
  const machineId = await firstXyMachineId(config.merchantId);
  const attempts: XySalesDiscoverySummary[] = [];

  for (const endpoint of CANDIDATES) {
    let endpointConfirmed = false;

    for (const variant of discoveryVariants(config.merchantId, machineId)) {
      const summary = await probe(endpoint, variant.name, variant.params);
      attempts.push(summary);

      // A row-bearing response gives us both the endpoint and its field schema.
      if (summary.response_shape.row_count_detected > 0 || summary.response_shape.first_row_keys.length > 0) {
        endpointConfirmed = true;
        break;
      }

      // Code 1 confirms the endpoint even if this small date window is empty.
      // Keep trying only enough alternate shapes to find row keys.
      if (String(summary.xy_code ?? "") === "1") {
        endpointConfirmed = true;
      }

      // Strong parameter hints mean the endpoint exists. Keep subsequent variants,
      // because a different common parameter spelling may satisfy it.
      if (summary.confidence >= 50) endpointConfirmed = true;
    }

    const endpointAttempts = attempts.filter((row) => row.endpoint === endpoint);
    if (endpointConfirmed && endpointAttempts.some((row) => row.response_shape.first_row_keys.length > 0)) {
      // Stop across endpoints once the vendor has returned real transaction-row field names.
      break;
    }
  }

  const ranked = [...attempts]
    .filter((row) => row.confidence > 0)
    .sort((left, right) =>
      right.confidence - left.confidence
      || right.response_shape.row_count_detected - left.response_shape.row_count_detected
      || left.endpoint.localeCompare(right.endpoint),
    );

  const best = ranked[0] ?? null;
  const status = best ? "completed_with_warnings" : "completed";
  const message = best
    ? `XY sales discovery found a best candidate: ${best.endpoint} (${best.variant}, confidence ${best.confidence}).`
    : "XY sales endpoint discovery completed; no candidate endpoint returned a distinguishable response.";

  const { error: updateError } = await supabase
    .from("vms_sync_runs")
    .update({
      status,
      row_count: attempts.length,
      rows_imported: 0,
      rows_updated: 0,
      rows_skipped: 0,
      error_count: 0,
      message,
      response_summary: {
        candidate_endpoint_count: CANDIDATES.length,
        probe_count: attempts.length,
        first_machine_available: Boolean(machineId),
        best_candidate: best,
        ranked_candidates: ranked.slice(0, 12),
        attempts,
      },
      errors: [],
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (updateError) throw new Error(`Could not save XY discovery result: ${updateError.message}`);

  return {
    runId,
    candidateCount: CANDIDATES.length,
    probeCount: attempts.length,
    interestingCount: ranked.length,
    bestCandidate: best,
    candidates: ranked,
  };
}
