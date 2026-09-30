import { NextResponse } from "next/server";
import { buildXySign, getXyVmsConfig, normalizeXyApiResponse } from "@/lib/xy-vms-api";

type Params = Record<string, string | number | boolean>;

const PROBE_TOKEN = "xy-write-schema-probe-20260930";
const FAKE_MACHINE = "SNACKY_SCHEMA_PROBE_DO_NOT_EXIST";

async function call(endpoint: string, params: Params) {
  const config = getXyVmsConfig();
  const timestamp = Date.now().toString().padStart(13, "0");
  const businessParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => String(value ?? "").trim() !== ""),
  ) as Params;
  const body = config.includeAuthFields
    ? {
        key: config.key,
        timestamp,
        sign: buildXySign(config.secret, timestamp, businessParams),
        ...businessParams,
      }
    : businessParams;

  const response = await fetch(`${config.baseUrl}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = normalizeXyApiResponse(JSON.parse(text)) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return {
    endpoint,
    requestKeys: Object.keys(businessParams),
    httpStatus: response.status,
    response: {
      code: parsed.code ?? parsed.status ?? parsed.statusCode ?? null,
      message: parsed.message ?? parsed.msg ?? parsed.error ?? null,
      data: parsed.data ?? null,
      keys: Object.keys(parsed).filter((key) => key !== "rawEnvelope").slice(0, 20),
    },
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== PROBE_TOKEN) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const config = getXyVmsConfig();
  if (!config.ready) {
    return NextResponse.json({ error: "XY VMS not ready", missing: config.missing }, { status: 503 });
  }

  const base = {
    shbh: config.merchantId,
    jqbh: FAKE_MACHINE,
    hdbh: "000",
  };

  const probes = [
    ["addInstructionSpxxByApi", { ...base, spjg: 500 }],
    ["addInstructionSpxxByApi", { ...base, spbh: "0001", spjg: 500 }],
    ["addInstructionSpxxByApi", { ...base, spbh: "0001", spmc: "Schema probe", spjg: 500 }],
    ["addInstructionByApi", { ...base, spbh: "0001", spjg: 500 }],
    ["addInstructionByApi", { ...base, spbh: "0001", spmc: "Schema probe", spjg: 500 }],
    ["addInstructionByApi", { ...base, oldspbh: "0000", spbh: "0001", spjg: 500 }],
  ] as const;

  const results = [];
  for (const [endpoint, params] of probes) {
    try {
      results.push(await call(endpoint, params));
    } catch (error) {
      results.push({
        endpoint,
        requestKeys: Object.keys(params),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({
    fakeMachine: FAKE_MACHINE,
    results,
  });
}
