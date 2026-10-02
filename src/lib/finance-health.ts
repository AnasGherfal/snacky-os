import { financeCategoryLabel } from "@/lib/finance-ledger";
import { formatMachineDisplayName } from "@/lib/machine-site-display";

type SupabaseLike = {
  from: (table: string) => any;
};

type PurchaseHealthRow = {
  id: string;
  order_date: string | null;
  status: string | null;
  payment_status: string | null;
  receipt_number: string | null;
  supplier_id: string | null;
  total_amount: number | string | null;
  manual_total_lyd: number | string | null;
  calculated_total_lyd: number | string | null;
  supplier?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

type CashHealthRow = {
  id: string;
  collected_at: string | null;
  review_status: string | null;
  actual_cash_collected: number | string | null;
  vms_expected_cash: number | string | null;
  cash_bag_id: string | null;
  route_id: string | null;
  machine_id: string | null;
  machine?: { name?: string | null; machine_code?: string | null } | Array<{ name?: string | null; machine_code?: string | null }> | null;
};

type FinanceSourceRow = {
  id: string;
  transaction_date: string | null;
  transaction_datetime?: string | null;
  direction: string | null;
  transaction_kind: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  signed_amount: number | string | null;
  currency: string | null;
  account_id: string | null;
  account_key?: string | null;
  transaction_effect: string | null;
  category: string | null;
  final_bucket: string | null;
  import_status: string | null;
  transaction_status: string | null;
  review_status: string | null;
  source_type: string | null;
  source_id: string | null;
  linked_purchase_id: string | null;
  linked_cash_collection_id: string | null;
  related_purchase_id: string | null;
  related_cash_collection_id: string | null;
  description: string | null;
  location: string | null;
  related_route_id: string | null;
  related_machine_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  is_void: boolean | null;
};

export type FinanceHealthMissingPurchase = {
  id: string;
  orderDate: string | null;
  status: string | null;
  paymentStatus: string | null;
  receiptNumber: string | null;
  supplierName: string | null;
  amount: number;
};

export type FinanceHealthMissingCash = {
  id: string;
  collectedAt: string | null;
  reviewStatus: string | null;
  machineName: string | null;
  cashBagId: string | null;
  actualCashCollected: number;
};

export type FinanceHealthBrokenLink = {
  financeTransactionId: string;
  sourceType: "purchase" | "cash_collection";
  sourceId: string | null;
  linkedId: string | null;
  reason: string;
  description: string | null;
  transactionDate: string | null;
};

export type FinanceHealthBalanceIssue = {
  sourceType: "purchase" | "cash_collection";
  sourceId: string;
  financeTransactionId: string;
  sourceAmount: number;
  financeAmount: number;
  direction: string | null;
  signedAmount: number;
  transactionEffect: string | null;
  issue: string;
  label: string;
  transactionDate: string | null;
};

export type FinanceHealthCategoryIssue = {
  financeTransactionId: string;
  sourceType: string | null;
  description: string | null;
  category: string;
  transactionType: string | null;
  finalBucket: string | null;
  transactionDate: string | null;
};

export type FinanceHealthIgnoredSourceRow = {
  financeTransactionId: string;
  sourceType: "purchase" | "cash_collection";
  sourceId: string | null;
  importStatus: string | null;
  description: string | null;
  transactionDate: string | null;
};

export type FinanceHealthDiagnostics = {
  purchasesMissingFinance: FinanceHealthMissingPurchase[];
  cashCollectionsMissingFinance: FinanceHealthMissingCash[];
  brokenLinks: FinanceHealthBrokenLink[];
  balanceInconsistencies: FinanceHealthBalanceIssue[];
  missingCategories: FinanceHealthCategoryIssue[];
  ignoredSourceRows: FinanceHealthIgnoredSourceRow[];
  errors: string[];
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function relationRecord<T extends Record<string, unknown>>(value: T | T[] | null | undefined) {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

function purchaseAmount(purchase: Pick<PurchaseHealthRow, "manual_total_lyd" | "total_amount" | "calculated_total_lyd">) {
  return Math.abs(
    numberValue(purchase.manual_total_lyd) ||
      numberValue(purchase.total_amount) ||
      numberValue(purchase.calculated_total_lyd),
  );
}

function cashAmount(cash: Pick<CashHealthRow, "actual_cash_collected">) {
  return Math.abs(numberValue(cash.actual_cash_collected));
}

function purchaseShouldSync(purchase: PurchaseHealthRow) {
  return !["cancelled", "voided"].includes(String(purchase.status ?? "").trim()) && purchaseAmount(purchase) > 0;
}

function cashShouldSync(cash: CashHealthRow) {
  return String(cash.review_status ?? "").trim() !== "voided" && cash.actual_cash_collected !== null && cash.actual_cash_collected !== undefined;
}

function financeRowIsActive(row: FinanceSourceRow) {
  return !row.is_void && String(row.transaction_status ?? "active").trim() !== "voided";
}

function financeRowPurchaseId(row: FinanceSourceRow) {
  return textValue(row.linked_purchase_id) ?? (row.source_type === "purchase" ? textValue(row.source_id) : null) ?? textValue(row.related_purchase_id);
}

function financeRowCashId(row: FinanceSourceRow) {
  return textValue(row.linked_cash_collection_id) ?? (row.source_type === "cash_collection" ? textValue(row.source_id) : null) ?? textValue(row.related_cash_collection_id);
}

function financeRowSourceType(row: FinanceSourceRow) {
  if (row.source_type === "purchase" || textValue(row.linked_purchase_id) || textValue(row.related_purchase_id)) return "purchase" as const;
  if (row.source_type === "cash_collection" || textValue(row.linked_cash_collection_id) || textValue(row.related_cash_collection_id)) return "cash_collection" as const;
  return null;
}

function pushMapList<T>(map: Map<string, T[]>, key: string | null, value: T) {
  if (!key) return;
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function financeIssueKey(rowId: string, reason: string) {
  return `${rowId}::${reason}`;
}

function approxEqual(left: number, right: number) {
  return Math.abs(left - right) < 0.01;
}

export async function loadFinanceHealthDiagnostics(supabase: SupabaseLike): Promise<FinanceHealthDiagnostics> {
  const [purchaseResult, cashResult, sourceFinanceResult, recentFinanceResult] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, order_date, status, payment_status, receipt_number, supplier_id, total_amount, manual_total_lyd, calculated_total_lyd, supplier:suppliers(name)")
      .order("order_date", { ascending: false }),
    supabase
      .from("cash_collections")
      .select("id, collected_at, review_status, actual_cash_collected, vms_expected_cash, cash_bag_id, route_id, machine_id, machine:machines(name, machine_code, location:locations(id, name))")
      .order("collected_at", { ascending: false }),
    supabase
      .from("financial_transactions")
      .select("id, transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, amount, signed_amount, currency, account_id, account_key, transaction_effect, category, final_bucket, import_status, transaction_status, review_status, source_type, source_id, linked_purchase_id, linked_cash_collection_id, related_purchase_id, related_cash_collection_id, description, location, related_route_id, related_machine_id, created_at, updated_at, is_void")
      .or("source_type.eq.purchase,source_type.eq.cash_collection,linked_purchase_id.not.is.null,linked_cash_collection_id.not.is.null,related_purchase_id.not.is.null,related_cash_collection_id.not.is.null")
      .order("transaction_date", { ascending: false }),
    supabase
      .from("financial_transactions")
      .select("id, transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, amount, signed_amount, currency, account_id, account_key, transaction_effect, category, final_bucket, import_status, transaction_status, review_status, source_type, source_id, linked_purchase_id, linked_cash_collection_id, related_purchase_id, related_cash_collection_id, description, location, related_route_id, related_machine_id, created_at, updated_at, is_void")
      .order("transaction_date", { ascending: false })
      .limit(400),
  ]);

  const errors = [purchaseResult.error, cashResult.error, sourceFinanceResult.error, recentFinanceResult.error]
    .filter(Boolean)
    .map((error) => (error instanceof Error ? error.message : String((error as any)?.message ?? error)));

  const purchases = (purchaseResult.data ?? []) as PurchaseHealthRow[];
  const cashCollections = (cashResult.data ?? []) as CashHealthRow[];
  const sourceFinanceRows = ((sourceFinanceResult.data ?? []) as FinanceSourceRow[]).filter(financeRowIsActive);
  const recentFinanceRows = ((recentFinanceResult.data ?? []) as FinanceSourceRow[]).filter(financeRowIsActive);

  const purchaseById = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const cashById = new Map(cashCollections.map((cash) => [cash.id, cash]));
  const financePurchaseRowsByPurchaseId = new Map<string, FinanceSourceRow[]>();
  const financeCashRowsByCashId = new Map<string, FinanceSourceRow[]>();

  for (const row of sourceFinanceRows) {
    pushMapList(financePurchaseRowsByPurchaseId, financeRowPurchaseId(row), row);
    pushMapList(financeCashRowsByCashId, financeRowCashId(row), row);
  }

  const purchasesMissingFinance = purchases
    .filter((purchase) => purchaseShouldSync(purchase) && !(financePurchaseRowsByPurchaseId.get(purchase.id)?.length))
    .slice(0, 50)
    .map((purchase) => ({
      id: purchase.id,
      orderDate: textValue(purchase.order_date),
      status: textValue(purchase.status),
      paymentStatus: textValue(purchase.payment_status),
      receiptNumber: textValue(purchase.receipt_number),
      supplierName: textValue(relationRecord<{ name?: string | null }>(purchase.supplier)?.name),
      amount: purchaseAmount(purchase),
    }));

  const cashCollectionsMissingFinance = cashCollections
    .filter((cash) => cashShouldSync(cash) && !(financeCashRowsByCashId.get(cash.id)?.length))
    .slice(0, 50)
    .map((cash) => ({
      id: cash.id,
      collectedAt: textValue(cash.collected_at),
      reviewStatus: textValue(cash.review_status),
      machineName: textValue(relationRecord<{ name?: string | null; machine_code?: string | null }>(cash.machine)?.name)
        ?? textValue(relationRecord<{ name?: string | null; machine_code?: string | null }>(cash.machine)?.machine_code),
      cashBagId: textValue(cash.cash_bag_id),
      actualCashCollected: cashAmount(cash),
    }));

  const brokenLinkMap = new Map<string, FinanceHealthBrokenLink>();

  for (const row of sourceFinanceRows) {
    const sourceType = financeRowSourceType(row);
    if (!sourceType) continue;

    const linkedId = sourceType === "purchase" ? financeRowPurchaseId(row) : financeRowCashId(row);
    const reasons: string[] = [];

    if (sourceType === "purchase") {
      if (!linkedId) reasons.push("Purchase finance row is missing its purchase link.");
      else if (!purchaseById.has(linkedId)) reasons.push("Linked purchase no longer exists.");
      if (textValue(row.source_id) && textValue(row.linked_purchase_id) && textValue(row.source_id) !== textValue(row.linked_purchase_id)) {
        reasons.push("source_id and linked_purchase_id do not match.");
      }
      if ((financePurchaseRowsByPurchaseId.get(linkedId ?? "") ?? []).length > 1) {
        reasons.push("More than one active finance row is linked to this purchase.");
      }
    } else {
      if (!linkedId) reasons.push("Cash collection finance row is missing its cash link.");
      else if (!cashById.has(linkedId)) reasons.push("Linked cash collection no longer exists.");
      if (textValue(row.source_id) && textValue(row.linked_cash_collection_id) && textValue(row.source_id) !== textValue(row.linked_cash_collection_id)) {
        reasons.push("source_id and linked_cash_collection_id do not match.");
      }
      if ((financeCashRowsByCashId.get(linkedId ?? "") ?? []).length > 1) {
        reasons.push("More than one active finance row is linked to this cash collection.");
      }
    }

    if (["ignored", "skipped"].includes(String(row.import_status ?? "").trim())) {
      reasons.push(`Source-generated row is hidden by import_status=${String(row.import_status)}.`);
    }

    for (const reason of reasons) {
      const key = financeIssueKey(row.id, reason);
      brokenLinkMap.set(key, {
        financeTransactionId: row.id,
        sourceType,
        sourceId: textValue(row.source_id),
        linkedId,
        reason,
        description: textValue(row.description),
        transactionDate: textValue(row.transaction_date),
      });
    }
  }

  const balanceInconsistencies: FinanceHealthBalanceIssue[] = [];

  for (const purchase of purchases.filter(purchaseShouldSync)) {
    const row = (financePurchaseRowsByPurchaseId.get(purchase.id) ?? [])[0];
    if (!row) continue;
    const sourceAmount = purchaseAmount(purchase);
    const financeAmount = Math.abs(numberValue(row.amount));
    const signedAmount = numberValue(row.signed_amount);
    const issues: string[] = [];
    if (row.direction !== "money_out") issues.push("direction should be money_out");
    if (row.transaction_effect !== "expense") issues.push("transaction_effect should be expense");
    if (signedAmount > 0) issues.push("signed_amount should be negative for money_out");
    if (!approxEqual(financeAmount, sourceAmount)) issues.push("finance amount does not match purchase total");
    if (!approxEqual(Math.abs(signedAmount), sourceAmount)) issues.push("signed amount does not match purchase total");
    if (!issues.length) continue;

    balanceInconsistencies.push({
      sourceType: "purchase",
      sourceId: purchase.id,
      financeTransactionId: row.id,
      sourceAmount,
      financeAmount,
      direction: row.direction,
      signedAmount,
      transactionEffect: row.transaction_effect,
      issue: issues.join("; "),
      label: textValue(purchase.receipt_number) ?? purchase.id,
      transactionDate: textValue(row.transaction_date),
    });
  }

  for (const cash of cashCollections.filter(cashShouldSync)) {
    const row = (financeCashRowsByCashId.get(cash.id) ?? [])[0];
    if (!row) continue;
    const sourceAmount = cashAmount(cash);
    const financeAmount = Math.abs(numberValue(row.amount));
    const signedAmount = numberValue(row.signed_amount);
    const issues: string[] = [];
    if (row.direction !== "money_in") issues.push("direction should be money_in");
    if (row.transaction_effect !== "income") issues.push("transaction_effect should be income");
    if (signedAmount < 0) issues.push("signed_amount should be positive for money_in");
    if (!approxEqual(financeAmount, sourceAmount)) issues.push("finance amount does not match counted cash");
    if (!approxEqual(Math.abs(signedAmount), sourceAmount)) issues.push("signed amount does not match counted cash");
    if (!issues.length) continue;

    const machine = relationRecord<{ name?: string | null; machine_code?: string | null }>(cash.machine);
    balanceInconsistencies.push({
      sourceType: "cash_collection",
      sourceId: cash.id,
      financeTransactionId: row.id,
      sourceAmount,
      financeAmount,
      direction: row.direction,
      signedAmount,
      transactionEffect: row.transaction_effect,
      issue: issues.join("; "),
      label: formatMachineDisplayName(machine as any, { includeArea: true }),
      transactionDate: textValue(row.transaction_date),
    });
  }

  const missingCategories = recentFinanceRows
    .filter((row) => !textValue(row.category) || !textValue(row.final_bucket) || !textValue(row.transaction_type))
    .slice(0, 50)
    .map((row) => ({
      financeTransactionId: row.id,
      sourceType: textValue(row.source_type),
      description: textValue(row.description),
      category: financeCategoryLabel(row),
      transactionType: textValue(row.transaction_type),
      finalBucket: textValue(row.final_bucket),
      transactionDate: textValue(row.transaction_date),
    }));

  const ignoredSourceRows = sourceFinanceRows
    .filter((row) => financeRowSourceType(row) && ["ignored", "skipped"].includes(String(row.import_status ?? "").trim()))
    .slice(0, 50)
    .map((row) => ({
      financeTransactionId: row.id,
      sourceType: financeRowSourceType(row)!,
      sourceId: textValue(row.source_id),
      importStatus: textValue(row.import_status),
      description: textValue(row.description),
      transactionDate: textValue(row.transaction_date),
    }));

  return {
    purchasesMissingFinance,
    cashCollectionsMissingFinance,
    brokenLinks: Array.from(brokenLinkMap.values()).slice(0, 50),
    balanceInconsistencies: balanceInconsistencies.slice(0, 50),
    missingCategories,
    ignoredSourceRows,
    errors,
  };
}
