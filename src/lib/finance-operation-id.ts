const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isFinanceOperationId(value: unknown): value is string {
  return UUID_PATTERN.test(String(value ?? "").trim());
}

export function financeCreateOperationStorageKey(userId: string) {
  return `snacky:finance-operation:v1:${userId}:create`;
}

export function resolveFinanceCreateOperationId({
  storedId,
  initialId,
  createId,
}: {
  storedId: unknown;
  initialId: unknown;
  createId: () => string;
}) {
  const stored = isFinanceOperationId(storedId) ? String(storedId).trim() : "";
  const initial = isFinanceOperationId(initialId) ? String(initialId).trim() : "";
  if (stored) return stored;
  if (initial) return initial;
  const created = createId();
  return isFinanceOperationId(created) ? created : "";
}

export function confirmedFinanceCreateOperationId(error: unknown) {
  const digest = String((error as { digest?: unknown } | null)?.digest ?? "");
  if (!digest.startsWith("NEXT_REDIRECT")) return "";
  const target = digest.split(";")[2] ?? "";
  if (!target || target.includes("error=")) return "";
  try {
    const url = new URL(target, "https://snacky.local");
    const submissionId = url.searchParams.get("finance_submission_id") ?? "";
    return isFinanceOperationId(submissionId) ? submissionId : "";
  } catch {
    return "";
  }
}
