import { financeCategoryLabel } from "@/lib/finance-ledger";
import { isBalanceAffectingTransaction, normalizeFinanceCurrency, signedAmount } from "@/lib/finance-balance";

export type FinanceOperationsPeriodKey = "this_month" | "last_month" | "this_year" | "all_time" | "custom";

export type FinanceOperationsPeriod = {
  key: FinanceOperationsPeriodKey;
  label: string;
  start: string;
  end: string;
};

export type FinanceOperationsSearchParams = {
  period?: string;
  date_from?: string;
  date_to?: string;
};

export type FinanceOperationsLedgerRow = {
  id?: string | null;
  transaction_date?: string | null;
  transaction_datetime?: string | null;
  direction?: string | null;
  transaction_kind?: string | null;
  transaction_type?: string | null;
  description?: string | null;
  notes?: string | null;
  amount?: number | string | null;
  signed_amount?: number | string | null;
  currency?: string | null;
  transaction_effect?: string | null;
  category?: string | null;
  bucket?: string | null;
  final_bucket?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  linked_purchase_id?: string | null;
  related_purchase_id?: string | null;
  linked_cash_collection_id?: string | null;
  related_cash_collection_id?: string | null;
  related_machine_id?: string | null;
  related_location_id?: string | null;
  location?: string | null;
  counterparty_text?: string | null;
  paid_to_text?: string | null;
  payee_text?: string | null;
  payment_method?: string | null;
  transaction_status?: string | null;
  review_status?: string | null;
  needs_review?: boolean | null;
  import_status?: string | null;
  is_void?: boolean | null;
  voided_at?: string | null;
};

export type FinanceCashCollectionRow = {
  id: string;
  machine_id?: string | null;
  collected_at?: string | null;
  counted_at?: string | null;
  vms_expected_cash?: number | string | null;
  actual_cash_collected?: number | string | null;
  variance?: number | string | null;
  review_status?: string | null;
};

export type VmsMachineSalesRow = {
  bucket_key?: string | null;
  bucket_label?: string | null;
  successful_sales_amount?: number | string | null;
  successful_sales_count?: number | string | null;
  units_sold?: number | string | null;
};

export type MachineIdentity = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location_name?: string | null;
};

export type ExpenseCategorySummary = {
  key: string;
  label: string;
  amount: number;
  transactionCount: number;
  averageTransaction: number;
  shareOfCashOut: number;
  isProductPurchase: boolean;
  isOperatingExpense: boolean;
};

export type MachineCashReconciliation = {
  key: string;
  machineId: string | null;
  machineLabel: string;
  machineCode: string | null;
  locationLabel: string;
  vmsSalesAmount: number;
  vmsSalesCount: number;
  unitsSold: number;
  expectedCash: number;
  countedCash: number;
  recordedVariance: number;
  calculatedVariance: number;
  collectionCount: number;
  latestCountedAt: string | null;
  varianceReviewCount: number;
  missingExpectedCount: number;
  collectionAccuracy: number | null;
  vmsMatchStatus: "matched" | "cash_only" | "vms_only";
};

const NON_OPERATING_CATEGORY_TOKENS = [
  "owner funding",
  "owner withdrawal",
  "opening balance",
  "bank exchange",
  "bank / exchange",
  "exchange transfer",
  "internal transfer",
  "investor profit share",
  "investor distribution",
  "profit distribution",
];

const EXPENSE_CATEGORY_RULES: Array<{ key: string; label: string; tokens: string[]; productPurchase?: boolean }> = [
  {
    key: "products",
    label: "Product purchases",
    productPurchase: true,
    tokens: ["products restocking", "product purchase", "restocking", "inventory purchase", "inventory"],
  },
  { key: "rent", label: "Rent", tokens: ["rent", "lease", "site fee", "location fee"] },
  { key: "salary", label: "Salaries", tokens: ["salary", "payroll", "wage", "employee pay"] },
  { key: "shipping", label: "Shipping & customs", tokens: ["shipping", "freight", "customs", "cargo", "delivery fee"] },
  { key: "ads", label: "Advertising", tokens: ["advertising", "advertisement", "marketing", " ads", "ads "] },
  { key: "maintenance", label: "Maintenance & repairs", tokens: ["maintenance", "repair", "spare part", "technician"] },
  { key: "vehicle", label: "Transport & vehicle", tokens: ["fuel", "petrol", "gasoline", "oil change", "vehicle", "car", "transport"] },
  { key: "utilities", label: "Utilities & communications", tokens: ["electricity", "internet", "phone", "utility", "water bill"] },
  { key: "fees", label: "Fees & banking", tokens: ["bank fee", "commission", "service fee", "transfer fee", "fee"] },
  { key: "charity", label: "Charity", tokens: ["charity", "donation", "zakat"] },
];

function dateOnly(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function numeric(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rowSearchText(row: FinanceOperationsLedgerRow) {
  return [
    financeCategoryLabel(row),
    row.transaction_kind,
    row.transaction_type,
    row.description,
    row.notes,
    row.bucket,
    row.final_bucket,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" | ");
}

export function resolveFinanceOperationsPeriod(
  params: FinanceOperationsSearchParams,
  now = new Date(),
): FinanceOperationsPeriod {
  const requested = String(params.period ?? "this_month");
  if (requested === "last_month") {
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      key: "last_month",
      label: "Last month",
      start: dateOnly(startOfMonth(previous)),
      end: dateOnly(endOfMonth(previous)),
    };
  }
  if (requested === "this_year") {
    return {
      key: "this_year",
      label: "This year",
      start: `${now.getFullYear()}-01-01`,
      end: dateOnly(now),
    };
  }
  if (requested === "all_time") {
    return {
      key: "all_time",
      label: "All time",
      start: "2000-01-01",
      end: dateOnly(now),
    };
  }
  if (requested === "custom") {
    const fallbackStart = dateOnly(startOfMonth(now));
    const start = String(params.date_from ?? fallbackStart);
    const end = String(params.date_to ?? dateOnly(now));
    return {
      key: "custom",
      label: "Custom range",
      start: start <= end ? start : end,
      end: start <= end ? end : start,
    };
  }
  return {
    key: "this_month",
    label: "This month",
    start: dateOnly(startOfMonth(now)),
    end: dateOnly(now),
  };
}

export function canonicalExpenseCategory(row: FinanceOperationsLedgerRow) {
  const text = rowSearchText(row);
  const rule = EXPENSE_CATEGORY_RULES.find((candidate) => candidate.tokens.some((token) => text.includes(cleanText(token))));
  if (rule) {
    return {
      key: rule.key,
      label: rule.label,
      isProductPurchase: Boolean(rule.productPurchase),
      isOperatingExpense: !rule.productPurchase,
    };
  }
  const sourceLabel = financeCategoryLabel(row);
  return {
    key: `other:${cleanText(sourceLabel) || "uncategorized"}`,
    label: sourceLabel || "Other / uncategorized",
    isProductPurchase: false,
    isOperatingExpense: true,
  };
}

export function isFinanceCashCollectionRow(row: FinanceOperationsLedgerRow) {
  return Boolean(
    row.transaction_kind === "cash_collection"
    || row.source_type === "cash_collection"
    || row.linked_cash_collection_id
    || row.related_cash_collection_id,
  );
}

export function isFinanceProductPurchaseRow(row: FinanceOperationsLedgerRow) {
  if (row.transaction_kind === "product_purchase" || row.source_type === "purchase" || row.linked_purchase_id || row.related_purchase_id) return true;
  return canonicalExpenseCategory(row).isProductPurchase;
}

export function isReportableExpenseRow(row: FinanceOperationsLedgerRow, currency = "LYD") {
  if (!isBalanceAffectingTransaction(row)) return false;
  if (normalizeFinanceCurrency(row.currency) !== normalizeFinanceCurrency(currency)) return false;
  if (row.direction !== "money_out") return false;
  const effect = String(row.transaction_effect ?? "expense").toLowerCase();
  if (effect === "transfer" || effect === "opening_balance") return false;
  const text = rowSearchText(row);
  if (NON_OPERATING_CATEGORY_TOKENS.some((token) => text.includes(token))) return false;
  return true;
}

export function aggregateExpenseCategories(rows: FinanceOperationsLedgerRow[], currency = "LYD") {
  const expenseRows = rows.filter((row) => isReportableExpenseRow(row, currency));
  const totalCashOut = roundMoney(expenseRows.reduce((sum, row) => sum + Math.abs(signedAmount(row)), 0));
  const buckets = new Map<string, ExpenseCategorySummary>();

  for (const row of expenseRows) {
    const category = canonicalExpenseCategory(row);
    const amount = Math.abs(signedAmount(row));
    const current = buckets.get(category.key) ?? {
      key: category.key,
      label: category.label,
      amount: 0,
      transactionCount: 0,
      averageTransaction: 0,
      shareOfCashOut: 0,
      isProductPurchase: category.isProductPurchase,
      isOperatingExpense: category.isOperatingExpense,
    };
    current.amount = roundMoney(current.amount + amount);
    current.transactionCount += 1;
    buckets.set(category.key, current);
  }

  const categories = Array.from(buckets.values())
    .map((row) => ({
      ...row,
      averageTransaction: row.transactionCount > 0 ? roundMoney(row.amount / row.transactionCount) : 0,
      shareOfCashOut: totalCashOut > 0 ? row.amount / totalCashOut : 0,
    }))
    .sort((left, right) => right.amount - left.amount || left.label.localeCompare(right.label));

  return {
    categories,
    totalCashOut,
    productPurchases: roundMoney(categories.filter((row) => row.isProductPurchase).reduce((sum, row) => sum + row.amount, 0)),
    operatingExpenses: roundMoney(categories.filter((row) => row.isOperatingExpense).reduce((sum, row) => sum + row.amount, 0)),
  };
}

export function summarizeCashCollections(rows: FinanceCashCollectionRow[]) {
  const activeRows = rows.filter((row) => String(row.review_status ?? "") !== "voided");
  const countedRows = activeRows.filter((row) => row.actual_cash_collected !== null && row.actual_cash_collected !== undefined);
  const expectedRows = countedRows.filter((row) => row.vms_expected_cash !== null && row.vms_expected_cash !== undefined);
  const countedCash = roundMoney(countedRows.reduce((sum, row) => sum + numeric(row.actual_cash_collected), 0));
  const expectedCash = roundMoney(expectedRows.reduce((sum, row) => sum + numeric(row.vms_expected_cash), 0));
  const calculatedVariance = roundMoney(countedCash - expectedCash);
  return {
    countedRows,
    countedCash,
    expectedCash,
    calculatedVariance,
    recordedVariance: roundMoney(countedRows.reduce((sum, row) => sum + numeric(row.variance), 0)),
    collectionAccuracy: expectedCash > 0 ? countedCash / expectedCash : null,
    varianceReviewCount: countedRows.filter((row) => String(row.review_status ?? "") === "variance_review").length,
    missingExpectedCount: countedRows.filter((row) => row.vms_expected_cash === null || row.vms_expected_cash === undefined).length,
  };
}

export function normalizeMachineMatchText(value: unknown) {
  return cleanText(value).replace(/\b(machine|vm|vending)\b/g, " ").replace(/\s+/g, " ").trim();
}

function machineAliases(machine: MachineIdentity) {
  return Array.from(new Set([
    normalizeMachineMatchText(machine.name),
    normalizeMachineMatchText(machine.machine_code),
    normalizeMachineMatchText(`${machine.name ?? ""} ${machine.machine_code ?? ""}`),
  ].filter(Boolean)));
}

function resolveVmsMachine(vmsRow: VmsMachineSalesRow, machines: MachineIdentity[]) {
  const values = [vmsRow.bucket_key, vmsRow.bucket_label].map(normalizeMachineMatchText).filter(Boolean);
  const exactMatches = machines.filter((machine) => machineAliases(machine).some((alias) => values.includes(alias)));
  if (exactMatches.length === 1) return exactMatches[0];

  const codeMatches = machines.filter((machine) => {
    const code = normalizeMachineMatchText(machine.machine_code);
    return Boolean(code && values.some((value) => value.includes(code)));
  });
  if (codeMatches.length === 1) return codeMatches[0];

  const nameMatches = machines.filter((machine) => {
    const name = normalizeMachineMatchText(machine.name);
    return Boolean(name && values.some((value) => value.includes(name) || name.includes(value)));
  });
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

export function buildMachineCashReconciliation({
  machines,
  cashCollections,
  vmsRows,
}: {
  machines: MachineIdentity[];
  cashCollections: FinanceCashCollectionRow[];
  vmsRows: VmsMachineSalesRow[];
}) {
  const rows = new Map<string, MachineCashReconciliation>();

  function baseRow(key: string, machine: MachineIdentity | null, fallbackLabel: string): MachineCashReconciliation {
    return {
      key,
      machineId: machine?.id ?? null,
      machineLabel: machine?.name?.trim() || fallbackLabel || machine?.machine_code?.trim() || "Unknown machine",
      machineCode: machine?.machine_code?.trim() || null,
      locationLabel: machine?.location_name?.trim() || "No location",
      vmsSalesAmount: 0,
      vmsSalesCount: 0,
      unitsSold: 0,
      expectedCash: 0,
      countedCash: 0,
      recordedVariance: 0,
      calculatedVariance: 0,
      collectionCount: 0,
      latestCountedAt: null,
      varianceReviewCount: 0,
      missingExpectedCount: 0,
      collectionAccuracy: null,
      vmsMatchStatus: "matched",
    };
  }

  for (const collection of cashCollections.filter((row) => String(row.review_status ?? "") !== "voided")) {
    const machine = machines.find((candidate) => candidate.id === collection.machine_id) ?? null;
    const key = machine ? machine.id : `cash:${collection.machine_id ?? "unknown"}`;
    const row = rows.get(key) ?? baseRow(key, machine, machine?.name ?? "Unknown cash machine");
    row.countedCash = roundMoney(row.countedCash + numeric(collection.actual_cash_collected));
    if (collection.vms_expected_cash === null || collection.vms_expected_cash === undefined) row.missingExpectedCount += 1;
    else row.expectedCash = roundMoney(row.expectedCash + numeric(collection.vms_expected_cash));
    row.recordedVariance = roundMoney(row.recordedVariance + numeric(collection.variance));
    row.collectionCount += 1;
    if (String(collection.review_status ?? "") === "variance_review") row.varianceReviewCount += 1;
    const countedAt = collection.counted_at ?? collection.collected_at ?? null;
    if (countedAt && (!row.latestCountedAt || countedAt > row.latestCountedAt)) row.latestCountedAt = countedAt;
    row.vmsMatchStatus = "cash_only";
    rows.set(key, row);
  }

  for (const vmsRow of vmsRows) {
    const machine = resolveVmsMachine(vmsRow, machines);
    const label = String(vmsRow.bucket_label ?? vmsRow.bucket_key ?? "Unknown VMS machine");
    const key = machine ? machine.id : `vms:${normalizeMachineMatchText(vmsRow.bucket_key ?? label) || label}`;
    const row = rows.get(key) ?? baseRow(key, machine, label);
    row.vmsSalesAmount = roundMoney(row.vmsSalesAmount + numeric(vmsRow.successful_sales_amount));
    row.vmsSalesCount += Math.max(0, Math.floor(numeric(vmsRow.successful_sales_count)));
    row.unitsSold += Math.max(0, Math.floor(numeric(vmsRow.units_sold)));
    row.vmsMatchStatus = row.collectionCount > 0 ? "matched" : "vms_only";
    rows.set(key, row);
  }

  return Array.from(rows.values())
    .map((row) => ({
      ...row,
      calculatedVariance: roundMoney(row.countedCash - row.expectedCash),
      collectionAccuracy: row.expectedCash > 0 ? row.countedCash / row.expectedCash : null,
    }))
    .sort((left, right) => right.vmsSalesAmount - left.vmsSalesAmount || right.countedCash - left.countedCash || left.machineLabel.localeCompare(right.machineLabel));
}

export function sumActiveLedgerDirection(rows: FinanceOperationsLedgerRow[], direction: "money_in" | "money_out", currency = "LYD") {
  return roundMoney(rows.reduce((sum, row) => {
    if (!isBalanceAffectingTransaction(row)) return sum;
    if (normalizeFinanceCurrency(row.currency) !== normalizeFinanceCurrency(currency)) return sum;
    if (row.direction !== direction) return sum;
    return sum + Math.abs(signedAmount(row));
  }, 0));
}
