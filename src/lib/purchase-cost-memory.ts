export type ProductCostMemory = {
  name?: string | null;
  costPrice?: number | string | null;
  cost_price?: number | string | null;
  currentCostPrice?: number | string | null;
  current_cost_price_lyd?: number | string | null;
  lastPurchaseCost?: number | string | null;
  last_purchase_cost_lyd?: number | string | null;
  last_purchase_unit_cost?: number | string | null;
  last_purchase_unit_cost_lyd?: number | string | null;
  latest_unit_cost?: number | string | null;
  default_unit_cost?: number | string | null;
  averageCost?: number | string | null;
  average_cost_lyd?: number | string | null;
};

export type PurchaseUnitCostDecision =
  | { kind: "entered"; unitCost: number }
  | { kind: "derived_total"; unitCost: number }
  | { kind: "product_memory"; unitCost: number }
  | { kind: "confirmed_zero"; unitCost: 0 }
  | { kind: "missing"; unitCost: null; message: string }
  | { kind: "zero_unconfirmed"; unitCost: null; message: string };

function positiveNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonnegativeNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function roundUnitCost(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function latestKnownProductUnitCost(product: ProductCostMemory | null | undefined) {
  if (!product) return null;
  const candidates = [
    product.lastPurchaseCost,
    product.last_purchase_cost_lyd,
    product.last_purchase_unit_cost,
    product.last_purchase_unit_cost_lyd,
    product.latest_unit_cost,
    product.default_unit_cost,
    product.currentCostPrice,
    product.current_cost_price_lyd,
    product.costPrice,
    product.cost_price,
    product.averageCost,
    product.average_cost_lyd,
  ];
  for (const value of candidates) {
    const cost = positiveNumber(value);
    if (cost !== null) return roundUnitCost(cost);
  }
  return null;
}

export function resolvePurchaseUnitCost({
  product,
  productName,
  unitCost,
  unitCostBlank,
  unitCostZeroConfirmed,
  pricingMode,
  lineTotal,
  totalUnits,
}: {
  product?: ProductCostMemory | null;
  productName?: string | null;
  unitCost: number | string | null | undefined;
  unitCostBlank: boolean;
  unitCostZeroConfirmed: boolean;
  pricingMode: "unit" | "total";
  lineTotal: number | string | null | undefined;
  totalUnits: number;
}): PurchaseUnitCostDecision {
  const label = String(productName || product?.name || "this product").trim() || "this product";
  const units = Math.max(0, Math.floor(Number(totalUnits || 0)));
  const enteredUnitCost = nonnegativeNumber(unitCost);
  const enteredLineTotal = nonnegativeNumber(lineTotal);

  if (pricingMode === "total" && enteredLineTotal > 0 && units > 0) {
    return { kind: "derived_total", unitCost: roundUnitCost(enteredLineTotal / units) };
  }

  if (enteredUnitCost > 0) {
    return { kind: "entered", unitCost: roundUnitCost(enteredUnitCost) };
  }

  const rememberedCost = latestKnownProductUnitCost(product);
  if (unitCostBlank && rememberedCost !== null) {
    return { kind: "product_memory", unitCost: rememberedCost };
  }

  if (unitCostZeroConfirmed) {
    return { kind: "confirmed_zero", unitCost: 0 };
  }

  if (unitCostBlank) {
    return {
      kind: "missing",
      unitCost: null,
      message: `Unit cost is required for ${label} because no previous cost exists.`,
    };
  }

  return {
    kind: "zero_unconfirmed",
    unitCost: null,
    message: `Unit cost is 0 for ${label}. Confirm this product is free before saving.`,
  };
}
