/**
 * Shared validation for the owner-only bulk distance-entry form.
 * Missing/blank entries deliberately stay unknown. A user-entered 0 is valid.
 */
export type MissingDistanceInputLink = {
  fromKind: "storage" | "machine";
  fromId: string | null;
  toId: string | null;
};

export type ParsedDistanceEntry = {
  fromKind: "storage" | "machine";
  fromId: string;
  toId: string;
  km: number;
};

export function missingDistanceFieldName(link: MissingDistanceInputLink) {
  return `distance:${link.fromKind}:${link.fromId ?? ""}:${link.toId ?? ""}`;
}

export function parseBulkMissingDistances(
  form: FormData,
  missingLinks: readonly MissingDistanceInputLink[],
): ParsedDistanceEntry[] {
  const allowed = new Map(
    missingLinks
      .filter((link) => Boolean(link.fromId && link.toId))
      .map((link) => [missingDistanceFieldName(link), link]),
  );
  const entries: ParsedDistanceEntry[] = [];
  const seen = new Set<string>();

  for (const [key, value] of form.entries()) {
    if (!key.startsWith("distance:")) continue;
    if (seen.has(key)) throw new Error("Duplicate distance field detected.");
    seen.add(key);
    const link = allowed.get(key);
    if (!link || !link.fromId || !link.toId) {
      throw new Error("A route connection has changed. Reload the form before saving.");
    }
    if (typeof value !== "string") throw new Error("Distance must be a number.");
    const raw = value.trim();
    if (!raw) continue; // Not entered: leave unknown. Do NOT convert blank to 0.
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      throw new Error("Enter kilometers as a non-negative number (maximum two decimal places).");
    }
    const km = Number(raw);
    if (!Number.isFinite(km) || km >= 10000) {
      throw new Error("Distance must be less than 10,000 km.");
    }
    if (link.fromKind === "machine" && link.fromId === link.toId) {
      throw new Error("Starting and destination machines must be different.");
    }
    entries.push({
      fromKind: link.fromKind,
      fromId: link.fromId,
      toId: link.toId,
      km,
    });
  }
  return entries;
}
