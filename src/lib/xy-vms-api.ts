import "server-only";
import crypto from "crypto";

export type XyVmsEndpoint =
  | "queryMachine"
  | "queryMachineState"
  | "queryMachineHdGoodPlus"
  | "queryGoodDetails";

export type XyVmsParamValue = string | number | boolean | null | undefined;
export type XyVmsParams = Record<string, XyVmsParamValue>;

export type XyApiResponse<T = unknown> = {
  code?: string | number;
  message?: string;
  data?: T;
  [key: string]: unknown;
};

export type XySigningMode = "signed" | "unsigned";

export type XyApiRawResult<T = unknown> = {
  endpoint: XyVmsEndpoint;
  httpStatus: number;
  ok: boolean;
  response: XyApiResponse<T>;
  responseText: string;
  requestSigned: boolean;
};

export type XyVmsConfig = {
  enabled: boolean;
  baseUrl: string;
  merchantId: string;
  key: string;
  secret: string;
  timeoutMs: number;
  signingMode: XySigningMode;
  includeAuthFields: boolean;
  maskedMerchantId: string;
  maskedKey: string;
  ready: boolean;
  missing: string[];
};

export class XyApiError extends Error {
  endpoint: string;
  code?: string | number;
  status?: number;
  response?: XyApiResponse;

  constructor(message: string, options: { endpoint: string; code?: string | number; status?: number; response?: XyApiResponse }) {
    super(message);
    this.name = "XyApiError";
    this.endpoint = options.endpoint;
    this.code = options.code;
    this.status = options.status;
    this.response = options.response;
  }
}

const defaultBaseUrl = "http://175.6.71.238:8090/service-api/api";

function envFlag(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envNumber(value: string | undefined, defaultValue: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function cleanEndpoint(endpoint: string) {
  return endpoint.replace(/^\/+/, "");
}

function cleanBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function cleanParams(params: XyVmsParams) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
  ) as Record<string, string | number | boolean>;
}

function reqData(params: XyVmsParams) {
  return Object.entries(cleanParams(params))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

function timestamp13() {
  return Date.now().toString().padStart(13, "0");
}

export function maskSecret(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "Not set";
  if (text.length <= 4) return "*".repeat(text.length);
  if (text.length <= 8) return `${text.slice(0, 2)}${"*".repeat(text.length - 4)}${text.slice(-2)}`;
  return `${text.slice(0, 3)}${"*".repeat(Math.max(3, text.length - 6))}${text.slice(-3)}`;
}

export function buildXySign(secret: string, timestamp: string | number, params: XyVmsParams) {
  return crypto
    .createHash("md5")
    .update(`${secret}${String(timestamp)}${reqData(params)}`, "utf8")
    .digest("hex");
}

export function getXyVmsConfig(): XyVmsConfig {
  const signingMode = String(process.env.XY_VMS_SIGNING_MODE ?? "signed").trim().toLowerCase() === "unsigned" ? "unsigned" : "signed";
  const baseUrl = cleanBaseUrl(process.env.XY_VMS_BASE_URL || defaultBaseUrl);
  const merchantId = String(process.env.XY_VMS_MERCHANT_ID ?? "").trim();
  const key = String(process.env.XY_VMS_KEY ?? "").trim();
  const secret = String(process.env.XY_VMS_SECRET ?? "").trim();
  const timeoutMs = envNumber(process.env.XY_VMS_TIMEOUT_MS, 30000);
  const enabled = envFlag(process.env.XY_VMS_ENABLED, false);
  const includeAuthFields = signingMode === "signed";
  const missing = [
    enabled ? "" : "XY_VMS_ENABLED=true",
    baseUrl ? "" : "XY_VMS_BASE_URL",
    merchantId ? "" : "XY_VMS_MERCHANT_ID",
    includeAuthFields && !key ? "XY_VMS_KEY" : "",
    includeAuthFields && !secret ? "XY_VMS_SECRET" : "",
  ].filter(Boolean);

  return {
    enabled,
    baseUrl,
    merchantId,
    key,
    secret,
    timeoutMs,
    signingMode,
    includeAuthFields,
    maskedMerchantId: maskSecret(merchantId),
    maskedKey: maskSecret(key),
    ready: missing.length === 0,
    missing,
  };
}

export function assertXyVmsReady(config = getXyVmsConfig()) {
  if (config.ready) return;
  throw new Error(`XY VMS API is not ready: ${config.missing.join(", ")}.`);
}

export async function callXyApiRaw<T = unknown>(
  endpoint: XyVmsEndpoint,
  params: XyVmsParams,
  options: { signingMode?: XySigningMode } = {},
): Promise<XyApiRawResult<T>> {
  const config = getXyVmsConfig();
  const signingMode = options.signingMode ?? config.signingMode;
  const includeAuthFields = signingMode === "signed";
  const missing = [
    config.enabled ? "" : "XY_VMS_ENABLED=true",
    config.baseUrl ? "" : "XY_VMS_BASE_URL",
    config.merchantId ? "" : "XY_VMS_MERCHANT_ID",
    includeAuthFields && !config.key ? "XY_VMS_KEY" : "",
    includeAuthFields && !config.secret ? "XY_VMS_SECRET" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`XY VMS API is not ready: ${missing.join(", ")}.`);
  }

  const businessParams = cleanParams(params);
  const timestamp = timestamp13();
  const body: Record<string, string | number | boolean> = { ...businessParams };

  if (includeAuthFields) {
    body.key = config.key;
    body.secret = config.secret;
    body.timestamp = timestamp;
    body.sign = buildXySign(config.secret, timestamp, businessParams);
  }

  const cleanPath = cleanEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/${cleanPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new XyApiError(`XY ${endpoint} timed out after ${config.timeoutMs}ms.`, {
        endpoint,
        status: 0,
        response: { code: "timeout", message: `Timed out after ${config.timeoutMs}ms` },
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let json: XyApiResponse<T>;
  try {
    json = text ? (JSON.parse(text) as XyApiResponse<T>) : {};
  } catch {
    throw new XyApiError(`XY ${endpoint} returned a non-JSON response.`, {
      endpoint,
      status: response.status,
      response: { code: response.status, message: text.slice(0, 300) },
    });
  }

  return {
    endpoint,
    httpStatus: response.status,
    ok: response.ok,
    response: json,
    responseText: text,
    requestSigned: includeAuthFields,
  };
}

export async function callXyApi<T = unknown>(endpoint: XyVmsEndpoint, params: XyVmsParams): Promise<XyApiResponse<T>> {
  const result = await callXyApiRaw<T>(endpoint, params);
  const { response, httpStatus } = result;

  if (!result.ok) {
    throw new XyApiError(`XY ${endpoint} failed with HTTP ${httpStatus}.`, {
      endpoint,
      status: httpStatus,
      response,
    });
  }

  if (String(response.code ?? "") !== "1") {
    throw new XyApiError(String(response.message ?? `XY ${endpoint} returned code ${response.code ?? "unknown"}.`), {
      endpoint,
      code: response.code,
      status: httpStatus,
      response,
    });
  }

  return response;
}
