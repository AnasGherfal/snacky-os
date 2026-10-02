import { NextResponse } from "next/server";
import { buildXySign, getXyVmsConfig } from "@/lib/xy-vms-api";
import { buildXySlotProductWriteParams, XY_SLOT_PRODUCT_WRITE_ENDPOINT } from "@/lib/xy-slot-write-contract";

type JsonRecord = Record<string, unknown>;

async function probe(path: string) {
  const config = getXyVmsConfig();
  const timestamp = Date.now().toString().padStart(13, "0");
  const businessParams = buildXySlotProductWriteParams({
    merchantId: config.merchantId,
    vmsMachineId: "SNACKY_CONTRACT_PROBE_INVALID_MACHINE",
    slotCode: "SNACKY_PROBE_INVALID_SLOT",
    vmsProductId: "SNACKY_PROBE_INVALID_PRODUCT",
    productName: "SNACKY CONTRACT PROBE",
    priceLyd: 0.01,
  });
  const body = config.includeAuthFields
    ? {
        key: config.key,
        timestamp,
        sign: buildXySign(config.secret, timestamp, businessParams),
        ...businessParams,
      }
    : businessParams;
  const serviceRoot = config.baseUrl.replace(/\/api\/?$/, "");
  const response = await fetch(`${serviceRoot}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let parsed: JsonRecord = {};
  try { parsed = text ? JSON.parse(text) as JsonRecord : {}; }
  catch { parsed = { message: text.slice(0, 300) }; }
  return {
    path,
    status: response.status,
    code: parsed.code ?? parsed.status ?? null,
    message: parsed.message ?? parsed.msg ?? parsed.error ?? null,
    keys: Object.keys(parsed).slice(0, 20),
    dataSummary: typeof parsed.data === "string"
      ? parsed.data.slice(0, 500)
      : parsed.data && typeof parsed.data === "object"
        ? JSON.stringify(parsed.data).slice(0, 500)
        : null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("probe") !== "xywrite-contract-20260930") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const config = getXyVmsConfig();
  if (!config.ready) {
    return NextResponse.json({ error: "XY VMS not ready", missing: config.missing }, { status: 503 });
  }

  const results = [];
  for (const path of [`/api/${XY_SLOT_PRODUCT_WRITE_ENDPOINT}`]) {
    try { results.push(await probe(path)); }
    catch (error) {
      results.push({
        path,
        status: 0,
        code: null,
        message: error instanceof Error ? error.message : String(error),
        keys: [],
      });
    }
  }
  return NextResponse.json({ results });
}
