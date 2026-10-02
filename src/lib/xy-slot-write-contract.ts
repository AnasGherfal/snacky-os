export const XY_SLOT_PRODUCT_WRITE_ENDPOINT = "addInstructionSpxxByApi" as const;
export const XY_SLOT_PRODUCT_WRITE_FIELDS = ["shbh","jqbh","hdbh","spbh","spjg","kcsl"] as const;

export type XySlotProductWriteInput = {
  merchantId: string;
  vmsMachineId: string;
  slotCode: string;
  vmsProductId: string;
  priceLyd: number;
  stockQty: number;
};

function requiredText(value: unknown, label: string) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw new Error(`XY slot write requires ${label}.`);
  return cleaned;
}

export function buildXySlotProductWriteParams(input: XySlotProductWriteInput) {
  const priceLyd = Number(input.priceLyd);
  if (!Number.isFinite(priceLyd) || priceLyd <= 0) {
    throw new Error("XY slot write requires a positive selling price.");
  }
  if (input.stockQty === null || input.stockQty === undefined) {
    throw new Error("XY slot write requires the current lane stock quantity.");
  }
  const stockQty = Number(input.stockQty);
  if (!Number.isSafeInteger(stockQty) || stockQty < 0) {
    throw new Error("XY slot write requires a non-negative whole lane stock quantity.");
  }

  return {
    shbh: requiredText(input.merchantId, "merchant id"),
    jqbh: requiredText(input.vmsMachineId, "machine id"),
    hdbh: requiredText(input.slotCode, "slot code"),
    spbh: requiredText(input.vmsProductId, "product id"),
    spjg: Math.round(priceLyd * 100),
    kcsl: stockQty,
  };
}
