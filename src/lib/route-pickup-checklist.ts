type PickupProductRow = {
  productName: string;
  productCategory?: string | null;
  productBrand?: string | null;
  sortKey?: string | number | null;
};

export type RouteDisplayItem = {
  productName: string;
  productCategory?: string | null;
  productBrand?: string | null;
  quantity?: number;
  checked?: boolean;
  sortKey?: string | number | null;
};

export type RouteDisplayGroup<T extends RouteDisplayItem = RouteDisplayItem> = {
  groupKey: RouteProductGroupKey;
  groupLabel: string;
  items: T[];
  totalQuantity: number;
  checkedCount: number;
  itemCount: number;
  defaultExpanded: boolean;
};

type RouteProductGroupKey =
  | "chips"
  | "chocolates"
  | "rolls_bakery"
  | "almarai_dairy"
  | "candy"
  | "drinks"
  | "water"
  | "other";

const GROUP_ORDER: RouteProductGroupKey[] = [
  "chips",
  "drinks",
  "chocolates",
  "candy",
  "rolls_bakery",
  "almarai_dairy",
  "other",
  "water",
];

const GROUP_LABELS: Record<RouteProductGroupKey, string> = {
  chips: "Chips",
  chocolates: "Chocolates",
  rolls_bakery: "Rolls / bakery",
  almarai_dairy: "Almarai / dairy",
  candy: "Candy / sweets",
  drinks: "Drinks",
  water: "Water",
  other: "Other",
};

const FEATURED_GROUPS = new Set<RouteProductGroupKey>(["chips", "drinks", "chocolates", "candy", "water"]);

const MR_CRUNCH_ALIASES = ["mr crunch", "mr. crunch", "mrcrunch", "mr crunch tarboosh", "mr crunch tarboush", "tarboosh", "tarboush", "tarboouch", "طرْبوش", "طربوش"];
const DORITOS_ALIASES = ["doritos", "doritos green hot", "doritos nacho", "دوريتوس"];
const SPUDS_ALIASES = ["spuds"];
const CHIPS_KEYWORDS = ["chips", "chip", "crisps", "شيبس", "رقائق"];

const LUPPO_ALIASES = ["luppo", "lupo"];
const LAVIVA_ALIASES = ["laviva"];
const MALTESERS_ALIASES = ["maltesers", "malteser"];
const ROLL_ALIASES = ["wafer roll", "roll", "rolls", "رول"];
const KINDER_ALIASES = ["kinder"];
const SAID_ALIASES = ["said"];
const MAESTRO_ALIASES = ["maestro"];
const MILKA_ALIASES = ["milka"];
const GARDENA_ALIASES = ["gardena"];
const GALAXY_ALIASES = ["galaxy"];
const SNICKERS_ALIASES = ["snickers"];
const TWIX_ALIASES = ["twix"];
const CHOCOLATE_KEYWORDS = ["chocolate", "choco", "cocoa", "شوكولاتة"];

const BAKERY_KEYWORDS = ["brioche", "croissant", "cake", "bakery", "bread", "pastry", "toast", "بريوش", "كرواسون", "كيك", "خبز"];
const ALMARAI_KEYWORDS = ["almarai", "المرعي", "مراعى", "milk", "dairy", "yogurt", "yoghurt", "laban", "حليب", "لبن"];
const ALMARAI_FEATURED_ALIASES = ["almarai chocolate", "almarai strawberry"];

const CANDY_KEYWORDS = ["candy", "sweet", "sweets", "jelly", "gum", "gummy", "gummies", "lollipop", "lollipops", "bonbon", "حلوى", "جيلي", "مصاصة", "علكة"];
const BEBETO_ALIASES = ["bebeto"];

const DRINK_KEYWORDS = ["drink", "juice", "cola", "soda", "energy", "tea", "coffee", "beverage", "pepsi", "schweppes", "vitrac", "mr power", "exar", "مشروب", "عصير"];
const PEPSI_ALIASES = ["pepsi"];
const SCHWEPPES_ALIASES = ["schweppes"];
const VITRAC_ALIASES = ["vitrac"];
const MR_POWER_ALIASES = ["mr power", "mr. power"];
const EXAR_ALIASES = ["exar"];
const XIR_ALIASES = ["x!r", "x r", "xr"];

const WATER_KEYWORDS = ["water", "mineral water", "sparkling water", "ماء", "مياه"];

function normalizedText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizedSortKey(value: string | number | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function includesAny(text: string, aliases: string[]) {
  return aliases.some((alias) => text.includes(normalizedText(alias)));
}

function groupKeyForProduct(productName: string, productCategory?: string | null, productBrand?: string | null): RouteProductGroupKey {
  const text = normalizedText(`${productName} ${productCategory ?? ""} ${productBrand ?? ""}`);

  if (includesAny(text, WATER_KEYWORDS)) return "water";
  if (
    includesAny(text, MR_CRUNCH_ALIASES)
    || includesAny(text, DORITOS_ALIASES)
    || includesAny(text, SPUDS_ALIASES)
    || includesAny(text, CHIPS_KEYWORDS)
  ) return "chips";
  if (
    includesAny(text, LUPPO_ALIASES)
    || includesAny(text, LAVIVA_ALIASES)
    || includesAny(text, MALTESERS_ALIASES)
    || includesAny(text, ROLL_ALIASES)
    || includesAny(text, KINDER_ALIASES)
    || includesAny(text, SAID_ALIASES)
    || includesAny(text, MAESTRO_ALIASES)
    || includesAny(text, MILKA_ALIASES)
    || includesAny(text, GARDENA_ALIASES)
    || includesAny(text, GALAXY_ALIASES)
    || includesAny(text, SNICKERS_ALIASES)
    || includesAny(text, TWIX_ALIASES)
    || includesAny(text, CHOCOLATE_KEYWORDS)
  ) return "chocolates";
  if (includesAny(text, BEBETO_ALIASES) || includesAny(text, CANDY_KEYWORDS)) return "candy";
  if (
    includesAny(text, PEPSI_ALIASES)
    || includesAny(text, SCHWEPPES_ALIASES)
    || includesAny(text, VITRAC_ALIASES)
    || includesAny(text, MR_POWER_ALIASES)
    || includesAny(text, EXAR_ALIASES)
    || includesAny(text, XIR_ALIASES)
    || includesAny(text, DRINK_KEYWORDS)
  ) return "drinks";
  if (includesAny(text, ALMARAI_FEATURED_ALIASES) || includesAny(text, ALMARAI_KEYWORDS)) return "almarai_dairy";
  if (includesAny(text, BAKERY_KEYWORDS)) return "rolls_bakery";
  return "other";
}

function groupRank(groupKey: RouteProductGroupKey) {
  return GROUP_ORDER.indexOf(groupKey);
}

function featureRank(productName: string, productCategory?: string | null, productBrand?: string | null) {
  const groupKey = groupKeyForProduct(productName, productCategory, productBrand);
  const text = normalizedText(`${productName} ${productCategory ?? ""} ${productBrand ?? ""}`);

  if (groupKey === "chips") {
    if (includesAny(text, MR_CRUNCH_ALIASES)) return 0;
    if (includesAny(text, DORITOS_ALIASES)) return 1;
    if (includesAny(text, SPUDS_ALIASES)) return 2;
    return 3;
  }
  if (groupKey === "drinks") {
    if (includesAny(text, PEPSI_ALIASES)) return 0;
    if (includesAny(text, SCHWEPPES_ALIASES)) return 1;
    if (includesAny(text, VITRAC_ALIASES)) return 2;
    if (includesAny(text, MR_POWER_ALIASES)) return 3;
    if (includesAny(text, XIR_ALIASES)) return 4;
    if (includesAny(text, EXAR_ALIASES)) return 5;
    return 6;
  }
  if (groupKey === "chocolates") {
    if (includesAny(text, LUPPO_ALIASES)) return 0;
    if (includesAny(text, LAVIVA_ALIASES)) return 1;
    if (includesAny(text, MALTESERS_ALIASES)) return 2;
    if (includesAny(text, ROLL_ALIASES)) return 3;
    if (includesAny(text, KINDER_ALIASES)) return 4;
    if (includesAny(text, SAID_ALIASES)) return 5;
    if (includesAny(text, MAESTRO_ALIASES)) return 6;
    if (includesAny(text, MILKA_ALIASES)) return 7;
    if (includesAny(text, GARDENA_ALIASES)) return 8;
    return 9;
  }
  if (groupKey === "candy") {
    if (includesAny(text, BEBETO_ALIASES)) return 0;
    if (text.includes("jelly") || text.includes("gummy") || text.includes("gummies") || text.includes("جيلي")) return 1;
    if (text.includes("lollipop") || text.includes("مصاصة")) return 2;
    return 3;
  }
  if (groupKey === "rolls_bakery") {
    if (text.includes("brioche")) return 0;
    if (text.includes("croissant") || text.includes("كرواسون")) return 1;
    if (text.includes("cake") || text.includes("كيك")) return 2;
    return 3;
  }
  if (groupKey === "almarai_dairy") {
    if (text.includes("almarai chocolate")) return 0;
    if (text.includes("almarai strawberry")) return 1;
    if (text.includes("almarai") || text.includes("milk") || text.includes("dairy") || text.includes("yogurt") || text.includes("yoghurt") || text.includes("laban") || text.includes("حليب") || text.includes("لبن")) return 2;
    return 3;
  }
  if (groupKey === "water") return 0;
  return 99;
}

function compareRouteProductRows(a: PickupProductRow & { productBrand?: string | null }, b: PickupProductRow & { productBrand?: string | null }) {
  const aGroup = groupKeyForProduct(a.productName, a.productCategory, a.productBrand);
  const bGroup = groupKeyForProduct(b.productName, b.productCategory, b.productBrand);
  const groupDifference = groupRank(aGroup) - groupRank(bGroup);
  if (groupDifference) return groupDifference;

  const featuredDifference = featureRank(a.productName, a.productCategory, a.productBrand) - featureRank(b.productName, b.productCategory, b.productBrand);
  if (featuredDifference) return featuredDifference;

  const nameDifference = normalizedText(a.productName).localeCompare(normalizedText(b.productName));
  if (nameDifference) return nameDifference;

  const categoryDifference = normalizedText(a.productCategory ?? "").localeCompare(normalizedText(b.productCategory ?? ""));
  if (categoryDifference) return categoryDifference;

  return normalizedSortKey(a.sortKey).localeCompare(normalizedSortKey(b.sortKey));
}

export function routeProductGroupLabel(productName: string, productCategory?: string | null, productBrand?: string | null) {
  return GROUP_LABELS[groupKeyForProduct(productName, productCategory, productBrand)];
}

export function pickupProductPriorityGroup(productName: string) {
  const text = normalizedText(productName);
  if (includesAny(text, MR_CRUNCH_ALIASES)) return 1;
  if (includesAny(text, DORITOS_ALIASES)) return 2;
  if (includesAny(text, SPUDS_ALIASES)) return 3;
  return 4;
}

export function comparePickupProductRows<T extends PickupProductRow>(a: T, b: T) {
  return compareRouteProductRows(
    { ...a },
    { ...b },
  );
}

export function sortPickupProductRows<T extends PickupProductRow>(rows: T[]) {
  return [...rows].sort(comparePickupProductRows);
}

export function groupRouteItemsForDisplay<T extends RouteDisplayItem>(items: T[]) {
  const grouped = new Map<RouteProductGroupKey, T[]>();
  items.forEach((item) => {
    const groupKey = groupKeyForProduct(item.productName, item.productCategory, item.productBrand);
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), item]);
  });

  return GROUP_ORDER
    .map((groupKey): RouteDisplayGroup<T> | null => {
      const groupItems = grouped.get(groupKey) ?? [];
      if (!groupItems.length) return null;
      const sortedItems = [...groupItems].sort((a, b) => compareRouteProductRows(a, b));
      return {
        groupKey,
        groupLabel: GROUP_LABELS[groupKey],
        items: sortedItems,
        totalQuantity: sortedItems.reduce((sum, item) => sum + Math.max(0, Number(item.quantity ?? 0)), 0),
        checkedCount: sortedItems.reduce((sum, item) => sum + (item.checked ? 1 : 0), 0),
        itemCount: sortedItems.length,
        defaultExpanded: FEATURED_GROUPS.has(groupKey),
      };
    })
    .filter((group): group is RouteDisplayGroup<T> => Boolean(group));
}
