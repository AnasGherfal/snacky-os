type PickupProductRow = {
  productName: string;
  productCategory?: string | null;
  stopOrder?: number | null;
};

const MR_CRUNCH_ALIASES = ["mr crunch", "mr. crunch", "mr crunch tarboosh", "mr crunch tarboush", "tarboosh", "tarboush", "tarboouch", "طربوش"];
const DORITOS_ALIASES = ["doritos", "doritos green hot", "doritos nacho", "دوريتوس"];
const WATER_KEYWORDS = ["water", "mineral water", "sparkling water"];
const CHIPS_KEYWORDS = ["chips", "chip", "crisps"];
const CHOCOLATE_KEYWORDS = ["chocolate", "choco"];
const CANDY_KEYWORDS = ["candy", "gum", "lollipop", "bonbon"];
const DRINK_KEYWORDS = ["drink", "juice", "cola", "soda", "energy", "tea", "coffee"];

function normalizedText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function matchesAlias(name: string, aliases: string[]) {
  const normalizedName = normalizedText(name);
  return aliases.some((alias) => normalizedName.includes(normalizedText(alias)));
}

function inferredCategory(productName: string, productCategory?: string | null) {
  const normalizedCategory = normalizedText(productCategory);
  const normalizedName = normalizedText(productName);

  if (normalizedCategory.includes("water") || WATER_KEYWORDS.some((keyword) => normalizedName.includes(keyword))) return "water";
  if (matchesAlias(productName, MR_CRUNCH_ALIASES) || matchesAlias(productName, DORITOS_ALIASES)) return "chips";
  if (normalizedCategory.includes("chip") || CHIPS_KEYWORDS.some((keyword) => normalizedName.includes(keyword))) return "chips";
  if (normalizedCategory.includes("chocolate") || CHOCOLATE_KEYWORDS.some((keyword) => normalizedName.includes(keyword))) return "chocolates";
  if (normalizedCategory.includes("candy") || normalizedCategory.includes("sweet") || CANDY_KEYWORDS.some((keyword) => normalizedName.includes(keyword))) return "candy";
  if (normalizedCategory.includes("drink") || normalizedCategory.includes("beverage") || DRINK_KEYWORDS.some((keyword) => normalizedName.includes(keyword))) return "drinks";
  return "other";
}

function categoryRank(productName: string, productCategory?: string | null) {
  const category = inferredCategory(productName, productCategory);
  if (category === "chips") return 1;
  if (category === "chocolates") return 2;
  if (category === "candy") return 3;
  if (category === "drinks") return 4;
  if (category === "other") return 5;
  return 6;
}

export function pickupProductPriorityGroup(productName: string) {
  if (matchesAlias(productName, MR_CRUNCH_ALIASES)) return 1;
  if (matchesAlias(productName, DORITOS_ALIASES)) return 2;
  return 3;
}

export function comparePickupProductRows<T extends PickupProductRow>(a: T, b: T) {
  const categoryDifference = categoryRank(a.productName, a.productCategory) - categoryRank(b.productName, b.productCategory);
  if (categoryDifference) return categoryDifference;

  const featuredDifference = pickupProductPriorityGroup(a.productName) - pickupProductPriorityGroup(b.productName);
  if (featuredDifference) return featuredDifference;

  const nameDifference = a.productName.localeCompare(b.productName);
  if (nameDifference) return nameDifference;

  return Number(a.stopOrder ?? 9999) - Number(b.stopOrder ?? 9999);
}

export function sortPickupProductRows<T extends PickupProductRow>(rows: T[]) {
  return [...rows].sort(comparePickupProductRows);
}
