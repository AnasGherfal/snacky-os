import { formatProductQuantity, normalizeCaseQuantity } from "@/lib/product-quantity";

export type ReconciliationVarianceStatus =
  | "confirmed_missing"
  | "suspected_missing"
  | "data_gap"
  | "extra_found"
  | "balanced";

export type ReconciliationConfidence = "confirmed" | "suspected" | "data_gap";

export type StockReconciliationVarianceRow = {
  product_id: string;
  product_name: string;
  sku: string | null;
  category: string | null;
  case_quantity: number | string | null;
  opening_units: number | string | null;
  purchased_units: number | string | null;
  other_inflow_units: number | string | null;
  sold_units: number | string | null;
  recorded_loss_units: number | string | null;
  expected_closing_units: number | string | null;
  storage_units: number | string | null;
  machine_units: number | string | null;
  operator_units: number | string | null;
  actual_closing_units: number | string | null;
  variance_units: number | string | null;
  missing_units: number | string | null;
  extra_units: number | string | null;
  unit_cost: number | string | null;
  missing_cost: number | string | null;
  confidence: ReconciliationConfidence | string | null;
  variance_status: ReconciliationVarianceStatus | string | null;
  sales_source: string | null;
  latest_count_at: string | null;
  case_status: string | null;
  resolution_reason: string | null;
  case_notes: string | null;
};

export function reconciliationNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function reconciliationWholeNumber(value: unknown) {
  return Math.max(0, Math.floor(reconciliationNumber(value)));
}

export function reconciliationQuantity(
  quantity: unknown,
  product: { case_quantity?: unknown; product_name?: string | null; category?: string | null },
  compact = true,
) {
  return formatProductQuantity(quantity, {
    caseQuantity: normalizeCaseQuantity(product.case_quantity),
    productName: product.product_name ?? null,
    category: product.category ?? null,
  }, { compact });
}

export function reconciliationStatusLabel(status: string | null | undefined) {
  switch (status) {
    case "confirmed_missing": return "Confirmed missing";
    case "suspected_missing": return "Suspected missing";
    case "data_gap": return "Data gap";
    case "extra_found": return "Extra found";
    case "balanced": return "Balanced";
    default: return String(status ?? "Unknown").replaceAll("_", " ");
  }
}

export function reconciliationStatusTone(status: string | null | undefined) {
  switch (status) {
    case "confirmed_missing": return "critical";
    case "suspected_missing": return "variance_review";
    case "data_gap": return "pending";
    case "extra_found": return "review";
    case "balanced": return "counted_confirmed";
    default: return String(status ?? "unknown");
  }
}

export function reconciliationConfidenceExplanation(confidence: string | null | undefined) {
  switch (confidence) {
    case "confirmed":
      return "Opening and closing counts are aligned closely enough to treat the variance as confirmed.";
    case "suspected":
      return "A variance exists, but storage or operator stock still relies on ledger estimates or a stale machine snapshot.";
    case "data_gap":
      return "The system is missing an opening count, closing count, or usable sales source for this product.";
    default:
      return "Reconciliation confidence is not available.";
  }
}

export function reconciliationSalesSourceLabel(source: string | null | undefined) {
  switch (source) {
    case "monthly_product_profit": return "Monthly Product Profit";
    case "detailed_transactions": return "Detailed VMS transactions";
    case "none": return "No usable sales source";
    default: return String(source ?? "Unknown").replaceAll("_", " ");
  }
}
