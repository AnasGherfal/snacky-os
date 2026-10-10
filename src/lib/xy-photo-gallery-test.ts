/** Photo-library QA helpers. Visual positions do not imply real XY lane codes. */
export type GalleryObservation = {
  rowNumber: number;
  positionNumber: number;
  productId: string;
  confidence: "high" | "medium" | "low";
  visualEvidence: string;
};
export type GalleryResult = GalleryObservation & { productName: string };

export const GALLERY_PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["photoQuality", "observations"],
  properties: {
    photoQuality: { type: "string", enum: ["good", "partial", "unreadable"] },
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rowNumber", "positionNumber", "productId", "confidence", "visualEvidence"],
        properties: {
          rowNumber: { type: "integer" },
          positionNumber: { type: "integer" },
          productId: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          visualEvidence: { type: "string" },
        },
      },
    },
  },
} as const;

export function validateGalleryObservations(
  raw: unknown,
  allowedProducts: ReadonlyMap<string, string>,
): { observations: GalleryResult[]; rejected: number } {
  if (!Array.isArray(raw)) return { observations: [], rejected: 0 };
  const observations: GalleryResult[] = [];
  const occupiedPositions = new Set<string>();
  let rejected = 0;

  for (const value of raw.slice(0, 120)) {
    if (!value || typeof value !== "object") { rejected++; continue; }
    const record = value as Record<string, unknown>;
    const rowNumber = record.rowNumber;
    const positionNumber = record.positionNumber;
    const productId = String(record.productId ?? "");
    const confidence = String(record.confidence ?? "");
    const evidence = String(record.visualEvidence ?? "").trim();
    if (typeof rowNumber !== "number" || !Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > 12
      || typeof positionNumber !== "number" || !Number.isSafeInteger(positionNumber) || positionNumber < 1 || positionNumber > 16
      || !allowedProducts.has(productId)
      || !["high", "medium", "low"].includes(confidence)
      || evidence.length < 3) {
      rejected++;
      continue;
    }
    const positionKey = `${rowNumber}:${positionNumber}`;
    if (occupiedPositions.has(positionKey)) { rejected++; continue; }
    occupiedPositions.add(positionKey);
    observations.push({
      rowNumber, positionNumber, productId,
      productName: allowedProducts.get(productId)!,
      confidence: confidence as GalleryObservation["confidence"],
      visualEvidence: evidence.slice(0, 160),
    });
  }

  observations.sort((a, b) => a.rowNumber - b.rowNumber || a.positionNumber - b.positionNumber);
  return { observations, rejected };
}

export const GALLERY_PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const GALLERY_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
