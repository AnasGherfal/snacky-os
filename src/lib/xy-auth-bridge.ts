import "server-only";

import crypto from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { buildXySign, getXyVmsConfig } from "@/lib/xy-vms-api";

type JsonRecord = Record<string, unknown>;

type ProbeSummary = {
  method: string;
  endpoint: string;
  httpStatus: number | null;
  code: string | null;
  message: string | null;
  rowCount: number;
  topLevelKeys: string[];
  dataKeys: string[];
  success: boolean;
  error: string | null;
};

function compactMessage(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
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

function rowsFrom(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is JsonRecord => Boolean(row && typeof row === "object" && !Array.isArray(row)));
  }
  if (!value || typeof value !== "object") return [];
  const record = value as JsonRecord;
  for (const key of ["data", "rows", "records", "list", "items", "content", "result"]) {
    const rows = rowsFrom(record[key]);
    if (rows.length) return rows;
  }
  return [];
}

function recordKeys(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as JsonRecord).sort().slice(0, 50)
    : [];
}

async function postJson(url: string, body: JsonRecord, authorization?: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const responseText = await response.text();
    let json: JsonRecord = {};
    try {
      json = responseText ? JSON.parse(responseText) as JsonRecord : {};
    } catch {
      json = { message: responseText.slice(0, 300) };
    }
    return { response, json };
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json,text/plain,*/*" },
      cache: "no-store",
      signal: controller.signal,
    });
    const responseText = await response.text();
    let json: JsonRecord = {};
    try {
      json = responseText ? JSON.parse(responseText) as JsonRecord : {};
    } catch {
      json = { message: responseText.slice(0, 300) };
    }
    return { response, json };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(method: string, endpoint: string, httpStatus: number, json: JsonRecord): ProbeSummary {
  const data = json.data;
  const rows = rowsFrom(data ?? json);
  const code = json.code === undefined || json.code === null ? null : String(json.code);
  const message = compactMessage(json.message ?? json.msg ?? (data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord).msg : ""));
  return {
    method,
    endpoint,
    httpStatus,
    code,
    message: message || null,
    rowCount: rows.length,
    topLevelKeys: recordKeys(json),
    dataKeys: recordKeys(data),
    success: ["H0000", "1", "200"].includes(String(code ?? "")),
    error: null,
  };
}

function md5(value: string) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

async function signedTradeProbe() {
  const config = getXyVmsConfig();
  if (!config.ready) throw new Error(`Official XY API is not configured: ${config.missing.join(", ")}`);

  const now = new Date();
  const start = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const businessParams = {
    shbh: config.merchantId,
    orderBy: "jysj desc",
    pageNum: 1,
    pageSize: 1,
    starttime: tripoliDateTime(start),
    endtime: tripoliDateTime(now),
    language: "en",
    channel: "1",
  };
  const timestamp = Date.now().toString().padStart(13, "0");
  const signedBody = {
    key: config.key,
    timestamp,
    sign: buildXySign(config.secret, timestamp, businessParams),
    ...businessParams,
  };

  const endpoints = [
    "https://xcx.xynetweb.com/service-order/jqjymx/queryJqjymx",
    `${config.baseUrl}/queryJqjymx`,
    `${config.baseUrl}/jqjymx/queryJqjymx`,
  ];

  const attempts: ProbeSummary[] = [];
  for (const endpoint of endpoints) {
    try {
      const { response, json } = await postJson(endpoint, signedBody);
      const summary = summarize("official_signed", endpoint, response.status, json);
      attempts.push(summary);
      if (summary.success && summary.rowCount > 0) break;
    } catch (error) {
      attempts.push({
        method: "official_signed",
        endpoint,
        httpStatus: null,
        code: null,
        message: null,
        rowCount: 0,
        topLevelKeys: [],
        dataKeys: [],
        success: false,
        error: error instanceof Error ? compactMessage(error.message) : compactMessage(error),
      });
    }
  }
  return attempts;
}

async function freshCheckCode() {
  const { response, json } = await getJson("https://xcx.xynetweb.com/sram/comm/login/getCheckCode");
  const code = String(json.code ?? "");
  const value = json.data;
  if (!response.ok || code !== "H0000" || value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`XY check-code request failed with HTTP ${response.status}, code ${code || "unknown"}.`);
  }
  return String(value).trim();
}

async function ssoAttempt(strategy: "secret_as_inner_hash" | "secret_as_plaintext") {
  const config = getXyVmsConfig();
  const account = config.merchantId;
  const checkCode = await freshCheckCode();
  const inner = strategy === "secret_as_inner_hash"
    ? config.secret
    : md5(`${account}${config.secret}`);
  const password = md5(`${account}${inner}${checkCode}`);
  const endpoint = "https://xcx.xynetweb.com/sram/comm/login/onLoginSSO";

  try {
    const { response, json } = await postJson(endpoint, {
      password,
      account,
      checkCode,
      language: "en",
      channel: "1",
    });
    const summary = summarize(strategy, endpoint, response.status, json);
    const data = json.data && typeof json.data === "object" && !Array.isArray(json.data)
      ? json.data as JsonRecord
      : null;
    const sessionKey = String(data?.session_key ?? "").trim();
    return { summary: { ...summary, success: summary.success && Boolean(sessionKey) }, sessionKey };
  } catch (error) {
    return {
      summary: {
        method: strategy,
        endpoint,
        httpStatus: null,
        code: null,
        message: null,
        rowCount: 0,
        topLevelKeys: [],
        dataKeys: [],
        success: false,
        error: error instanceof Error ? compactMessage(error.message) : compactMessage(error),
      } satisfies ProbeSummary,
      sessionKey: "",
    };
  }
}

async function verifySession(sessionKey: string) {
  const now = new Date();
  const start = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const endpoint = "https://xcx.xynetweb.com/service-order/jqjymx/queryJqjymx";
  const { response, json } = await postJson(endpoint, {
    orderBy: "jysj desc",
    userid: "",
    pageNum: 1,
    pageSize: 1,
    jqmc: "",
    jqlx: "",
    shmc: "",
    chzt: "",
    dsfjybh: "",
    starttime: tripoliDateTime(start),
    endtime: tripoliDateTime(now),
    language: "en",
    channel: "1",
  }, sessionKey);
  return summarize("sso_session_verification", endpoint, response.status, json);
}

export async function probeXySalesAuthBridge() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const config = getXyVmsConfig();
  const attempts: ProbeSummary[] = [];
  attempts.push(...await signedTradeProbe());

  let winningMethod: string | null = attempts.find((row) => row.success && row.rowCount > 0)?.method ?? null;
  let sessionVerified = false;

  if (!winningMethod) {
    for (const strategy of ["secret_as_inner_hash", "secret_as_plaintext"] as const) {
      const login = await ssoAttempt(strategy);
      attempts.push(login.summary);
      if (!login.sessionKey) continue;
      const verified = await verifySession(login.sessionKey);
      attempts.push(verified);
      if (verified.success && verified.rowCount > 0) {
        winningMethod = strategy;
        sessionVerified = true;
        break;
      }
    }
  }

  const { data: run, error: insertError } = await supabase
    .from("vms_sync_runs")
    .insert({
      provider: "xy",
      sync_type: "sales_auth_bridge_probe",
      status: winningMethod ? "completed" : "completed_with_warnings",
      endpoint: "XY sales auth bridge",
      merchant_id_masked: config.maskedMerchantId,
      request_summary: {
        mode: "read_only",
        official_api_ready: config.ready,
        attempt_count: attempts.length,
        note: "No raw key, secret, password hash, check code, Authorization token, or transaction values are persisted.",
      },
      row_count: attempts.reduce((sum, row) => sum + row.rowCount, 0),
      rows_imported: 0,
      rows_updated: 0,
      rows_skipped: 0,
      error_count: winningMethod ? 0 : 1,
      message: winningMethod
        ? `XY sales auth bridge succeeded via ${winningMethod}.`
        : "XY sales auth bridge did not find a working automatic authentication path.",
      response_summary: {
        winning_method: winningMethod,
        session_verified: sessionVerified,
        attempts,
      },
      errors: winningMethod ? [] : ["No automatic XY sales authentication method succeeded."],
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError) throw new Error(`Could not save XY auth bridge probe: ${insertError.message}`);

  return {
    runId: String(run?.id ?? ""),
    winningMethod,
    sessionVerified,
    attempts,
  };
}
