/**
 * Presentation-only end-of-route physical count readiness.
 * Ledger-proposed quantities are NOT proof of a physical count.
 * Authoritative validation and all inventory writes remain in finalizeRouteInventory.
 */
export type ReturnReadinessLine = {
  key: string;
  ledgerQty: number;
  enteredQty: number;
  confirmed: boolean;
};

export type ReturnReadinessInput = {
  rows: readonly ReturnReadinessLine[];
  emptyBagConfirmed: boolean;
  reconciliationReason: string;
  cancellationReason: string;
  cancelMode: boolean;
  storageLocationId: string;
  storageLocationCount: number;
  pendingDraft: boolean;
  inventoryFinalizationAvailable: boolean;
};

export type ReturnReadinessStep = {
  kind: "count" | "empty_bag" | "return_destination" | "variance_reason" | "cancel_reason";
  anchor: string;
};

function safeUnits(n: number) {
  return Number.isSafeInteger(n) && n >= 0;
}

export function operatorReturnReadiness(input: ReturnReadinessInput) {
  const countTotal = input.rows.length;
  const invalidValues = input.rows.some(row =>
    !row.key || !safeUnits(row.ledgerQty) && !Number.isSafeInteger(row.ledgerQty)
    || !safeUnits(row.enteredQty),
  );
  const confirmedRows = input.rows.filter(row => row.confirmed && safeUnits(row.enteredQty));
  const enteredTotal = input.rows.reduce((sum, row) => sum + (safeUnits(row.enteredQty) ? row.enteredQty : 0), 0);
  const confirmedTotal = confirmedRows.reduce((sum, row) => sum + row.enteredQty, 0);
  const allCountsConfirmed = countTotal > 0 && confirmedRows.length === countTotal && !invalidValues;
  // Variance is provisional until the real physical count is confirmed.
  const possibleVariance = input.rows.some(row => row.enteredQty !== row.ledgerQty);
  const needsStorage = enteredTotal > 0 && (input.storageLocationCount === 0
    || (input.storageLocationCount > 1 && !input.storageLocationId.trim()));
  const needsReason = possibleVariance && !input.reconciliationReason.trim();
  const needsCancelReason = input.cancelMode && !input.cancellationReason.trim();
  const needsEmptyBag = countTotal === 0 && !input.emptyBagConfirmed;

  const steps: ReturnReadinessStep[] = [];
  const firstMissing = input.rows.findIndex(row => !row.confirmed || !safeUnits(row.enteredQty));
  if (countTotal > 0 && (firstMissing >= 0 || invalidValues)) {
    steps.push({ kind: "count", anchor: `bag-count-${Math.max(0,firstMissing)}` });
  }
  if (needsEmptyBag) steps.push({ kind: "empty_bag", anchor: "bag-empty-confirmation" });
  if (needsStorage) steps.push({ kind: "return_destination", anchor: "return-storage-location" });
  if (needsReason) steps.push({ kind: "variance_reason", anchor: "return-variance-reason" });
  if (needsCancelReason) steps.push({ kind: "cancel_reason", anchor: "route-cancellation-reason" });

  const safeTotal = Number.isSafeInteger(enteredTotal) && Number.isSafeInteger(confirmedTotal);
  return {
    countTotal,
    countConfirmed: confirmedRows.length,
    countRemaining: countTotal - confirmedRows.length,
    enteredTotal: safeTotal ? enteredTotal : null,
    confirmedTotal: safeTotal ? confirmedTotal : null,
    possibleVariance,
    physicalCountComplete: countTotal === 0 ? input.emptyBagConfirmed : allCountsConfirmed,
    steps,
    nextStep: steps[0] ?? null,
    canSubmit: !invalidValues && safeTotal
      && (countTotal === 0 ? input.emptyBagConfirmed : allCountsConfirmed)
      && steps.length === 0
      && input.inventoryFinalizationAvailable
      && !input.pendingDraft,
  };
}
