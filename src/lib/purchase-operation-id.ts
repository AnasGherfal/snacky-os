const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPurchaseOperationId(value: unknown): value is string {
  return UUID_PATTERN.test(String(value ?? "").trim());
}

export function purchaseOperationStorageKey(purchaseId: string, operation: string) {
  return `snacky:purchase-operation:v1:${purchaseId}:${operation}`;
}

export function resolvePurchaseOperationId({
  storedId,
  initialId,
  confirmedId,
  createId,
}: {
  storedId: unknown;
  initialId: unknown;
  confirmedId?: unknown;
  createId: () => string;
}) {
  const stored = isPurchaseOperationId(storedId) ? String(storedId).trim() : "";
  const initial = isPurchaseOperationId(initialId) ? String(initialId).trim() : "";
  let current = stored || initial;

  if (!current) {
    const created = createId();
    current = isPurchaseOperationId(created) ? created : "";
  }

  const confirmed = String(confirmedId ?? "").trim();
  if (current && confirmed === current) {
    const replacement = createId();
    return {
      id: isPurchaseOperationId(replacement) ? replacement : "",
      rotatedAfterSuccess: true,
    };
  }

  return { id: current, rotatedAfterSuccess: false };
}
