export type PhotoCandidate = {
  id: string;
  name: string;
  vmsProductId: string;
};

export type PhotoSlot = {
  slotCode: string;
  currentProductId: string | null;
  currentVmsProductId: string | null;
  currentQty: number | null;
  capacity: number | null;
};

export type PhotoObservation = {
  slotCode: string;
  productId: string;
  confidence: "high" | "medium" | "low";
  visualEvidence: string;
};

export type PhotoSuggestion = PhotoObservation & {
  productName: string;
  currentProductId: string | null;
  currentQty: number | null;
  capacity: number | null;
  differentFromXy: boolean;
};

const clean = (value: unknown) => String(value ?? "").trim();

export function selectPhotoSuggestions(
  observations: unknown,
  slots: PhotoSlot[],
  candidates: PhotoCandidate[],
): {
  suggestions: PhotoSuggestion[];
  unreadableSlots: string[];
  rejectedObservations: number;
} {
  const slotMap = new Map(slots.map((slot) => [slot.slotCode, slot]));
  const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const suggestions: PhotoSuggestion[] = [];
  let rejectedObservations = 0;

  for (const raw of Array.isArray(observations) ? observations.slice(0, 160) : []) {
    if (!raw || typeof raw !== "object") { rejectedObservations++; continue; }
    const observation = raw as Record<string, unknown>;
    const slotCode = clean(observation.slotCode);
    const productId = clean(observation.productId);
    const confidence = clean(observation.confidence);
    const slot = slotMap.get(slotCode);
    const candidate = candidateMap.get(productId);
    if (!slot || seen.has(slotCode) || !candidate
      || !["high", "medium", "low"].includes(confidence)
      || !clean(observation.visualEvidence)) {
      rejectedObservations++;
      continue;
    }
    seen.add(slotCode);
    suggestions.push({
      slotCode,
      productId,
      confidence: confidence as PhotoObservation["confidence"],
      visualEvidence: clean(observation.visualEvidence).slice(0, 180),
      productName: candidate.name,
      currentProductId: slot.currentProductId,
      currentQty: slot.currentQty,
      capacity: slot.capacity,
      differentFromXy: slot.currentProductId
        ? slot.currentProductId !== candidate.id
        : candidate.vmsProductId !== slot.currentVmsProductId,
    });
  }
  suggestions.sort((a, b) => a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true }));
  return {
    suggestions,
    unreadableSlots: slots.filter((slot) => !seen.has(slot.slotCode)).map((slot) => slot.slotCode),
    rejectedObservations,
  };
}

/** All AI output is advisory: it cannot be a direct XY write payload. */
export function canApplyPhotoChange(args: {
  suggestion: PhotoSuggestion;
  actualQty: number | null;
  operatorReviewed: boolean;
  oldProductAccounted: boolean;
}) {
  const { suggestion, actualQty, operatorReviewed, oldProductAccounted } = args;
  return suggestion.differentFromXy
    && operatorReviewed
    && oldProductAccounted
    && Number.isSafeInteger(actualQty)
    && actualQty !== null
    && actualQty > 0
    && suggestion.capacity !== null
    && actualQty <= suggestion.capacity;
}

export const PHOTO_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "photoQuality"],
  properties: {
    photoQuality: { type: "string", enum: ["good", "partial", "unreadable"] },
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slotCode", "productId", "confidence", "visualEvidence"],
        properties: {
          slotCode: { type: "string" },
          productId: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          visualEvidence: { type: "string" },
        },
      },
    },
  },
} as const;
