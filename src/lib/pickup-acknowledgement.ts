export type PickupLineRowLike = {
  route_stop_item_id?: unknown;
  is_checked?: unknown;
};

export type PickupAcknowledgementDiagnostics = {
  clientAcknowledgedPickupLineIds: string[];
  serverCanonicalAcknowledgedPickupLineIds: string[];
  checkedPickupLineIds: string[];
  requiredPickupLineIds: string[];
  missingRequiredPickupLineIds: string[];
  extraServerCanonicalPickupLineIds: string[];
  clientMissingFromCanonicalPickupLineIds: string[];
  clientExtraBeyondCanonicalPickupLineIds: string[];
};

export type PickupErrorLike = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

const PICKUP_ACKNOWLEDGEMENT_MISMATCH_TEXT = "pickup checklist acknowledgements do not match the submitted checked lines";

function normalizeComparableText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizePickupLineIds(values: Iterable<unknown> | null | undefined) {
  if (!values) return [];
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ).sort();
}

export function buildServerCanonicalAcknowledgedPickupLineIds(pickListRows: PickupLineRowLike[] | null | undefined) {
  return normalizePickupLineIds(
    (pickListRows ?? [])
      .filter((row) => Boolean(row?.route_stop_item_id) && Boolean(row?.is_checked))
      .map((row) => row.route_stop_item_id),
  );
}

export function buildPickupAcknowledgementDiagnostics({
  clientAcknowledgedPickupLineIds,
  pickListRows,
  requiredPickupLineIds,
}: {
  clientAcknowledgedPickupLineIds: unknown[];
  pickListRows: PickupLineRowLike[] | null | undefined;
  requiredPickupLineIds: unknown[];
}): PickupAcknowledgementDiagnostics {
  const clientIds = normalizePickupLineIds(clientAcknowledgedPickupLineIds);
  const serverCanonicalAcknowledgedPickupLineIds = buildServerCanonicalAcknowledgedPickupLineIds(pickListRows);
  const checkedPickupLineIds = serverCanonicalAcknowledgedPickupLineIds;
  const requiredIds = normalizePickupLineIds(requiredPickupLineIds);

  return {
    clientAcknowledgedPickupLineIds: clientIds,
    serverCanonicalAcknowledgedPickupLineIds,
    checkedPickupLineIds,
    requiredPickupLineIds: requiredIds,
    missingRequiredPickupLineIds: requiredIds.filter((id) => !serverCanonicalAcknowledgedPickupLineIds.includes(id)),
    extraServerCanonicalPickupLineIds: serverCanonicalAcknowledgedPickupLineIds.filter((id) => !requiredIds.includes(id)),
    clientMissingFromCanonicalPickupLineIds: serverCanonicalAcknowledgedPickupLineIds.filter((id) => !clientIds.includes(id)),
    clientExtraBeyondCanonicalPickupLineIds: clientIds.filter((id) => !serverCanonicalAcknowledgedPickupLineIds.includes(id)),
  };
}

export function isExactPickupAcknowledgementMismatchError(error: PickupErrorLike | unknown) {
  if (!error || typeof error !== "object") {
    return normalizeComparableText(error) === PICKUP_ACKNOWLEDGEMENT_MISMATCH_TEXT;
  }

  const row = error as PickupErrorLike;
  return [row.code, row.message, row.details, row.hint].some((value) => normalizeComparableText(value) === PICKUP_ACKNOWLEDGEMENT_MISMATCH_TEXT);
}
