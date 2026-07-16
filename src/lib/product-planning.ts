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
  purchasedUnitsThisMonth?: number | string | null;
  purchasedSpendThisMonth?: number | string | null;
};

export type ProductPlanningRecommendation = {
  action: ProductPlanningAction;
  actionLabel: string;
  reasons: string[];
  isNewProduct: boolean;
  reviewAfter: string | null;
  previousMonthUnits: number;
  priorMonthUnits: number;
  previousMonthRevenue: number;
  previousMonthGrossProfit: number | null;
  trendRate: number | null;
  minimumStockUnits: number;
  targetStockUnits: number;
  suggestedBuyUnits: number;
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

export function buildProductPlanningRecommendation(
  input: ProductPlanningInput,
  planningMonth: string,
): ProductPlanningRecommendation {
  const monthStart = firstOfMonth(planningMonth);
  const previousMonth = shiftPlanningMonth(planningMonth, -1);
  const priorMonth = shiftPlanningMonth(planningMonth, -2);
  const salesMonths = input.salesMonths ?? [];
  const previous = monthRow(salesMonths, previousMonth);
  const prior = monthRow(salesMonths, priorMonth);
  const previousMonthUnits = wholeNumber(previous?.units);
  const priorMonthUnits = wholeNumber(prior?.units);
  const previousMonthRevenue = Math.max(0, numeric(previous?.revenue));
  const previousMonthGrossProfit = previous?.grossProfit === null || previous?.grossProfit === undefined
    ? null
    : numeric(previous.grossProfit);
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

  const trendRate = priorMonthUnits > 0 ? (previousMonthUnits - priorMonthUnits) / priorMonthUnits : null;
  const minimumStockUnits = isNewProduct
    ? Math.max(caseQuantity, previousMonthUnits)
    : previousMonthUnits;

  let safetyMultiplier = 1;
  if (trendRate !== null && trendRate >= 0.25) safetyMultiplier = 1.2;
  else if (previousMonthUnits >= caseQuantity * 4 || activeMachineCount >= 4) safetyMultiplier = 1.15;
  const targetStockUnits = roundUnitsUpToCase(Math.ceil(minimumStockUnits * safetyMultiplier), caseQuantity);
  const suggestedBuyUnits = Math.max(0, targetStockUnits - currentStorageUnits);
  const recommendedBudgetLyd = Number.isFinite(unitCost) && unitCost > 0
    ? roundMoney(suggestedBuyUnits * unitCost)
    : null;

  const remainingPlannedUnits = Math.max(0, suggestedBuyUnits - purchasedUnitsThisMonth);
  const remainingBudgetLyd = recommendedBudgetLyd === null
    ? null
    : Math.max(0, roundMoney(recommendedBudgetLyd - purchasedSpendThisMonth));

  const reasons: string[] = [];
  let action: ProductPlanningAction;

  if (isNewProduct) {
    action = "testing";
    reasons.push(`Protected as a new product until ${reviewAfter}`);
    reasons.push(`Start with at least ${caseQuantity} unit${caseQuantity === 1 ? "" : "s"} (${caseQuantity > 1 ? "one box" : "one test unit"})`);
  } else if (!Number.isFinite(unitCost) || unitCost <= 0 || (previousMonthGrossProfit !== null && previousMonthGrossProfit < 0)) {
    action = "review";
    if (!Number.isFinite(unitCost) || unitCost <= 0) reasons.push("Purchase cost is missing");
    if (previousMonthGrossProfit !== null && previousMonthGrossProfit < 0) reasons.push("Previous month gross profit was negative");
  } else if (previousMonthUnits === 0 && priorMonthUnits === 0) {
    action = "remove";
    reasons.push("No sales in either of the last two completed months");
    if (currentStorageUnits > 0) reasons.push(`${currentStorageUnits} unit(s) are still in storage`);
    if (activeMachineCount > 0) reasons.push(`Still assigned to ${activeMachineCount} machine(s)`);
  } else if (
    previousMonthUnits === 0
    || (trendRate !== null && trendRate <= -0.4)
    || (previousMonthUnits > 0 && currentStorageUnits > previousMonthUnits * 2.5)
  ) {
    action = "reduce";
    if (previousMonthUnits === 0) reasons.push("No sales last month");
    if (trendRate !== null && trendRate <= -0.4) reasons.push(`Sales fell ${Math.abs(trendRate * 100).toFixed(0)}% versus the month before`);
    if (previousMonthUnits > 0 && currentStorageUnits > previousMonthUnits * 2.5) reasons.push("More than 2.5 months of last-month demand remains in storage");
  } else if (
    (trendRate !== null && trendRate >= 0.25)
    || (previousMonthUnits > 0 && currentStorageUnits < previousMonthUnits * 0.5)
  ) {
    action = "increase";
    if (trendRate !== null && trendRate >= 0.25) reasons.push(`Sales grew ${(trendRate * 100).toFixed(0)}% versus the month before`);
    if (currentStorageUnits < previousMonthUnits * 0.5) reasons.push("Current storage is below half of last month demand");
  } else {
    action = "keep";
    reasons.push("Product sold during the previous completed month");
  }

  if (minimumStockUnits > 0) reasons.push(`Minimum stock target follows last month sales: ${minimumStockUnits} unit(s)`);
  if (suggestedBuyUnits > 0) reasons.push(`Suggested buy after current storage: ${suggestedBuyUnits} unit(s)`);
  else if (minimumStockUnits > 0) reasons.push("Current storage already covers the calculated target");

  return {
    action,
    actionLabel: actionLabel(action),
    reasons,
    isNewProduct,
    reviewAfter,
    previousMonthUnits,
    priorMonthUnits,
    previousMonthRevenue,
    previousMonthGrossProfit,
    trendRate,
    minimumStockUnits,
    targetStockUnits,
    suggestedBuyUnits,
    recommendedBudgetLyd,
    purchasedUnitsThisMonth,
    purchasedSpendThisMonth,
    remainingPlannedUnits,
    remainingBudgetLyd,
  };
}
