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

export type PurchaseListScheduledDemandRow = {
  product_id: string | null;
  site_name: string;
  observed_operating_days: number;
  coverage_operating_days: number;
  observed_units: number;
  projected_units: number;
  daily_rate: number;
  previous_period_units?: number | string | null;
  current_period_units?: number | string | null;
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
  baseDemandDailyRate: number;
  scheduledSiteProjectedUnits: number;
  scheduledSiteDailyRate: number;
  scheduledSiteNames: string[];
  scheduledSiteObservedOperatingDays: number;
  scheduledSiteCoverageOperatingDays: number;
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
  scheduledDemandRows?: PurchaseListScheduledDemandRow[];
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

  const scheduledDemandByProduct = new Map<string, {
    projectedUnits: number;
    dailyRate: number;
    siteNames: Set<string>;
    observedOperatingDays: number;
    coverageOperatingDays: number;
    previousPeriodUnits: number;
    currentPeriodUnits: number;
  }>();
  (input.scheduledDemandRows ?? []).forEach((row) => {
    const productId = String(row.product_id ?? "").trim();
    if (!productId) return;
    const current = scheduledDemandByProduct.get(productId) ?? {
      projectedUnits: 0,
      dailyRate: 0,
      siteNames: new Set<string>(),
      observedOperatingDays: 0,
      coverageOperatingDays: 0,
      previousPeriodUnits: 0,
      currentPeriodUnits: 0,
    };
    current.projectedUnits += whole(row.projected_units);
    current.dailyRate += Math.max(0, numberValue(row.daily_rate));
    if (row.site_name) current.siteNames.add(row.site_name);
    current.observedOperatingDays = Math.max(current.observedOperatingDays, whole(row.observed_operating_days));
    current.coverageOperatingDays = Math.max(current.coverageOperatingDays, whole(row.coverage_operating_days));
    current.previousPeriodUnits += whole(row.previous_period_units);
    current.currentPeriodUnits += whole(row.current_period_units);
    scheduledDemandByProduct.set(productId, current);
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
      const scheduled = scheduledDemandByProduct.get(product.id);
      const scheduledSiteProjectedUnits = scheduled?.projectedUnits ?? 0;

      // Site-specific observed demand is removed from any overlapping aggregate
      // report before being projected back with the site's real operating days.
      // This prevents double-counting Elite once monthly reports catch up.
      const adjustedPreviousUnits = Math.max(0, previousMonthUnits - (scheduled?.previousPeriodUnits ?? 0));
      const adjustedCurrentUnits = Math.max(0, currentMonthUnits - (scheduled?.currentPeriodUnits ?? 0));

      // A product qualifies when it sold in a recent monthly report OR has
      // observed demand from a scheduled site such as Elite Future School.
      if (previousMonthUnits <= 0 && currentMonthUnits <= 0 && scheduledSiteProjectedUnits <= 0) return null;

      const previousDailyRate = previousDays > 0 ? adjustedPreviousUnits / previousDays : 0;
      const currentDailyRate = currentDays > 0 ? adjustedCurrentUnits / currentDays : 0;
      const baseDemandDailyRate = Math.max(previousDailyRate, currentDailyRate);
      const demandDailyRate = baseDemandDailyRate + scheduledSiteProjectedUnits / coverageTargetDays;
      const demandBasis = currentDailyRate >= previousDailyRate && currentDailyRate > 0 ? "current" : "previous";
      const storageQty = Math.max(0, numberValue(storageByProduct.get(product.id)));
      const targetStockQty = Math.ceil(baseDemandDailyRate * coverageTargetDays + scheduledSiteProjectedUnits);
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
        baseDemandDailyRate: rounded(baseDemandDailyRate),
        scheduledSiteProjectedUnits,
        scheduledSiteDailyRate: rounded(scheduled?.dailyRate ?? 0),
        scheduledSiteNames: Array.from(scheduled?.siteNames ?? []).sort(),
        scheduledSiteObservedOperatingDays: scheduled?.observedOperatingDays ?? 0,
        scheduledSiteCoverageOperatingDays: scheduled?.coverageOperatingDays ?? 0,
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
