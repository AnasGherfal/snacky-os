import "server-only";
import { buildXySign, callXyApi, getXyVmsConfig, normalizeXyApiResponse, type XyVmsParams } from "@/lib/xy-vms-api";

type JsonRecord = Record<string, unknown>;

export type XySlotState = {
  slotCode: string;
  vmsProductId: string | null;
  productName: string | null;
  priceLyd: number | null;
  currentQty: number | null;
  capacity: number | null;
};

function cleanParams(params: XyVmsParams) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "")),
  ) as Record<string, string | number | boolean>;
}

function rowsFromData(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === "object") as JsonRecord[];
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    for (const key of ["data", "rows", "list", "items", "records"]) {
      if (Array.isArray(record[key])) return rowsFromData(record[key]);
    }
  }
  return [];
}

function toMinorUnits(priceLyd: number) {
  return Math.round(priceLyd * 100);
}

export async function readXyMachineLayout(vmsMachineId: string): Promise<XySlotState[]> {
  const config = getXyVmsConfig();
  const response = await callXyApi<unknown>("queryMachineHdGoodPlus", {
    shbh: config.merchantId,
    jqbh: vmsMachineId,
  });

  return rowsFromData(response.data)
    .map((row) => {
      const rawPrice = Number(row.spjg ?? row.price ?? row.sellingPrice ?? 0);
      return {
        slotCode: String(row.hdbh ?? row.slotCode ?? "").trim(),
        vmsProductId: String(row.spbh ?? row.productId ?? "").trim() || null,
        productName: String(row.spmc ?? row.productName ?? "").trim() || null,
        priceLyd: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice / 100 : null,
        currentQty: Number.isFinite(Number(row.hdkc ?? row.currentQty)) ? Number(row.hdkc ?? row.currentQty) : null,
        capacity: Number.isFinite(Number(row.hdrl ?? row.capacity)) ? Number(row.hdrl ?? row.capacity) : null,
      } satisfies XySlotState;
    })
    .filter((row) => row.slotCode);
}

export async function setXySlotProduct(args: {
  vmsMachineId: string;
  slotCode: string;
  vmsProductId: string;
  priceLyd: number;
}) {
  const config = getXyVmsConfig();
  if (!config.ready) throw new Error(`XY VMS API is not ready: ${config.missing.join(", ")}.`);

  const businessParams = cleanParams({
    shbh: config.merchantId,
    jqbh: args.vmsMachineId,
    hdbh: args.slotCode,
    spbh: args.vmsProductId,
    spjg: toMinorUnits(args.priceLyd),
  });
  const timestamp = Date.now().toString().padStart(13, "0");
  const body = config.includeAuthFields
    ? {
        key: config.key,
        timestamp,
        sign: buildXySign(config.secret, timestamp, businessParams),
        ...businessParams,
      }
    : businessParams;

  const response = await fetch(`${config.baseUrl}/addInstructionByApi`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const responseText = await response.text();
  let parsed: JsonRecord = {};
  try {
    parsed = responseText ? normalizeXyApiResponse(JSON.parse(responseText)) as JsonRecord : {};
  } catch {
    parsed = { message: responseText.slice(0, 300) };
  }

  const nestedData = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data as JsonRecord : {};
  const code = parsed.code ?? parsed.status ?? parsed.statusCode ?? null;
  const message = String(parsed.message ?? parsed.msg ?? nestedData.msg ?? "").trim() || null;
  return {
    httpStatus: response.status,
    httpOk: response.ok,
    accepted: response.ok && String(code ?? "") === "1",
    code,
    message,
  };
}

export async function verifyXySlot(args: {
  vmsMachineId: string;
  slotCode: string;
  expectedVmsProductId: string;
  expectedPriceLyd: number;
}) {
  let lastState: XySlotState | null = null;
  for (const delayMs of [0, 800, 1600, 2600]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const layout = await readXyMachineLayout(args.vmsMachineId);
    lastState = layout.find((row) => row.slotCode === args.slotCode) ?? null;
    if (!lastState) continue;

    const productMatches = String(lastState.vmsProductId ?? "") === String(args.expectedVmsProductId);
    const priceMatches = lastState.priceLyd !== null && Math.abs(lastState.priceLyd - args.expectedPriceLyd) < 0.001;
    if (productMatches && priceMatches) return { verified: true, state: lastState };
  }
  return { verified: false, state: lastState };
}
