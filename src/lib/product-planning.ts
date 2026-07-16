import { normalizeCaseQuantity, roundUnitsUpToCase } from "@/lib/product-quantity";

export type ProductPlanningAction = "testing" | "increase" | "keep" | "reduce" | "remove" | "review";

export type ProductPlanningSalesMonth = {
  month: string;
  units: number;
  revenue: number;
  grossProfit: number | null;
};

export type ProductPlanningInput = {
  productId: string;
  productName: string;
  category?: string | null;
  createdAt?: string | null;
  caseQuantity?: number | string | null;
  currentStorageUnits?: number | string | null;
  activeMachineCount?: number | string | null;
  unitCost?: number | string | null;
  salesMonths?: ProductPlanningSalesMonth[];
  currentMonthObservedDays?: number | string | null;
  currentMonthSalesThrough?: string | null;
  purchasedUnitsThisMonth?: number | string | null;
  purchasedSpendThisMonth?: number | string | null;
};

export type ProductPlanningRecommendation = {
  action: ProductPlanningAction;
  actionLabel: string;
  reasons: string[];
  isNewProduct: boolean;
  reviewAfter: string | null;
  currentMonthDataAvailable: boolean;
  currentMonthSalesThrough: string | null;
  currentMonthObservedDays: number;
  currentMonthDaysInMonth: number;
  currentMonthUnits: number;
  currentMonthRevenue: number;
  currentMonthGrossProfit: number | null;
  projectedCurrentMonthUnits: number;
  remainingProjectedDemandUnits: number;
  previousMonthUnits: number;
  priorMonthUnits: number;
  previousMonthRevenue: number;
  previousMonthGrossProfit: number | null;
  trendRate: number | null;
  minimumStockUnits: number;
  targetStockUnits: number;
  suggestedBuyUnits: number;
  recommendedPlanUnits: number;
  recommendedBudgetLyd: number | null;
  purchasedUnitsThisMonth: number;
  purchasedSpendThisMonth: number;
  remainingPlannedUnits: number;
  remainingBudgetLyd: number | null;
};

function numeric(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function wholeNumber(value: unknown, fallback = 0) {
  return Math.max(0, Math.floor(numeric(value, fallback)));
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function firstOfMonth(value: string | Date) {
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function shiftPlanningMonth(month: string, offset: number) {
  const date = firstOfMonth(month);
  return monthKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 86_400_000);
}

function daysBetween(later: Date, earlier: Date) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

function daysInMonth(month: string) {
  const start = firstOfMonth(month);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
}

function actionLabel(action: ProductPlanningAction) {
  switch (action) {
    case "testing": return "New product — keep testing";
    case "increase": return "Increase / keep buying";
    case "keep": return "Keep buying";
    case "reduce": return "Reduce buying";
    case "remove": return "Consider removing";
    case "review": return "Review cost or selling price";
  }
}

function monthRow(rows: ProductPlanningSalesMonth[], month: string) {
  return rows.find((row) => String(row.month).slice(0, 7) === month.slice(0, 7)) ?? null;
}

function projectCurrentMonthDemand({
  currentUnits,
  observedDays,
  totalDays,
  previousMonthUnits,
}: {
  currentUnits: number;
  observedDays: number;
  totalDays: number;
  previousMonthUnits: number;
}) {
  if (observedDays <= 0) return Math.max(currentUnits, previousMonthUnits);
  if (observedDays >= totalDays) return currentUnits;

  const runRateProjection = (currentUnits / observedDays) * totalDays;
  if (previousMonthUnits <= 0) return Math.max(currentUnits, Math.ceil(runRateProjection));

  // Early-month sales can be noisy. Blend the run rate into last month's baseline
  // until two weeks of current-month coverage are available.
  const currentRunRateWeight = Math.min(1, observedDays / 14);
  const blendedProjection = previousMonthUnits * (1 - currentRunRateWeight) + runRateProjection * currentRunRateWeight;
  return Math.max(currentUnits, Math.ceil(blendedProjection));
}

export function buildProductPlanningRecommendation(
  input: ProductPlanningInput,
  planningMonth: string,
): ProductPlanningRecommendation {
  const monthStart = firstOfMonth(planningMonth);
  const previousMonth = shiftPlanningMonth(planningMonth, -1);
  const priorMonth = shiftPlanningMonth(planningMonth, -2);
  const salesMonths = input.salesMonths ?? [];
  const current = monthRow(salesMonths, planningMonth);
  const previous = monthRow(salesMonths, previousMonth);
  const prior = monthRow(salesMonths, priorMonth);

  const currentMonthUnits = wholeNumber(current?.units);
  const currentMonthRevenue = Math.max(0, numeric(current?.revenue));
  const currentMonthGrossProfit = current?.grossProfit === null || current?.grossProfit === undefined
    ? null
    : numeric(current.grossProfit);
  const previousMonthUnits = wholeNumber(previous?.units);
  const priorMonthUnits = wholeNumber(prior?.units);
  const previousMonthRevenue = Math.max(0, numeric(previous?.revenue));
  const previousMonthGrossProfit = previous?.grossProfit === null || previous?.grossProfit === undefined
    ? null
    : numeric(previous.grossProfit);

  const currentMonthDaysInMonth = daysInMonth(planningMonth);
  const currentMonthObservedDays = Math.min(currentMonthDaysInMonth, wholeNumber(input.currentMonthObservedDays));
  const currentMonthDataAvailable = currentMonthObservedDays > 0 || Boolean(current);
  const currentMonthSalesThrough = currentMonthDataAvailable && input.currentMonthSalesThrough
    ? String(input.currentMonthSalesThrough).slice(0, 10)
    : null;
  const projectedCurrentMonthUnits = currentMonthDataAvailable
    ? projectCurrentMonthDemand({
        currentUnits: currentMonthUnits,
        observedDays: currentMonthObservedDays,
        totalDays: currentMonthDaysInMonth,
        previousMonthUnits,
      })
    : previousMonthUnits;
  const remainingProjectedDemandUnits = Math.max(0, projectedCurrentMonthUnits - currentMonthUnits);

  const caseQuantity = normalizeCaseQuantity(input.caseQuantity);
  const currentStorageUnits = wholeNumber(input.currentStorageUnits);
  const activeMachineCount = wholeNumber(input.activeMachineCount);
  const unitCost = numeric(input.unitCost, NaN);
  const purchasedUnitsThisMonth = wholeNumber(input.purchasedUnitsThisMonth);
  const purchasedSpendThisMonth = Math.max(0, numeric(input.purchasedSpendThisMonth));

  const createdAt = input.createdAt ? new Date(input.createdAt) : null;
  const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null;
  const ageDaysAtMonthStart = validCreatedAt ? daysBetween(monthStart, validCreatedAt) : 9999;
  const firstSaleMonth = [...salesMonths]
    .filter((row) => wholeNumber(row.units) > 0)
    .map((row) => String(row.month).slice(0, 10))
    .sort()[0] ?? null;
  const firstSaleDate = firstSaleMonth ? firstOfMonth(firstSaleMonth) : null;
  const firstSaleAgeDays = firstSaleDate ? daysBetween(monthStart, firstSaleDate) : 9999;
  const isNewProduct = ageDaysAtMonthStart < 60 || firstSaleAgeDays < 60;
  const reviewAfter = isNewProduct
    ? addDays(validCreatedAt ?? firstSaleDate ?? monthStart, 60).toISOString().slice(0, 10)
    : null;

  const trendRate = currentMonthDataAvailable
    ? previousMonthUnits > 0
      ? (projectedCurrentMonthUnits - previousMonthUnits) / previousMonthUnits
      : projectedCurrentMonthUnits > 0 ? 1 : null
    : priorMonthUnits > 0
      ? (previousMonthUnits - priorMonthUnits) / priorMonthUnits
      : null;

  const minimumStockUnits = isNewProduct
    ? Math.max(caseQuantity, remainingProjectedDemandUnits)
    : remainingProjectedDemandUnits;

  let safetyMultiplier = 1;
  if (trendRate !== null && trendRate >= 0.25) safetyMultiplier = 1.2;
  else if (projectedCurrentMonthUnits >= caseQuantity * 4 || activeMachineCount >= 4) safetyMultiplier = 1.15;

  const targetStockUnits = roundUnitsUpToCase(Math.ceil(minimumStockUnits * safetyMultiplier), caseQuantity);
  const rawSuggestedBuyUnits = Math.max(0, targetStockUnits - currentStorageUnits);
  // Supplier purchasing is normally case-based, so the actionable buy quantity is
  // rounded to complete boxes while the inventory ledger remains unit-based.
  const suggestedBuyUnits = rawSuggestedBuyUnits > 0
    ? roundUnitsUpToCase(rawSuggestedBuyUnits, caseQuantity)
    : 0;
  const recommendedPlanUnits = purchasedUnitsThisMonth + suggestedBuyUnits;
  const remainingPlannedUnits = suggestedBuyUnits;
  const remainingBudgetLyd = Number.isFinite(unitCost) && unitCost > 0
    ? roundMoney(remainingPlannedUnits * unitCost)
    : remainingPlannedUnits === 0 ? 0 : null;
  const recommendedBudgetLyd = remainingBudgetLyd === null
    ? null
    : roundMoney(purchasedSpendThisMonth + remainingBudgetLyd);

  const reasons: string[] = [];
  let action: ProductPlanningAction;

  if (isNewProduct) {
    action = "testing";
    reasons.push(`Protected as a new product until ${reviewAfter}`);
    reasons.push(`Start with at least ${caseQuantity} unit${caseQuantity === 1 ? "" : "s"} (${caseQuantity > 1 ? "one box" : "one test unit"})`);
  } else if (
    !Number.isFinite(unitCost)
    || unitCost <= 0
    || (previousMonthGrossProfit !== null && previousMonthGrossProfit < 0)
    || (currentMonthGrossProfit !== null && currentMonthGrossProfit < 0)
  ) {
    action = "review";
    if (!Number.isFinite(unitCost) || unitCost <= 0) reasons.push("Purchase cost is missing");
    if (previousMonthGrossProfit !== null && previousMonthGrossProfit < 0) reasons.push("Previous month gross profit was negative");
    if (currentMonthGrossProfit !== null && currentMonthGrossProfit < 0) reasons.push("Current month gross profit is negative");
  } else if (
    previousMonthUnits === 0
    && priorMonthUnits === 0
    && (!currentMonthDataAvailable || currentMonthUnits === 0)
  ) {
    action = "remove";
    reasons.push("No sales in the previous two completed months or the current uploaded period");
    if (currentStorageUnits > 0) reasons.push(`${currentStorageUnits} unit(s) are still in storage`);
    if (activeMachineCount > 0) reasons.push(`Still assigned to ${activeMachineCount} machine(s)`);
  } else if (
    (trendRate !== null && trendRate <= -0.4)
    || (projectedCurrentMonthUnits > 0 && currentStorageUnits > projectedCurrentMonthUnits * 2.5)
  ) {
    action = "reduce";
    if (trendRate !== null && trendRate <= -0.4) reasons.push(`Projected sales are down ${Math.abs(trendRate * 100).toFixed(0)}% versus the comparison month`);
    if (projectedCurrentMonthUnits > 0 && currentStorageUnits > projectedCurrentMonthUnits * 2.5) reasons.push("More than 2.5 projected months of demand remains in storage");
  } else if (
    (trendRate !== null && trendRate >= 0.25)
    || (remainingProjectedDemandUnits > 0 && currentStorageUnits < remainingProjectedDemandUnits * 0.5)
  ) {
    action = "increase";
    if (trendRate !== null && trendRate >= 0.25) reasons.push(`Projected sales are up ${(trendRate * 100).toFixed(0)}% versus the comparison month`);
    if (remainingProjectedDemandUnits > 0 && currentStorageUnits < remainingProjectedDemandUnits * 0.5) reasons.push("Current storage is below half of projected remaining demand");
  } else {
    action = "keep";
    reasons.push(currentMonthDataAvailable ? "Current-month sales support continuing this product" : "Product sold during the previous completed month");
  }

  if (currentMonthDataAvailable) {
    const coverageLabel = currentMonthSalesThrough ? ` through ${currentMonthSalesThrough}` : "";
    reasons.push(`${currentMonthUnits} unit(s) sold${coverageLabel}; ${projectedCurrentMonthUnits} projected for the full month`);
  } else {
    reasons.push("No current-month VMS coverage yet; using the previous completed month as the demand baseline");
  }

  if (minimumStockUnits > 0) reasons.push(`Projected demand still remaining this month: ${minimumStockUnits} unit(s)`);
  if (suggestedBuyUnits > 0) reasons.push(`Buy after current storage, rounded to full boxes: ${suggestedBuyUnits} unit(s)`);
  else if (minimumStockUnits > 0) reasons.push("Current storage already covers the calculated remaining-month target");

  return {
    action,
    actionLabel: actionLabel(action),
    reasons,
    isNewProduct,
    reviewAfter,
    currentMonthDataAvailable,
    currentMonthSalesThrough,
    currentMonthObservedDays,
    currentMonthDaysInMonth,
    currentMonthUnits,
    currentMonthRevenue,
    currentMonthGrossProfit,
    projectedCurrentMonthUnits,
    remainingProjectedDemandUnits,
    previousMonthUnits,
    priorMonthUnits,
    previousMonthRevenue,
    previousMonthGrossProfit,
    trendRate,
    minimumStockUnits,
    targetStockUnits,
    suggestedBuyUnits,
    recommendedPlanUnits,
    recommendedBudgetLyd,
    purchasedUnitsThisMonth,
    purchasedSpendThisMonth,
    remainingPlannedUnits,
    remainingBudgetLyd,
  };
}
