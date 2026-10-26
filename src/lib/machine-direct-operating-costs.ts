/** Read-only, conservative classification of directly attributed operations expenses.
 * Product purchasing is inventory/COGS, NOT a second cost deduction.
 * Shared route expenses have no defensible per-machine allocation here.
 * Rent is already deducted in Growth Decisions and must not be subtracted twice.
 */
export type OperatingExpenseEvidence = {
  id?: string | null;
  related_machine_id?: string | null;
  related_route_id?: string | null;
  direction?: string | null;
  transaction_kind?: string | null;
  transaction_type?: string | null;
  final_bucket?: string | null;
  category?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  transaction_date?: string | null;
  transaction_status?: string | null;
  is_void?: boolean | null;
  voided_at?: string | null;
};

export type ExpenseClassification = "machine_direct" | "route_unallocated" | "not_operating_cost" | "unverified";

const serviceExpense = /(?:maintenance|repair|service|servicing|fuel|petrol|diesel|transport|delivery|logistics|vehicle|صيانة|تصليح|وقود|بنزين|توصيل|نقل)/i;
const excluded = /(?:rent|rental|inventory|restock|product|purchase|stock|supplier|salary|wage|transfer|funding|revenue|sales|cash.collection|إيجار|مخزون|منتج|شراء|مرتب|رواتب|تحويل|إيراد|مبيعات)/i;

export function classifyMachineOperatingExpense(row: OperatingExpenseEvidence): ExpenseClassification {
  if (row.is_void || row.voided_at || row.transaction_status === "voided") return "not_operating_cost";
  if (row.direction !== "money_out") return "not_operating_cost";
  if (!row.transaction_date || row.currency !== "LYD") return "unverified";
  const amount = row.amount === null || row.amount === undefined || String(row.amount).trim() === ""
    ? NaN : Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "unverified";
  const labels = [row.transaction_kind,row.transaction_type,row.final_bucket,row.category]
    .map(value => String(value ?? "")).join(" ");
  if (excluded.test(labels)) return "not_operating_cost";
  if (!serviceExpense.test(labels)) return "not_operating_cost";
  if (row.related_route_id) return "route_unallocated";
  if (row.related_machine_id) return "machine_direct";
  return "unverified";
}

export function summarizeDirectMachineExpenses(rows: OperatingExpenseEvidence[], start: string, end: string) {
  const machineAmounts = new Map<string,number>();
  let unallocatedRouteCount = 0;
  let unallocatedRouteAmount = 0;
  let needsMappingCount = 0;
  for (const row of rows) {
    const day = String(row.transaction_date ?? "");
    if (day < start || day > end) continue;
    const kind = classifyMachineOperatingExpense(row);
    const amount = Number(row.amount);
    if (kind === "machine_direct" && row.related_machine_id) {
      machineAmounts.set(row.related_machine_id,
        Math.round(((machineAmounts.get(row.related_machine_id) ?? 0) + amount) * 100) / 100);
    } else if (kind === "route_unallocated") {
      unallocatedRouteCount += 1;
      unallocatedRouteAmount += amount;
    } else if (kind === "unverified") {
      needsMappingCount += 1;
    }
  }
  return {
    machineAmounts,
    unallocatedRouteCount,
    unallocatedRouteAmount: Math.round(unallocatedRouteAmount * 100) / 100,
    needsMappingCount,
  };
}
