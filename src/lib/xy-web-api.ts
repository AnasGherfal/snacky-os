import "server-only";

export type XyWebApiBody = Record<string, unknown>;

export type XyWebApiResponse<T = unknown> = {
  code?: string | number;
  msg?: string;
  message?: string;
  data?: T;
  rows?: T;
  records?: T;
  [key: string]: unknown;
};

export type XyWebApiResult<T = unknown> = {
  path: string;
  httpStatus: number;
  ok: boolean;
  response: XyWebApiResponse<T>;
  responseText: string;
  message: string | null;
};

export type XyWebApiConfig = {
  enabled: boolean;
  baseUrl: string;
  authorization: string;
  merchantId: string;
  language: string;
  channel: string;
  timeoutMs: number;
  maskedAuthorization: string;
  maskedMerchantId: string;
  ready: boolean;
  missing: string[];
};

export class XyWebApiError extends Error {
  path: string;
  status?: number;
  response?: XyWebApiResponse;
  responseText?: string;

  constructor(
    message: string,
    options: {
      path: string;
      status?: number;
      response?: XyWebApiResponse;
      responseText?: string;
    },
  ) {
    super(message);
    this.name = "XyWebApiError";
    this.path = options.path;
    this.status = options.status;
    this.response = options.response;
    this.responseText = options.responseText;
  }
}

const defaultBaseUrl = "https://xcx.xynetweb.com/sram";
const dashboardOrigin = "https://www.xynetweb.com";

function envFlag(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envNumber(value: string | undefined, defaultValue: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function cleanBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function cleanPath(path: string) {
  return path.replace(/^\/+/, "");
}

function responseMessage(response: XyWebApiResponse) {
  const raw = response.message ?? response.msg ?? response.error ?? response.errMsg ?? null;
  return raw === null || raw === undefined ? null : String(raw);
}

function responseCode(response: XyWebApiResponse) {
  const raw = response.code ?? response.statusCode ?? response.status ?? null;
  return raw === null || raw === undefined ? null : String(raw).trim();
}

function isFailureCode(code: string | null) {
  if (!code) return false;
  return !["0", "1", "200", "ok", "success"].includes(code.toLowerCase());
}

function looksLikeSessionFailure(code: string | null, message: string | null) {
  const value = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return (
    value.includes("401") ||
    value.includes("403") ||
    value.includes("unauthorized") ||
    value.includes("forbidden") ||
    value.includes("session expired") ||
    value.includes("token expired") ||
    value.includes("login expired")
  );
}

export function maskXyWebSecret(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "Not set";
  if (text.length <= 4) return "*".repeat(text.length);
  if (text.length <= 8) return `${text.slice(0, 2)}${"*".repeat(text.length - 4)}${text.slice(-2)}`;
  return `${text.slice(0, 4)}${"*".repeat(Math.max(4, text.length - 8))}${text.slice(-4)}`;
}

export function getXyWebApiConfig(): XyWebApiConfig {
  const baseUrl = cleanBaseUrl(process.env.XY_WEB_API_BASE_URL || defaultBaseUrl);
  const authorization = String(process.env.XY_WEB_API_AUTHORIZATION ?? "").trim();
  const merchantId = String(process.env.XY_WEB_MERCHANT_ID ?? "6591").trim();
  const language = String(process.env.XY_WEB_LANGUAGE ?? "en").trim();
  const channel = String(process.env.XY_WEB_CHANNEL ?? "1").trim();
  const timeoutMs = envNumber(process.env.XY_WEB_API_TIMEOUT_MS, 30000);
  const enabled = envFlag(process.env.XY_WEB_ENABLED, false);
  const missing = [
    enabled ? "" : "XY_WEB_ENABLED=true",
    baseUrl ? "" : "XY_WEB_API_BASE_URL",
    authorization ? "" : "XY_WEB_API_AUTHORIZATION",
    merchantId ? "" : "XY_WEB_MERCHANT_ID",
    language ? "" : "XY_WEB_LANGUAGE",
    channel ? "" : "XY_WEB_CHANNEL",
  ].filter(Boolean);

  return {
    enabled,
    baseUrl,
    authorization,
    merchantId,
    language,
    channel,
    timeoutMs,
    maskedAuthorization: maskXyWebSecret(authorization),
    maskedMerchantId: maskXyWebSecret(merchantId),
    ready: missing.length === 0,
    missing,
  };
}

export function assertXyWebApiReady(config = getXyWebApiConfig()) {
  if (!config.authorization) {
    throw new XyWebApiError("XY web authorization token is not configured.", {
      path: "/",
      status: 0,
      response: { code: "missing_authorization", message: "XY web authorization token is not configured." },
    });
  }
  if (config.ready) return;
  throw new XyWebApiError(`XY web dashboard API is not ready: ${config.missing.join(", ")}.`, {
    path: "/",
    status: 0,
    response: { code: "not_ready", message: `Missing ${config.missing.join(", ")}` },
  });
}

export async function callXyWebApi<T = unknown>(path: string, body: XyWebApiBody): Promise<XyWebApiResult<T>> {
  const config = getXyWebApiConfig();
  const normalizedPath = `/${cleanPath(path)}`;
  assertXyWebApiReady(config);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${normalizedPath}`, {
      method: "POST",
      headers: {
        Authorization: config.authorization,
        "Content-Type": "application/json;charset=utf-8",
        Origin: dashboardOrigin,
        Referer: `${dashboardOrigin}/`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new XyWebApiError(`XY web API ${normalizedPath} timed out after ${config.timeoutMs}ms.`, {
        path: normalizedPath,
        status: 0,
        response: { code: "timeout", message: `Timed out after ${config.timeoutMs}ms` },
      });
    }
    throw new XyWebApiError(
      `XY web API ${normalizedPath} could not be reached: ${error instanceof Error ? error.message : String(error ?? "Unknown error")}`,
      { path: normalizedPath, status: 0 },
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let json: XyWebApiResponse<T>;
  try {
    json = text ? (JSON.parse(text) as XyWebApiResponse<T>) : {};
  } catch {
    throw new XyWebApiError(`XY web API ${normalizedPath} returned a non-JSON response.`, {
      path: normalizedPath,
      status: response.status,
      response: { code: response.status, message: text.slice(0, 300) },
      responseText: text,
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new XyWebApiError("XY web session token may be expired. Copy a fresh Authorization token from the VMS dashboard.", {
      path: normalizedPath,
      status: response.status,
      response: json,
      responseText: text,
    });
  }

  const message = responseMessage(json);
  const code = responseCode(json);
  if (!response.ok) {
    throw new XyWebApiError(
      `XY web API ${normalizedPath} failed with HTTP ${response.status}${message ? `: ${message}` : "."}`,
      {
        path: normalizedPath,
        status: response.status,
        response: json,
        responseText: text,
      },
    );
  }

  if (looksLikeSessionFailure(code, message)) {
    throw new XyWebApiError("XY web session token may be expired. Copy a fresh Authorization token from the VMS dashboard.", {
      path: normalizedPath,
      status: response.status,
      response: json,
      responseText: text,
    });
  }

  if (json.success === false || isFailureCode(code)) {
    throw new XyWebApiError(`XY web API ${normalizedPath} returned ${code ? `code ${code}` : "an error"}${message ? `: ${message}` : "."}`, {
      path: normalizedPath,
      status: response.status,
      response: json,
      responseText: text,
    });
  }

  return {
    path: normalizedPath,
    httpStatus: response.status,
    ok: response.ok,
    response: json,
    responseText: text,
    message,
  };
}
