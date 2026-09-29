import { NextResponse } from "next/server";
import { callXyWebApi, getXyWebApiConfig } from "@/lib/xy-web-api";
import { buildXySign, getXyVmsConfig, normalizeXyApiResponse } from "@/lib/xy-vms-api";

type JsonRecord = Record<string, unknown>;

const WEB_READ_ONLY_CANDIDATES = [
  "/archives/queryMerchant",
  "/archives/queryMachine",
  "/archives/queryGood",
  "/archives/queryGoods",
  "/archives/queryOrder",
  "/archives/querySale",
  "/archives/queryTrade",
  "/order/queryOrder",
  "/order/queryOrderList",
  "/sales/querySale",
  "/sales/querySales",
  "/report/querySale",
  "/statistics/querySale",
  "/transaction/queryTrade",
] as const;

const OFFICIAL_READ_ONLY_CANDIDATES = [
  "queryMachine",
  "queryGoodDetails",
  "queryMachineState",
  "queryMachineHdGoodPlus",
  "queryOrder",
  "queryOrderDetail",
  "queryOrderDetails",
  "queryOrderRecord",
  "querySale",
  "querySales",
  "queryMachineSale",
  "queryMachineSales",
  "queryTrade",
  "queryTradeDetails",
  "queryMachineTrade",
  "queryPayRecord",
  "queryPayRecords",
  "queryTransaction",
  "queryTransactions",
  "queryConsumeRecord",
  "querySettlement",
  "queryRefund",
  "queryRefundRecord",
  "queryMachineFault",
  "queryMachineAlarm",
  "queryMachineCash",
  "queryMachineBill",
] as const;

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

function rowsFromResponse(response: JsonRecord) {
  for (const key of ["data", "rows", "records", "list", "items"]) {
    if (key in response) return arrayify(response[key]).length;
  }
  return null;
}

function responseCode(response: JsonRecord) {
  const value = response.code ?? response.status ?? response.statusCode ?? null;
  return value === null || value === undefined ? null : String(value);
}

function responseMessage(response: JsonRecord) {
  const value = response.message ?? response.msg ?? response.error ?? response.errMsg ?? null;
  return value === null || value === undefined ? null : String(value).slice(0, 240);
}

function errorSummary(error: unknown) {
  if (!error || typeof error !== "object") {
    return { status: null, message: String(error ?? "Unknown error"), code: null, keys: [] as string[] };
  }
  const value = error as {
    status?: unknown;
    message?: unknown;
    response?: JsonRecord;
  };
  const response = value.response && typeof value.response === "object" ? value.response : {};
  return {
    status: Number.isFinite(Number(value.status)) ? Number(value.status) : null,
    message: String(value.message ?? response.message ?? response.msg ?? "Unknown error").slice(0, 240),
    code: response.code ?? response.status ?? response.statusCode ?? null,
    keys: Object.keys(response).slice(0, 20),
  };
}

async function callOfficialQuery(endpoint: string, params: Record<string, string | number>) {
  const config = getXyVmsConfig();
  const timestamp = Date.now().toString().padStart(13, "0");
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => String(value ?? "").trim() !== ""),
  ) as Record<string, string | number>;
  const body = config.includeAuthFields
    ? {
        key: config.key,
        timestamp,
        sign: buildXySign(config.secret, timestamp, cleanParams),
        ...cleanParams,
      }
    : cleanParams;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 12_000));
  try {
    const response = await fetch(`${config.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const responseText = await response.text();
    let parsed: JsonRecord = {};
    try {
      parsed = responseText ? normalizeXyApiResponse(JSON.parse(responseText) as JsonRecord) as JsonRecord : {};
    } catch {
      parsed = { message: responseText.slice(0, 240) };
    }
    return {
      endpoint,
      httpStatus: response.status,
      httpOk: response.ok,
      code: responseCode(parsed),
      message: responseMessage(parsed),
      responseKeys: Object.keys(parsed).filter((key) => key !== "rawEnvelope").slice(0, 20),
      rowCount: rowsFromResponse(parsed),
      rows: arrayify(parsed.data),
    };
  } catch (error) {
    return {
      endpoint,
      httpStatus: 0,
      httpOk: false,
      code: null,
      message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      responseKeys: [] as string[],
      rowCount: null,
      rows: [] as JsonRecord[],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("probe") !== "xyprobe-20260929-9f7d2a81c3b64e5a") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const webConfig = getXyWebApiConfig();
  const vmsConfig = getXyVmsConfig();

  const webResults: Array<Record<string, unknown>> = [];
  if (webConfig.ready) {
    const commonBody = {
      pageNum: 1,
      pageSize: 1,
      shbhEqual: webConfig.merchantId,
      shbh: webConfig.merchantId,
      language: webConfig.language,
      channel: webConfig.channel,
    };

    for (const path of WEB_READ_ONLY_CANDIDATES) {
      try {
        const result = await callXyWebApi(path, commonBody);
        webResults.push({
          path,
          reachable: true,
          httpStatus: result.httpStatus,
          code: result.response.code ?? result.response.status ?? result.response.statusCode ?? null,
          message: result.message,
          responseKeys: Object.keys(result.response).slice(0, 20),
          rowCount: rowsFromResponse(result.response as JsonRecord),
        });
      } catch (error) {
        const summary = errorSummary(error);
        webResults.push({
          path,
          reachable: summary.status !== 404,
          httpStatus: summary.status,
          code: summary.code,
          message: summary.message,
          responseKeys: summary.keys,
          rowCount: null,
        });
      }
    }
  }

  const officialResults: Array<Record<string, unknown>> = [];
  let firstMachineId = "";
  if (vmsConfig.ready) {
    const machineBaseline = await callOfficialQuery("queryMachine", { shbh: vmsConfig.merchantId });
    const firstMachine = machineBaseline.rows.find((row) => String(row.jqbh ?? "").trim());
    firstMachineId = String(firstMachine?.jqbh ?? "").trim();

    for (const endpoint of OFFICIAL_READ_ONLY_CANDIDATES) {
      const machineScoped = endpoint.startsWith("queryMachine") && endpoint !== "queryMachine";
      const params: Record<string, string | number> = { shbh: vmsConfig.merchantId };
      if (machineScoped && firstMachineId) params.jqbh = firstMachineId;
      const result = endpoint === "queryMachine"
        ? machineBaseline
        : await callOfficialQuery(endpoint, params);
      officialResults.push({
        endpoint,
        httpStatus: result.httpStatus,
        httpOk: result.httpOk,
        code: result.code,
        message: result.message,
        responseKeys: result.responseKeys,
        rowCount: result.rowCount,
      });
    }
  }

  return NextResponse.json({
    web: {
      configReady: webConfig.ready,
      missing: webConfig.missing,
      baseUrl: webConfig.baseUrl,
      tested: webResults.length,
      results: webResults,
    },
    official: {
      configReady: vmsConfig.ready,
      missing: vmsConfig.missing,
      baseUrl: vmsConfig.baseUrl,
      machineContextAvailable: Boolean(firstMachineId),
      tested: officialResults.length,
      results: officialResults,
    },
  });
}
