export type ProductPackaging = {
  caseQuantity?: number | string | null;
  productName?: string | null;
  category?: string | null;
};

export type PackagedQuantity = {
  totalUnits: number;
  caseQuantity: number;
  boxes: number;
  looseUnits: number;
  caseLabel: string;
  unitLabel: string;
};

function wholeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function normalizeCaseQuantity(value: unknown) {
  return Math.max(1, wholeNumber(value, 1));
}

function normalizedProductText(packaging: ProductPackaging) {
  return `${packaging.productName ?? ""} ${packaging.category ?? ""}`.trim().toLowerCase();
}

export function inferProductUnitLabel(packaging: ProductPackaging) {
  const text = normalizedProductText(packaging);
  if (["water", "مياه", "مية", "ميه"].some((token) => text.includes(token))) return "bottle";
  if (["drink", "beverage", "pepsi", "cola", "juice", "soda", "شويبس", "مراعي"].some((token) => text.includes(token))) return "can";
  if (["chips", "snack", "chocolate", "biscuit", "candy", "doritos", "galaxy", "snickers", "twix", "طربوش"].some((token) => text.includes(token))) return "piece";
  return "unit";
}

function pluralize(label: string, count: number) {
  if (count === 1) return label;
  if (label === "box") return "boxes";
  if (label.endsWith("s")) return label;
  return `${label}s`;
}

export function splitProductQuantity(quantity: unknown, packaging: ProductPackaging = {}): PackagedQuantity {
  const totalUnits = wholeNumber(quantity);
  const caseQuantity = normalizeCaseQuantity(packaging.caseQuantity);
  const boxes = caseQuantity > 1 ? Math.floor(totalUnits / caseQuantity) : 0;
  const looseUnits = caseQuantity > 1 ? totalUnits % caseQuantity : totalUnits;
  return {
    totalUnits,
    caseQuantity,
    boxes,
    looseUnits,
    caseLabel: "box",
    unitLabel: inferProductUnitLabel(packaging),
  };
}

export function formatProductQuantity(
  quantity: unknown,
  packaging: ProductPackaging = {},
  options: { includeTotal?: boolean; compact?: boolean } = {},
) {
  const { includeTotal = true, compact = false } = options;
  const value = splitProductQuantity(quantity, packaging);

  if (value.caseQuantity <= 1) {
    return `${value.totalUnits.toLocaleString("en-US")} ${pluralize(value.unitLabel, value.totalUnits)}`;
  }

  const parts: string[] = [];
  if (value.boxes > 0) parts.push(`${value.boxes.toLocaleString("en-US")} ${pluralize(value.caseLabel, value.boxes)}`);
  if (value.looseUnits > 0 || value.boxes === 0) parts.push(`${value.looseUnits.toLocaleString("en-US")} ${pluralize(value.unitLabel, value.looseUnits)}`);

  const base = parts.join(compact ? " + " : " and ");
  if (!includeTotal || value.boxes === 0) return base;
  return `${base} (${value.totalUnits.toLocaleString("en-US")} total)`;
}

export function roundUnitsUpToCase(quantity: unknown, caseQuantity: unknown) {
  const units = wholeNumber(quantity);
  const perCase = normalizeCaseQuantity(caseQuantity);
  if (units <= 0) return 0;
  if (perCase <= 1) return units;
  return Math.ceil(units / perCase) * perCase;
}
