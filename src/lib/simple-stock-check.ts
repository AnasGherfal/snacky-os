export type SimpleStockCheckInput = {
  boughtUnits: number;
  soldUnits: number;
  recordedLossUnits?: number;
  storageUnits: number;
  machineUnits: number;
  operatorUnits?: number;
};

export type SimpleStockCheckStatus =
  | "possible_missing"
  | "using_prior_stock"
  | "prior_stock_present"
  | "matched"
  | "no_activity";

function whole(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function calculateSimpleStockCheck(input: SimpleStockCheckInput) {
  const boughtUnits = whole(input.boughtUnits);
  const soldUnits = whole(input.soldUnits);
  const recordedLossUnits = whole(input.recordedLossUnits);
  const storageUnits = whole(input.storageUnits);
  const machineUnits = whole(input.machineUnits);
  const operatorUnits = whole(input.operatorUnits);

  const currentTotalUnits = storageUnits + machineUnits + operatorUnits;
  const boughtMinusSoldUnits = boughtUnits - soldUnits;
  const monthlyNetUnits = boughtUnits - soldUnits - recordedLossUnits;
  const remainingFromThisMonthsPurchases = Math.max(0, monthlyNetUnits);
  const possibleMissingUnits = Math.max(0, remainingFromThisMonthsPurchases - currentTotalUnits);
  const priorOrOtherStockUnits = Math.max(0, currentTotalUnits - remainingFromThisMonthsPurchases);

  let status: SimpleStockCheckStatus = "matched";
  if (boughtUnits === 0 && soldUnits === 0 && recordedLossUnits === 0) status = "no_activity";
  else if (possibleMissingUnits > 0) status = "possible_missing";
  else if (soldUnits > boughtUnits) status = "using_prior_stock";
  else if (priorOrOtherStockUnits > 0) status = "prior_stock_present";

  return {
    boughtUnits,
    soldUnits,
    recordedLossUnits,
    storageUnits,
    machineUnits,
    operatorUnits,
    currentTotalUnits,
    boughtMinusSoldUnits,
    monthlyNetUnits,
    remainingFromThisMonthsPurchases,
    possibleMissingUnits,
    priorOrOtherStockUnits,
    status,
  };
}

export function simpleStockCheckStatusLabel(status: SimpleStockCheckStatus) {
  switch (status) {
    case "possible_missing": return "Check possible missing";
    case "using_prior_stock": return "Selling older stock";
    case "prior_stock_present": return "Older stock still present";
    case "no_activity": return "No activity this month";
    default: return "Monthly buying covered";
  }
}

export function simpleStockCheckStatusTone(status: SimpleStockCheckStatus) {
  switch (status) {
    case "possible_missing": return "critical";
    case "using_prior_stock": return "pending";
    case "prior_stock_present": return "review";
    case "no_activity": return "neutral";
    default: return "confirmed";
  }
}

export function simpleStockCheckExplanation(status: SimpleStockCheckStatus) {
  switch (status) {
    case "possible_missing":
      return "This month's purchases should have left more units than are currently visible in storage, machines, and operator stock.";
    case "using_prior_stock":
      return "Sales are higher than purchases this month, so Snacky is using stock carried from before this month.";
    case "prior_stock_present":
      return "Current stock is higher than this month's purchase balance. The difference is older stock or another recorded inflow.";
    case "no_activity":
      return "No purchases, sales, or recorded losses were found for this product this month.";
    default:
      return "The current stock is enough to cover the balance left from this month's purchases.";
  }
}
