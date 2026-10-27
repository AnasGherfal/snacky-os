import { NextResponse } from "next/server";
import { buildXySign, getXyVmsConfig, normalizeXyApiResponse } from "@/lib/xy-vms-api";

type Params = Record<string, string | number | boolean>;

const TOKEN = "xy-clear-slot-contract-v2-20260930";
const FAKE_MACHINE = "SNACKY_FAKE_CLEAR_SLOT_V2";
const ENDPOINT = "/api/v2/soldOutMachineGoods";

function clean(params: Params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => String(value ?? "").trim() !== ""),
  ) as Params;
}

async function call(params: Params) {
  const config = getXyVmsConfig();
  const timestamp = Date.now().toString().padStart(13, "0");
  const businessParams = clean(params);
  const body = config.includeAuthFields
    ? {
        key: config.key,
        timestamp,
        sign: buildXySign(config.secret, timestamp, businessParams),
        ...businessParams,
      }
    : businessParams;

  const serviceRoot = config.baseUrl.replace(/\/api\/?$/, "");
  const response = await fetch(`${serviceRoot}${ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const responseText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = responseText
      ? normalizeXyApiResponse(JSON.parse(responseText)) as Record<string, unknown>
      : {};
  } catch {
    parsed = { raw: responseText.slice(0, 500) };
  }

  const nested = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : {};

  return {
    request: businessParams,
    httpStatus: response.status,
    httpOk: response.ok,
    code: parsed.code ?? parsed.status ?? parsed.statusCode ?? nested.code ?? null,
    message: String(parsed.message ?? parsed.msg ?? nested.message ?? nested.msg ?? "").trim() || null,
    keys: Object.keys(parsed).filter((key) => key !== "rawEnvelope").slice(0, 30),
    data: parsed.data ?? null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const config = getXyVmsConfig();
  if (!config.ready) {
    return NextResponse.json({ error: "XY not ready", missing: config.missing }, { status: 503 });
  }

  // Every request is hard-coded to an impossible Snacky machine ID. This endpoint
  // is contract discovery only and cannot target a real vending machine.
  const base = { shbh: config.merchantId, jqbh: FAKE_MACHINE };
  const candidates: Array<{ label: string; params: Params }> = [
    { label: "slot_only", params: { ...base, hdbh: "000" } },
    { label: "slot_product", params: { ...base, hdbh: "000", spbh: "0001" } },
    { label: "product_only", params: { ...base, spbh: "0001" } },
    { label: "slot_alt_product_key", params: { ...base, hdbh: "000", dsfspbh: "0001" } },
    { label: "slot_product_zero_sl", params: { ...base, hdbh: "000", spbh: "0001", sl: 0 } },
    { label: "slot_product_zero_num", params: { ...base, hdbh: "000", spbh: "0001", num: 0 } },
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    try {
      results.push({ label: candidate.label, ...(await call(candidate.params)) });
    } catch (error) {
      results.push({
        label: candidate.label,
        request: candidate.params,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({
    endpoint: ENDPOINT,
    fakeMachine: FAKE_MACHINE,
    safety: "No real Snacky machine identifier is accepted by this probe.",
    results,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
