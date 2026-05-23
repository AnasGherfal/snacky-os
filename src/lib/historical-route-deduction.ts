export type HistoricalDeductionProduct = {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
};

export type HistoricalDeductionMachine = {
  id: string;
  name: string;
  machine_code?: string | null;
  vms_machine_id?: string | null;
};

export type HistoricalDeductionStorageBalance = {
  product_id: string;
  quantity_on_hand: number | string | null;
};

export type HistoricalDeductionLineStatus = "ready" | "needs_review";

export type HistoricalDeductionParsedLine = {
  lineNumber: number;
  sectionName: string | null;
  machineAlias: string | null;
  machineId: string | null;
  machineName: string | null;
  productAlias: string | null;
  productId: string | null;
  productName: string | null;
  quantity: number | null;
  originalText: string;
  status: HistoricalDeductionLineStatus;
  reviewReasons: string[];
  storageQtyBefore: number | null;
  storageQtyAfter: number | null;
  storageNegativeWarning: boolean;
};

export type HistoricalDeductionReviewGroup = {
  key: string;
  reason: string;
  machineAlias: string | null;
  productAlias: string | null;
  count: number;
  lineNumbers: number[];
  examples: string[];
};

export type HistoricalDeductionMachineGroup = {
  machineId: string;
  machineName: string;
  sectionName: string | null;
  totalQuantity: number;
  lines: HistoricalDeductionParsedLine[];
};

export type HistoricalDeductionParseResult = {
  lines: HistoricalDeductionParsedLine[];
  readyLines: HistoricalDeductionParsedLine[];
  needsReviewLines: HistoricalDeductionParsedLine[];
  machineGroups: HistoricalDeductionMachineGroup[];
  reviewGroups: HistoricalDeductionReviewGroup[];
  totalQuantity: number;
};

type ProductAliasRule = {
  aliases: string[];
  candidates: string[];
  note?: string;
};

type MachineAliasRule = {
  aliases: string[];
  candidates: string[];
};

const arabicDigitMap: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

export const KHALIJ_UNIVERSITY_MACHINE_NAME = "جامعة طرابلس الاهلية";
export const HISTORICAL_DEDUCTION_NOTE = "Old route data was not previously deducted from storage";

const machineAliasRules: MachineAliasRule[] = [
  {
    aliases: ["@الخليج", "@خليج", "الخليج", "خليج", "KhalijUniversity", "Khalij University"],
    candidates: [KHALIJ_UNIVERSITY_MACHINE_NAME, "جامعة طرابلس الاهليه"],
  },
  { aliases: ["@التحدي", "التحدي"], candidates: ["التحدي", "جامعة التحدي"] },
  { aliases: ["@الاستقلال", "الاستقلال"], candidates: ["الاستقلال", "مستشفى الاستقلال"] },
  { aliases: ["@مواصفات", "مواصفات"], candidates: ["مواصفات", "مستشفى المواصفات"] },
  { aliases: ["اتش مول", "اتش تي مول", "HT Mall", "HTMall"], candidates: ["HT Mall", "اتش تي مول"] },
];

const productAliasRules: ProductAliasRule[] = [
  { aliases: ["دوريتوس ز", "دورتوس ز"], candidates: ["Doritos"] },
  { aliases: ["دوريتوس خ", "دورتوس خ", "دوربتوس خ"], candidates: ["Doritos Green Hot"] },
  { aliases: ["دوريتوس ص", "دورتوس ص"], candidates: ["Doritos Nacho"] },
  {
    aliases: ["دوريتوس", "دورتوس"],
    candidates: ["Doritos"],
    note: "Doritos without color needs confirmation unless a default Doritos product exists.",
  },
  { aliases: ["طربوش"], candidates: ["Mr Crunch Tarboouch"] },
  { aliases: ["مراعي ش"], candidates: ["Almarai Chocolate", "SunTop Almarai Chocolate"] },
  { aliases: ["مراعي ف"], candidates: ["Almarai Strawberry", "SunTop Almarai Strawberry"] },
  {
    aliases: ["ميه", "مياه", "موية"],
    candidates: ["Water pack 12 bottles", "Water Pack 12 Bottles"],
    note: "Water quantities are packages of 12 bottles, not individual bottles.",
  },
  { aliases: ["اكسار", "اكس ار", "اكس أر", "xr", "x r"], candidates: ["XR", "X!R"] },
  { aliases: ["شويبس ر", "شويبس رمان"], candidates: ["Schweppes Pomegranate"] },
  {
    aliases: ["شويبس ان", "شويبس أن", "شويبس اناناس"],
    candidates: ["Schweppes Pineapple"],
    note: "Schweppes pineapple must exist as a product or be confirmed before applying.",
  },
  { aliases: ["بيبسي"], candidates: ["Pepsi"] },
  { aliases: ["جالكسي", "غالاكسي"], candidates: ["Galaxy"] },
  { aliases: ["سنكرز"], candidates: ["Snickers"] },
  { aliases: ["تويكس"], candidates: ["Twix"] },
  { aliases: ["بيمبو"], candidates: ["Bimbo"] },
  { aliases: ["بريوش"], candidates: ["Brioche"] },
  { aliases: ["بوينو"], candidates: ["Bueno", "Kinder Bueno"] },
  { aliases: ["بوينو ب", "بوينو براون"], candidates: ["Bueno Brown"] },
  { aliases: ["بوينو وايت", "بوينو ابيض"], candidates: ["Bueno White"] },
  { aliases: ["بيبيتو"], candidates: ["Bebeto"] },
  { aliases: ["منقا", "مانجو"], candidates: ["Mango"] },
  { aliases: ["لوبو"], candidates: ["Lobo"] },
  { aliases: ["جيلي فل"], candidates: ["Jelly Fill"] },
  { aliases: ["اولكر", "أولكر"], candidates: ["Ulker"] },
  { aliases: ["لافيفا زرقا", "لا فيفا زرقا"], candidates: ["Laviva Blue"] },
  { aliases: ["كندر"], candidates: ["Kinder"] },
  { aliases: ["هاريبو"], candidates: ["Haribo"] },
];

type Lookup<T> = {
  byNormalized: Map<string, T>;
  byCompact: Map<string, T>;
  rows: T[];
};

type ProductResolution = {
  productId: string | null;
  productName: string | null;
  productAlias: string | null;
  reviewReason: string | null;
};

type MachineResolution = {
  machineId: string | null;
  machineName: string | null;
  machineAlias: string | null;
};

export function normalizeHistoricalDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => arabicDigitMap[digit] ?? digit);
}

export function normalizeHistoricalText(value: string | null | undefined) {
  return normalizeHistoricalDigits(String(value ?? ""))
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/ـ/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}!]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function compactKey(value: string | null | undefined) {
  return normalizeHistoricalText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanLine(value: string) {
  return normalizeHistoricalDigits(value)
    .replace(/^[\s\-–—*•]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeLookup<T extends { name: string; sku?: string | null; barcode?: string | null }>(rows: T[]): Lookup<T> {
  const byNormalized = new Map<string, T>();
  const byCompact = new Map<string, T>();

  for (const row of rows) {
    const values = [row.name, row.sku, row.barcode].filter(Boolean) as string[];
    for (const value of values) {
      const normalized = normalizeHistoricalText(value);
      const compact = compactKey(value);
      if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, row);
      if (compact && !byCompact.has(compact)) byCompact.set(compact, row);
    }
  }

  return { byNormalized, byCompact, rows };
}

function makeMachineLookup(rows: HistoricalDeductionMachine[]): Lookup<HistoricalDeductionMachine> {
  const byNormalized = new Map<string, HistoricalDeductionMachine>();
  const byCompact = new Map<string, HistoricalDeductionMachine>();

  for (const row of rows) {
    const values = [row.name, row.machine_code, row.vms_machine_id].filter(Boolean) as string[];
    for (const value of values) {
      const normalized = normalizeHistoricalText(value);
      const compact = compactKey(value);
      if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, row);
      if (compact && !byCompact.has(compact)) byCompact.set(compact, row);
    }
  }

  return { byNormalized, byCompact, rows };
}

function findByCandidates<T extends { name: string }>(lookup: Lookup<T>, candidates: string[]) {
  for (const candidate of candidates) {
    const normalized = normalizeHistoricalText(candidate);
    const compact = compactKey(candidate);
    const exact = lookup.byNormalized.get(normalized) ?? lookup.byCompact.get(compact);
    if (exact) return exact;
  }

  for (const candidate of candidates) {
    const normalized = normalizeHistoricalText(candidate);
    if (!normalized) continue;
    const fuzzy = lookup.rows.find((row) => {
      const rowName = normalizeHistoricalText(row.name);
      return rowName === normalized || rowName.includes(normalized) || normalized.includes(rowName);
    });
    if (fuzzy) return fuzzy;
  }

  return null;
}

function resolveMachine(alias: string | null, lookup: Lookup<HistoricalDeductionMachine>): MachineResolution {
  if (!alias) return { machineId: null, machineName: null, machineAlias: null };

  const normalizedAlias = normalizeHistoricalText(alias);
  const compactAlias = compactKey(alias);
  const rule = machineAliasRules.find((item) =>
    item.aliases.some((candidate) => normalizeHistoricalText(candidate) === normalizedAlias || compactKey(candidate) === compactAlias),
  );
  const machine = rule
    ? findByCandidates(lookup, rule.candidates)
    : lookup.byNormalized.get(normalizedAlias) ?? lookup.byCompact.get(compactAlias) ?? findByCandidates(lookup, [alias]);

  return {
    machineId: machine?.id ?? null,
    machineName: machine?.name ?? null,
    machineAlias: alias,
  };
}

function productAliasRuleFor(rawProductName: string) {
  const normalized = normalizeHistoricalText(rawProductName);
  const compact = compactKey(rawProductName);
  const rules = [...productAliasRules].sort((a, b) => {
    const aLength = Math.max(...a.aliases.map((alias) => normalizeHistoricalText(alias).length));
    const bLength = Math.max(...b.aliases.map((alias) => normalizeHistoricalText(alias).length));
    return bLength - aLength;
  });

  return rules.find((rule) =>
    rule.aliases.some((alias) => normalizeHistoricalText(alias) === normalized || compactKey(alias) === compact),
  ) ?? null;
}

function resolveProduct(rawProductName: string | null, lookup: Lookup<HistoricalDeductionProduct>): ProductResolution {
  const productAlias = rawProductName?.trim() || null;
  if (!productAlias) {
    return { productId: null, productName: null, productAlias, reviewReason: "Product name is missing." };
  }

  const rule = productAliasRuleFor(productAlias);
  if (rule) {
    const product = findByCandidates(lookup, rule.candidates);
    if (!product) {
      return {
        productId: null,
        productName: null,
        productAlias,
        reviewReason: `Product alias "${productAlias}" needs review. Expected product: ${rule.candidates[0]}.`,
      };
    }
    return { productId: product.id, productName: product.name, productAlias, reviewReason: null };
  }

  const normalized = normalizeHistoricalText(productAlias);
  const compact = compactKey(productAlias);
  const product = lookup.byNormalized.get(normalized) ?? lookup.byCompact.get(compact);
  if (!product) {
    return { productId: null, productName: null, productAlias, reviewReason: `Unknown product: ${productAlias}.` };
  }

  return { productId: product.id, productName: product.name, productAlias, reviewReason: null };
}

function quantityFromLine(line: string): { quantity: number | null; productText: string | null; quantityMissing: boolean; quantityInvalid: boolean } {
  const cleaned = cleanLine(line).replace(/[,:؛]+/g, " ");
  const startMatch = cleaned.match(/^(\d+(?:[.,]\d+)?)\s*(?:x|×)?\s+(.+)$/i);
  const endMatch = cleaned.match(/^(.+?)\s*(?:x|×|\-|\+)?\s+(\d+(?:[.,]\d+)?)$/i);
  const match = startMatch ?? endMatch;

  if (!match) {
    return { quantity: null, productText: cleaned || null, quantityMissing: true, quantityInvalid: false };
  }

  const rawQuantity = startMatch ? match[1] : match[2];
  const rawProduct = startMatch ? match[2] : match[1];
  const numeric = Number(String(rawQuantity).replace(",", "."));

  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    return { quantity: null, productText: rawProduct?.trim() || null, quantityMissing: false, quantityInvalid: true };
  }

  return { quantity: numeric, productText: rawProduct?.trim() || null, quantityMissing: false, quantityInvalid: false };
}

function sectionNameFromLine(line: string, machineLookup: Lookup<HistoricalDeductionMachine>) {
  const cleaned = cleanLine(line);
  if (!cleaned) return null;
  if (cleaned.startsWith("@")) return cleaned.replace(/^@+/, "").trim() || null;

  const quantity = quantityFromLine(cleaned);
  if (!quantity.quantityMissing) return null;

  const resolved = resolveMachine(cleaned, machineLookup);
  return resolved.machineId ? cleaned : null;
}

function buildReviewGroups(lines: HistoricalDeductionParsedLine[]): HistoricalDeductionReviewGroup[] {
  const groups = new Map<string, HistoricalDeductionReviewGroup>();

  for (const line of lines.filter((item) => item.status === "needs_review")) {
    const primaryReason = line.reviewReasons[0] ?? "Needs review.";
    const unknownMachine = line.reviewReasons.some((reason) => reason.toLowerCase().includes("machine"));
    const unknownProduct = line.reviewReasons.some((reason) => reason.toLowerCase().includes("product"));
    const missingQuantity = line.reviewReasons.some((reason) => reason.toLowerCase().includes("quantity"));
    const key = unknownMachine
      ? `machine:${normalizeHistoricalText(line.machineAlias ?? line.sectionName ?? "missing")}`
      : unknownProduct
        ? `product:${normalizeHistoricalText(line.productAlias ?? "missing")}`
        : missingQuantity
          ? `quantity:${normalizeHistoricalText(line.productAlias ?? line.originalText)}`
          : `row:${normalizeHistoricalText(primaryReason)}:${normalizeHistoricalText(line.productAlias ?? line.machineAlias ?? "")}`;

    const group = groups.get(key) ?? {
      key,
      reason: primaryReason,
      machineAlias: line.machineAlias ?? line.sectionName,
      productAlias: line.productAlias,
      count: 0,
      lineNumbers: [],
      examples: [],
    };

    group.count += 1;
    group.lineNumbers.push(line.lineNumber);
    if (group.examples.length < 3) group.examples.push(line.originalText);
    groups.set(key, group);
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function buildMachineGroups(lines: HistoricalDeductionParsedLine[]): HistoricalDeductionMachineGroup[] {
  const groups = new Map<string, HistoricalDeductionMachineGroup>();

  for (const line of lines.filter((item) => item.status === "ready" && item.machineId && item.machineName)) {
    const key = line.machineId as string;
    const group = groups.get(key) ?? {
      machineId: key,
      machineName: line.machineName as string,
      sectionName: line.sectionName,
      totalQuantity: 0,
      lines: [],
    };
    group.lines.push(line);
    group.totalQuantity += line.quantity ?? 0;
    groups.set(key, group);
  }

  return Array.from(groups.values()).sort((a, b) => a.machineName.localeCompare(b.machineName));
}

function applyStorageWarnings(lines: HistoricalDeductionParsedLine[], storageBalances: HistoricalDeductionStorageBalance[]) {
  const balanceByProduct = new Map<string, number>();
  for (const row of storageBalances) {
    const productId = String(row.product_id);
    balanceByProduct.set(productId, (balanceByProduct.get(productId) ?? 0) + Number(row.quantity_on_hand ?? 0));
  }

  const running = new Map(balanceByProduct);
  return lines.map((line) => {
    if (line.status !== "ready" || !line.productId || !line.quantity) return line;
    const before = running.get(line.productId) ?? 0;
    const after = before - line.quantity;
    running.set(line.productId, after);
    return {
      ...line,
      storageQtyBefore: before,
      storageQtyAfter: after,
      storageNegativeWarning: after < 0,
    };
  });
}

export function parseHistoricalRouteDeductionText({
  text,
  products,
  machines,
  storageBalances = [],
}: {
  text: string;
  products: HistoricalDeductionProduct[];
  machines: HistoricalDeductionMachine[];
  storageBalances?: HistoricalDeductionStorageBalance[];
}): HistoricalDeductionParseResult {
  const productLookup = makeLookup(products);
  const machineLookup = makeMachineLookup(machines);
  const parsedLines: HistoricalDeductionParsedLine[] = [];
  let currentSection: string | null = null;
  let currentMachine: MachineResolution = { machineId: null, machineName: null, machineAlias: null };

  normalizeHistoricalDigits(text)
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const originalText = cleanLine(rawLine);
      if (!originalText) return;

      const sectionName = sectionNameFromLine(originalText, machineLookup);
      if (sectionName) {
        currentSection = sectionName;
        currentMachine = resolveMachine(sectionName, machineLookup);
        return;
      }

      const quantity = quantityFromLine(originalText);
      const product = resolveProduct(quantity.productText, productLookup);
      const reviewReasons: string[] = [];

      if (!currentSection || !currentMachine.machineId) {
        reviewReasons.push(`Unknown machine/location: ${currentSection ?? "missing section"}.`);
      }
      if (quantity.quantityMissing) reviewReasons.push("Quantity is missing.");
      if (quantity.quantityInvalid) reviewReasons.push("Quantity must be a whole number greater than 0.");
      if (product.reviewReason) reviewReasons.push(product.reviewReason);

      parsedLines.push({
        lineNumber: index + 1,
        sectionName: currentSection,
        machineAlias: currentMachine.machineAlias ?? currentSection,
        machineId: currentMachine.machineId,
        machineName: currentMachine.machineName,
        productAlias: product.productAlias,
        productId: product.productId,
        productName: product.productName,
        quantity: quantity.quantity,
        originalText,
        status: reviewReasons.length ? "needs_review" : "ready",
        reviewReasons,
        storageQtyBefore: null,
        storageQtyAfter: null,
        storageNegativeWarning: false,
      });
    });

  const lines = applyStorageWarnings(parsedLines, storageBalances);
  const readyLines = lines.filter((line) => line.status === "ready");
  const needsReviewLines = lines.filter((line) => line.status === "needs_review");

  return {
    lines,
    readyLines,
    needsReviewLines,
    machineGroups: buildMachineGroups(lines),
    reviewGroups: buildReviewGroups(lines),
    totalQuantity: readyLines.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0),
  };
}
