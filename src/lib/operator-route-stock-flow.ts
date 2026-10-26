/**
 * Read-only presentation of the EXISTING route picked-items endpoint.
 * This endpoint holds a canonical, signed bag snapshot plus an optional
 * descriptive inventory-movement summary. Never derive custody from
 * picked_qty - filled_qty, as sales, returns, damage, transfers and
 * corrections can change that balance independently.
 */
export type RouteFlowLine = {
  productId: string;
  productName: string;
  loadedQty: number;
  filledQty: number;
  returnedQty: number;
  damagedQty: number;
  soldQty: number;
  compensatedQty: number;
  machineStorageQty: number;
  machineReturnQty: number;
  adjustmentQty: number;
  remainingQty: number;
};

export type RouteMachineFillLine = {
  machineId: string;
  productId: string;
  productName: string;
  machineName: string | null;
  machineCode: string | null;
  locationName: string | null;
  filledQty: number;
};

export type RouteBagBalanceLine = {
  productId: string;
  productName: string;
  remainingQty: number; // signed, negative balances must remain visible
};

export type OperatorRouteStockFlow =
  | { state: "unverified"; reason: string }
  | {
      state: "balance_only" | "detailed";
      balances: RouteBagBalanceLine[];
      rows: RouteFlowLine[];
      machineFills: RouteMachineFillLine[] | null;
      totalLoaded: number | null;
      totalFilled: number | null;
      totalRemaining: number;
      hasNegativeBalance: boolean;
      custodyNeedsReview: boolean;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function units(value: unknown, signed = false): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!signed && number < 0)) return null;
  return number;
}

function label(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function makeBalanceOnly(
  balances: RouteBagBalanceLine[],
  custodyNeedsReview: boolean,
): OperatorRouteStockFlow {
  return {
    state: "balance_only",
    balances,
    rows: [],
    machineFills: null,
    totalLoaded: null,
    totalFilled: null,
    totalRemaining: balances.reduce((sum, row) => sum + row.remainingQty, 0),
    hasNegativeBalance: balances.some(row => row.remainingQty < 0),
    custodyNeedsReview,
  };
}

/**
 * A missing ledger token always fails closed, even if an old movement-based
 * fallback returns plausible balances. A descriptive-read failure may still
 * show canonical signed bag stock, but NOT zero picked or filled units.
 */
export function parseOperatorRouteStockFlow(raw: unknown): OperatorRouteStockFlow {
  const source = asRecord(raw);
  if (!source) return { state: "unverified", reason: "missing_response" };
  const token = label(source.ledgerToken);
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return { state: "unverified", reason: "canonical_bag_snapshot_unavailable" };
  }
  if (!Array.isArray(source.bagHistoryItems)) {
    return { state: "unverified", reason: "bag_history_missing" };
  }

  const balanceMap = new Map<string, RouteBagBalanceLine>();
  for (const entry of source.bagHistoryItems) {
    const row = asRecord(entry);
    const productId = label(row?.productId);
    const signedQuantity = units(row?.signedQuantity, true);
    if (!row || !productId || signedQuantity === null) {
      return { state: "unverified", reason: "invalid_bag_balance" };
    }
    const current = balanceMap.get(productId);
    balanceMap.set(productId, {
      productId,
      productName: label(row.productName) || current?.productName || productId,
      remainingQty: (current?.remainingQty ?? 0) + signedQuantity,
    });
  }
  const balances = Array.from(balanceMap.values())
    .sort((a,b) => a.productName.localeCompare(b.productName));
  if (balances.some(row => !Number.isSafeInteger(row.remainingQty))) {
    return { state: "unverified", reason: "bag_balance_overflow" };
  }
  const custodyNeedsReview = source.hasUnassignedCustody === true
    || source.requiresManagerReconciliation === true;

  if (source.descriptiveReconciliationAvailable !== true) {
    return makeBalanceOnly(balances, custodyNeedsReview);
  }
  if (!Array.isArray(source.reconciliation)) {
    return makeBalanceOnly(balances, custodyNeedsReview);
  }

  const rows: RouteFlowLine[] = [];
  const seen = new Set<string>();
  const nonnegativeFields = [
    "loadedQty", "filledQty", "returnedQty", "damagedQty",
    "soldQty", "compensatedQty", "machineStorageQty", "machineReturnQty",
  ] as const;
  for (const entry of source.reconciliation) {
    const row = asRecord(entry), productId = label(row?.productId);
    if (!row || !productId || seen.has(productId)) {
      return makeBalanceOnly(balances, custodyNeedsReview);
    }
    seen.add(productId);
    const parsed: Partial<RouteFlowLine> = {
      productId, productName: label(row.productName) || balanceMap.get(productId)?.productName || productId,
    };
    for (const field of nonnegativeFields) {
      const n = units(row[field]);
      if (n === null) return makeBalanceOnly(balances, custodyNeedsReview);
      parsed[field] = n;
    }
    const adj = units(row.adjustmentQty, true);
    const remaining = units(row.remainingQty, true);
    const canonical = balanceMap.get(productId)?.remainingQty ?? 0;
    if (adj === null || remaining === null || remaining !== canonical) {
      // The movement summary and canonical custody snapshot disagree.
      // Keep only the authoritative bag amount; never show a fake 0 filled.
      return makeBalanceOnly(balances, custodyNeedsReview);
    }
    rows.push({ ...parsed, adjustmentQty: adj, remainingQty: remaining } as RouteFlowLine);
  }
  // An authoritative positive/negative bag balance cannot disappear from the
  // movement list: show only bag counts until the source is reconciled.
  if (balances.some(b => b.remainingQty !== 0 && !seen.has(b.productId))) {
    return makeBalanceOnly(balances, custodyNeedsReview);
  }
  rows.sort((a,b) => a.productName.localeCompare(b.productName));
  const totalLoaded = rows.reduce((sum,row) => sum + row.loadedQty, 0);
  const totalFilled = rows.reduce((sum,row) => sum + row.filledQty, 0);
  if (!Number.isSafeInteger(totalLoaded) || !Number.isSafeInteger(totalFilled)) {
    return makeBalanceOnly(balances, custodyNeedsReview);
  }
  // The per-machine breakdown is verified only when its product totals
  // reconcile exactly to the existing route-level movement summary. A
  // malformed/older endpoint safely keeps route figures but hides machine
  // detail rather than inventing a machine assignment.
  let machineFills: RouteMachineFillLine[] | null = null;
  if (source.machineFillCoverageComplete === true && Array.isArray(source.machineFills)) {
    const parsedFills: RouteMachineFillLine[] = [];
    const usedKeys = new Set<string>();
    let valid = true;
    for (const entry of source.machineFills) {
      const machine = asRecord(entry);
      const machineId = label(machine?.machineId);
      const productId = label(machine?.productId);
      const filledQty = units(machine?.filledQty);
      const key = machineId + ":" + productId;
      if (!machine || !machineId || !productId || filledQty === null || filledQty <= 0 || usedKeys.has(key)) {
        valid = false; break;
      }
      usedKeys.add(key);
      parsedFills.push({
        machineId, productId, filledQty,
        productName: label(machine.productName) || productId,
        machineName: label(machine.machineName) || null,
        machineCode: label(machine.machineCode) || null,
        locationName: label(machine.locationName) || null,
      });
    }
    if (valid) {
      const totalByProduct = new Map<string, number>();
      parsedFills.forEach(fill => totalByProduct.set(fill.productId,
        (totalByProduct.get(fill.productId) ?? 0) + fill.filledQty));
      valid = [...totalByProduct.values()].every(Number.isSafeInteger)
        && rows.every(row => (totalByProduct.get(row.productId) ?? 0) === row.filledQty)
        && [...totalByProduct.keys()].every(id => rows.some(row => row.productId === id));
      if (valid) {
        machineFills = parsedFills.sort((a,b) =>
          (a.machineName || a.machineCode || a.machineId).localeCompare(b.machineName || b.machineCode || b.machineId)
          || a.productName.localeCompare(b.productName));
      }
    }
  }

  return {
    state: "detailed",
    balances,
    rows,
    machineFills,
    totalLoaded,
    totalFilled,
    totalRemaining: balances.reduce((sum,row) => sum + row.remainingQty, 0),
    hasNegativeBalance: balances.some(row => row.remainingQty < 0),
    custodyNeedsReview,
  };
}
