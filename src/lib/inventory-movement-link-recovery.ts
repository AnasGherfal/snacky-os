export const CANONICAL_INVENTORY_MOVEMENT_RECOVERY_SELECT = "id, idempotency_key, source_type, source_id, reason, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, related_route_id, related_route_stop_id, related_machine_id, created_by" as const;

export type CanonicalInventoryMovementExpectation = {
  idempotency_key: string;
  source_type: string;
  source_id: string;
  reason: string;
  product_id: string;
  quantity: number;
  from_entity_type: string;
  from_entity_id: string | null;
  to_entity_type: string;
  to_entity_id: string | null;
  related_route_id: string;
  related_route_stop_id: string;
  related_machine_id: string;
  created_by: string | null;
};

export type CanonicalInventoryMovementCandidate = Partial<Record<keyof CanonicalInventoryMovementExpectation, unknown>> & {
  id?: unknown;
};

export type CanonicalInventoryMovementResolution =
  | { status: "missing" }
  | { status: "canonical"; movementId: string }
  | { status: "ambiguous"; candidateCount: number }
  | { status: "mismatch"; mismatchedFields: string[] };

export class InventoryMovementRecoveryConflictError extends Error {
  readonly code = "INVENTORY_MOVEMENT_RECOVERY_CONFLICT";
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = "InventoryMovementRecoveryConflictError";
    this.details = details;
  }
}

const TEXT_FIELDS = [
  "idempotency_key",
  "source_type",
  "source_id",
  "reason",
  "product_id",
  "from_entity_type",
  "from_entity_id",
  "to_entity_type",
  "to_entity_id",
  "related_route_id",
  "related_route_stop_id",
  "related_machine_id",
  "created_by",
] as const satisfies readonly (keyof CanonicalInventoryMovementExpectation)[];

function exactText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value;
}

function exactInteger(value: unknown) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Resolves only an already-committed movement. It never creates a movement or
 * guesses between candidates, which keeps parent-link repair bounded and safe.
 */
export function resolveCanonicalInventoryMovement(
  candidates: readonly CanonicalInventoryMovementCandidate[] | null | undefined,
  expected: CanonicalInventoryMovementExpectation,
): CanonicalInventoryMovementResolution {
  if (!candidates?.length) return { status: "missing" };
  if (candidates.length !== 1) return { status: "ambiguous", candidateCount: candidates.length };

  const candidate = candidates[0];
  const mismatchedFields: string[] = [];
  const movementId = exactText(candidate.id);
  if (!movementId) mismatchedFields.push("id");

  for (const field of TEXT_FIELDS) {
    if (exactText(candidate[field]) !== expected[field]) mismatchedFields.push(field);
  }
  if (exactInteger(candidate.quantity) !== expected.quantity) mismatchedFields.push("quantity");

  if (mismatchedFields.length) return { status: "mismatch", mismatchedFields };
  return { status: "canonical", movementId: movementId as string };
}
