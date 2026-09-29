import { NextResponse } from "next/server";
import { callXyWebApi, getXyWebApiConfig } from "@/lib/xy-web-api";

const READ_ONLY_CANDIDATES = [
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

function rowsFromResponse(response: Record<string, unknown>) {
  const candidates = [response.data, response.rows, response.records, response.list, response.items];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const nested of [record.list, record.rows, record.records, record.items, record.data]) {
        if (Array.isArray(nested)) return nested.length;
      }
    }
  }
  return null;
}

function errorSummary(error: unknown) {
  if (!error || typeof error !== "object") {
    return { status: null, message: String(error ?? "Unknown error"), code: null, keys: [] as string[] };
  }
  const value = error as {
    status?: unknown;
    message?: unknown;
    response?: Record<string, unknown>;
  };
  const response = value.response && typeof value.response === "object" ? value.response : {};
  return {
    status: Number.isFinite(Number(value.status)) ? Number(value.status) : null,
    message: String(value.message ?? response.message ?? response.msg ?? "Unknown error").slice(0, 240),
    code: response.code ?? response.status ?? response.statusCode ?? null,
    keys: Object.keys(response).slice(0, 20),
  };
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ error: "Preview-only diagnostic." }, { status: 404 });
  }

  const config = getXyWebApiConfig();
  const commonBody = {
    pageNum: 1,
    pageSize: 1,
    shbhEqual: config.merchantId,
    shbh: config.merchantId,
    language: config.language,
    channel: config.channel,
  };

  const results = [];
  for (const path of READ_ONLY_CANDIDATES) {
    try {
      const result = await callXyWebApi(path, commonBody);
      results.push({
        path,
        reachable: true,
        httpStatus: result.httpStatus,
        code: result.response.code ?? result.response.status ?? result.response.statusCode ?? null,
        message: result.message,
        responseKeys: Object.keys(result.response).slice(0, 20),
        rowCount: rowsFromResponse(result.response as Record<string, unknown>),
      });
    } catch (error) {
      const summary = errorSummary(error);
      results.push({
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

  return NextResponse.json({
    configReady: config.ready,
    baseUrl: config.baseUrl,
    tested: results.length,
    results,
  });
}
