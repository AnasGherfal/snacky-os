import crypto from "crypto";

export type XyProtocolParamValue = string | number | boolean | null | undefined;
export type XyProtocolParams = Record<string, XyProtocolParamValue>;

export type XyProtocolResponse<T = unknown> = {
  code?: string | number;
  message?: string;
  data?: T;
  rawEnvelope?: unknown;
  [key: string]: unknown;
};

const signingFields = new Set(["key", "secret", "timestamp", "sign"]);

function cleanBusinessParams(params: XyProtocolParams) {
  return Object.fromEntries(
    Object.entries(params).filter(([key, value]) => {
      if (signingFields.has(key)) return false;
      if (value === undefined || value === null) return false;
      return !(typeof value === "string" && value.trim() === "");
    }),
  ) as Record<string, string | number | boolean>;
}

export function buildXyReqData(params: XyProtocolParams) {
  return Object.entries(cleanBusinessParams(params))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function buildXySign(secret: string, timestamp: string | number, params: XyProtocolParams) {
  return crypto
    .createHash("md5")
    .update(`${secret}${String(timestamp)}${buildXyReqData(params)}`, "utf8")
    .digest("hex");
}

export function normalizeXyApiResponse<T = unknown>(value: XyProtocolResponse): XyProtocolResponse<T> {
  const nested = value.data;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return value as XyProtocolResponse<T>;
  if (!("code" in nested || "message" in nested || "data" in nested)) return value as XyProtocolResponse<T>;

  return {
    ...(nested as XyProtocolResponse<T>),
    rawEnvelope: value,
  };
}
