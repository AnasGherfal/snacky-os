export type PurchaseListProduct = {
  id: string;
  sku?: string | null;
  name: string;
  active?: boolean | null;
  last_purchase_cost_lyd?: number | string | null;
  current_cost_price_lyd?: number | string | null;
};

export type PurchaseListStorageRow = {
  product_id: string | null;
  quantity_on_hand?: number | string | null;
};

export type PurchaseListSalesRow = {
  product_id: string | null;
  month: "previous" | "current";
  units_sold?: number | string | null;
};

export type PurchaseListPeriod = {
  start: string;
  end: string;
  coveredDays: number;
  daysInMonth: number;
};

export type PurchaseListItem = {
  productId: string;
  sku: string | null;
  name: string;
  previousMonthUnits: number;
  currentMonthUnits: number;
  currentMonthProjectedUnits: number;
  previousDailyRate: number;
  currentDailyRate: number;
  demandDailyRate: number;
  storageQty: number;
  stockCoverageDays: number | null;
  coverageTargetDays: number;
  targetStockQty: number;
  suggestedBuyQty: number;
  lastPurchaseCost: number | null;
  estimatedBuyCost: number | null;
  demandBasis: "current" | "previous";
};

export type PurchaseListInput = {
  products: PurchaseListProduct[];
  storageRows?: PurchaseListStorageRow[];
  salesRows?: PurchaseListSalesRow[];
  previousPeriod?: PurchaseListPeriod | null;
  currentPeriod?: PurchaseListPeriod | null;
  coverageTargetDays: number;
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function whole(value: unknown) {
  return Math.max(0, Math.floor(numberValue(value)));
}

function moneyOrNull(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rounded(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function computePurchaseList(input: PurchaseListInput): PurchaseListItem[] {
  const coverageTargetDays = Math.max(1, Math.min(90, Math.floor(numberValue(input.coverageTargetDays) || 7)));
  const previousDays = Math.max(0, whole(input.previousPeriod?.coveredDays));
  const currentDays = Math.max(0, whole(input.currentPeriod?.coveredDays));
  const currentMonthDays = Math.max(currentDays, whole(input.currentPeriod?.daysInMonth));

  const storageByProduct = new Map<string, number>();
  (input.storageRows ?? []).forEach((row) => {
    const productId = String(row.product_id ?? "").trim();
    if (!productId) return;
    storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + Math.max(0, numberValue(row.quantity_on_hand)));
  });

  const previousSales = new Map<string, number>();
  const currentSales = new Map<string, number>();
  (input.salesRows ?? []).forEach((row) => {
    const productId = String(row.product_id ?? "").trim();
    if (!productId) return;
    const units = whole(row.units_sold);
    const map = row.month === "current" ? currentSales : previousSales;
    map.set(productId, (map.get(productId) ?? 0) + units);
  });

  return input.products
    .filter((product) => product.active !== false)
    .map((product): PurchaseListItem | null => {
      const previousMonthUnits = whole(previousSales.get(product.id));
      const currentMonthUnits = whole(currentSales.get(product.id));

      // A purchase recommendation is intentionally recent-demand only. Products
      // that sold months ago but not in the previous/current month are excluded.
      if (previousMonthUnits <= 0 && currentMonthUnits <= 0) return null;

      const previousDailyRate = previousDays > 0 ? previousMonthUnits / previousDays : 0;
      const currentDailyRate = currentDays > 0 ? currentMonthUnits / currentDays : 0;
      const demandDailyRate = Math.max(previousDailyRate, currentDailyRate);
      const demandBasis = currentDailyRate >= previousDailyRate && currentDailyRate > 0 ? "current" : "previous";
      const storageQty = Math.max(0, numberValue(storageByProduct.get(product.id)));
      const targetStockQty = Math.ceil(demandDailyRate * coverageTargetDays);
      const suggestedBuyQty = Math.max(0, Math.ceil(targetStockQty - storageQty));
      const stockCoverageDays = demandDailyRate > 0 ? rounded(storageQty / demandDailyRate, 1) : null;
      const currentMonthProjectedUnits = currentDailyRate > 0 && currentMonthDays > 0
        ? Math.ceil(currentDailyRate * currentMonthDays)
        : 0;
      const lastPurchaseCost = moneyOrNull(product.last_purchase_cost_lyd ?? product.current_cost_price_lyd);
      const estimatedBuyCost = lastPurchaseCost == null ? null : rounded(lastPurchaseCost * suggestedBuyQty, 2);

      return {
        productId: product.id,
        sku: product.sku ? String(product.sku) : null,
        name: product.name,
        previousMonthUnits,
        currentMonthUnits,
        currentMonthProjectedUnits,
        previousDailyRate: rounded(previousDailyRate),
        currentDailyRate: rounded(currentDailyRate),
        demandDailyRate: rounded(demandDailyRate),
        storageQty: rounded(storageQty, 1),
        stockCoverageDays,
        coverageTargetDays,
        targetStockQty,
        suggestedBuyQty,
        lastPurchaseCost,
        estimatedBuyCost,
        demandBasis,
      };
    })
    .filter((item): item is PurchaseListItem => Boolean(item))
    // Highest current demand first, exactly as a buying list should read.
    .sort((a, b) =>
      b.demandDailyRate - a.demandDailyRate ||
      b.currentMonthUnits - a.currentMonthUnits ||
      b.previousMonthUnits - a.previousMonthUnits ||
      a.name.localeCompare(b.name),
    );
}
