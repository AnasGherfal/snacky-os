import "server-only";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import type { UserProfile } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { callXyWebApi, getXyWebApiConfig, type XyWebApiConfig, type XyWebApiResult } from "@/lib/xy-web-api";

type SupabaseServer = NonNullable<ReturnType<typeof getSupabaseServerClient>>;
type JsonRecord = Record<string, unknown>;

type SyncOptions = {
  profile?: UserProfile | null;
};

type WebDashboardTestSummary = {
  endpoint: string;
  httpStatus: number | null;
  success: boolean;
  rowCount: number;
  sampleRows: unknown[];
  message: string | null;
  error: string | null;
};

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function arrayify(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as JsonRecord[];
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    for (const key of ["list", "rows", "items", "records", "data"]) {
      if (Array.isArray(record[key])) return arrayify(record[key]);
    }
    return [record];
  }
  return [];
}

function rowsFromResult(result: XyWebApiResult) {
  const response = result.response as JsonRecord;
  for (const key of ["list", "rows", "items", "records", "data"]) {
    if (key in response) return arrayify(response[key]);
  }
  return [];
}

function rowsFromErrorResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return arrayify(value);
  const response = value as JsonRecord;
  for (const key of ["list", "rows", "items", "records", "data"]) {
    if (key in response) return arrayify(response[key]);
  }
  return [];
}

function redactTokenString(value: string, config: XyWebApiConfig) {
  return config.authorization ? value.replaceAll(config.authorization, config.maskedAuthorization) : value;
}

function sanitizeForLog<T>(value: T, config: XyWebApiConfig): T {
  if (!config.authorization) return value;
  if (typeof value === "string") return redactTokenString(value, config) as T;
  try {
    return JSON.parse(redactTokenString(JSON.stringify(value), config)) as T;
  } catch {
    return value;
  }
}

async function createWebTestRun(supabase: SupabaseServer, profile: UserProfile | null | undefined, config: XyWebApiConfig) {
  const { data, error } = await supabase
    .from("vms_sync_runs")
    .insert({
      provider: "xy_web",
      sync_type: "web_dashboard_test",
      status: "running",
      endpoint: "/archives/queryMerchant",
      merchant_id_masked: config.maskedMerchantId,
      requested_by: profile?.team_member_id ?? null,
      request_summary: {
        provider: "xy_web",
        sync_type: "web_dashboard_test",
        base_url: config.baseUrl,
        merchant_id: config.maskedMerchantId,
        authorization: config.maskedAuthorization,
        language: config.language,
        channel: config.channel,
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) throw new Error(`Could not create XY web dashboard test run: ${error?.message ?? "missing id"}`);

  await logActivity({
    profile,
    action: "xy_web_dashboard_test_started",
    entityType: "vms_sync",
    entityId: data.id,
    entityLabel: "XY web dashboard test",
    metadata: { sync_type: "web_dashboard_test", provider: "xy_web", merchant_id: config.maskedMerchantId },
    summary: "Started XY web dashboard API test",
  });

  return data.id as string;
}

async function finishWebTestRun({
  supabase,
  profile,
  syncRunId,
  status,
  summary,
  errors,
  message,
}: {
  supabase: SupabaseServer;
  profile?: UserProfile | null;
  syncRunId: string;
  status: "completed" | "failed";
  summary: WebDashboardTestSummary;
  errors: string[];
  message: string;
}) {
  const { error } = await supabase
    .from("vms_sync_runs")
    .update({
      status,
      row_count: summary.rowCount,
      rows_imported: 0,
      rows_updated: 0,
      rows_skipped: 0,
      error_count: errors.length,
      message,
      response_summary: summary,
      errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", syncRunId);

  if (error) console.error("[xy-web] Failed to update web dashboard test run", error);

  await logActivity({
    profile,
    action: status === "failed" ? "xy_web_dashboard_test_failed" : "xy_web_dashboard_test_completed",
    entityType: "vms_sync",
    entityId: syncRunId,
    entityLabel: "XY web dashboard test",
    afterData: { status, summary, errors },
    metadata: { sync_type: "web_dashboard_test", provider: "xy_web" },
    summary: message,
  });
}

function revalidateWebTestPages() {
  revalidatePath("/admin/vms-api");
}

export async function testXyWebDashboard(options: SyncOptions = {}) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const profile = options.profile ?? null;
  const config = getXyWebApiConfig();
  const syncRunId = await createWebTestRun(supabase, profile, config);
  const endpoint = "/archives/queryMerchant";
  const body = {
    pageNum: 1,
    pageSize: 1,
    shbhEqual: config.merchantId,
    orderBy: "registtime desc",
    language: config.language,
    channel: config.channel,
  };

  try {
    const result = await callXyWebApi(endpoint, body);
    const rows = sanitizeForLog(rowsFromResult(result), config);
    const rawMessage = sanitizeForLog(result.message ?? String(result.response.message ?? result.response.msg ?? ""), config) || null;
    const summary: WebDashboardTestSummary = {
      endpoint,
      httpStatus: result.httpStatus,
      success: true,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3),
      message: rawMessage,
      error: null,
    };
    await finishWebTestRun({
      supabase,
      profile,
      syncRunId,
      status: "completed",
      summary,
      errors: [],
      message: "XY web dashboard API test completed",
    });
    revalidateWebTestPages();
    return { syncRunId, status: "completed" as const, summary };
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: unknown }).status) : null;
    const response = typeof error === "object" && error && "response" in error ? (error as { response?: unknown }).response : null;
    const rows = sanitizeForLog(rowsFromErrorResponse(response), config);
    const message = sanitizeForLog(safeErrorMessage(error), config);
    const summary: WebDashboardTestSummary = {
      endpoint,
      httpStatus: Number.isFinite(status) ? status : null,
      success: false,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3),
      message: null,
      error: message,
    };
    await finishWebTestRun({
      supabase,
      profile,
      syncRunId,
      status: "failed",
      summary,
      errors: [message],
      message: "XY web dashboard API test failed",
    });
    revalidateWebTestPages();
    return { syncRunId, status: "failed" as const, summary };
  }
}
