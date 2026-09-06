const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OPERATOR_MONEY_RECEIPT_ACTIONS = [
  "purchase",
  "expense",
  "advance",
  "debtPayment",
  "advanceReturn",
  "reimbursement",
] as const;

export type OperatorMoneyReceiptAction = (typeof OPERATOR_MONEY_RECEIPT_ACTIONS)[number];

type OperationStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export function isOperatorMoneyReceiptAction(value: string): value is OperatorMoneyReceiptAction {
  return (OPERATOR_MONEY_RECEIPT_ACTIONS as readonly string[]).includes(value);
}

export function isOperatorMoneyOperationId(value: unknown): value is string {
  return UUID_PATTERN.test(String(value ?? "").trim());
}

export function operatorMoneyOperationStorageKey({
  action,
  personId,
  periodId,
}: {
  action: OperatorMoneyReceiptAction;
  personId: string;
  periodId?: string;
}) {
  const personScope = encodeURIComponent(personId.trim() || "unlinked");
  const periodScope = encodeURIComponent(periodId?.trim() || "legacy");
  return `snacky:operator-money-operation:v1:${personScope}:${periodScope}:${action}`;
}

function createOperationId(createId: () => string) {
  const created = createId();
  if (!isOperatorMoneyOperationId(created)) {
    throw new Error("Could not prepare a safe money-operation receipt.");
  }
  return created;
}

export function getOrCreateOperatorMoneyOperationId({
  storage,
  action,
  personId,
  periodId,
  createId,
}: {
  storage: OperationStorage;
  action: OperatorMoneyReceiptAction;
  personId: string;
  periodId?: string;
  createId: () => string;
}) {
  const storageKey = operatorMoneyOperationStorageKey({ action, personId, periodId });
  const stored = storage.getItem(storageKey);
  const operationId = isOperatorMoneyOperationId(stored)
    ? stored.trim()
    : createOperationId(createId);

  // Persist before the request is sent. If storage is unavailable, the caller
  // must fail closed instead of creating a command that cannot survive reload.
  storage.setItem(storageKey, operationId);
  return { storageKey, operationId };
}

export function rotateOperatorMoneyOperationId({
  storage,
  storageKey,
  completedOperationId,
  createId,
}: {
  storage: OperationStorage;
  storageKey: string;
  completedOperationId: string;
  createId: () => string;
}) {
  const stored = storage.getItem(storageKey);
  if (stored !== completedOperationId) {
    return { operationId: stored ?? "", rotated: false };
  }

  const nextOperationId = createOperationId(createId);
  storage.setItem(storageKey, nextOperationId);
  return { operationId: nextOperationId, rotated: true };
}
