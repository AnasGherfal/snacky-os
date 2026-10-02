import "server-only";
import type { ReceiptConfidenceLabel, ReceiptExtraction, ReceiptScanDraft, ReceiptScanDraftLine } from "@/lib/receipt-scan-types";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type SupabaseServer = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

type SupplierRow = {
  id: string;
  name: string;
};

type ProductRow = {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  case_quantity: number | null;
};

type ProductAliasRow = {
  alias_name: string;
  product_id: string;
  confidence: number | null;
};

type VmsMappingRow = {
  vms_product_name: string | null;
  product_id: string | null;
  vms_barcode?: string | null;
};

type ReceiptScanProviderResult = {
  status: "completed" | "not_configured" | "failed";
  extraction: ReceiptExtraction;
  errorMessage: string | null;
  provider: string;
};

type MatchContext = {
  suppliers: SupplierRow[];
  products: ProductRow[];
  aliases: ProductAliasRow[];
  mappings: VmsMappingRow[];
};

export const RECEIPT_SCAN_NOT_CONFIGURED_MESSAGE = "Receipt scanning is not configured. You can still enter purchase manually.";

const EMPTY_EXTRACTION: ReceiptExtraction = {
  supplierName: null,
  receiptDate: null,
  receiptNumber: null,
  totalAmount: null,
  currency: null,
  rawText: null,
  lines: [],
};

const receiptExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["supplierName", "receiptDate", "receiptNumber", "totalAmount", "currency", "rawText", "lines"],
  properties: {
    supplierName: { type: ["string", "null"] },
    receiptDate: {
      type: ["string", "null"],
      description: "Receipt or invoice date in YYYY-MM-DD format when visible.",
    },
    receiptNumber: { type: ["string", "null"] },
    totalAmount: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    rawText: { type: ["string", "null"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemName", "quantity", "unitPrice", "lineTotal"],
        properties: {
          itemName: { type: "string" },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          lineTotal: { type: ["number", "null"] },
        },
      },
    },
  },
};

function numberOrNull(value: unknown, precision = 2) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** precision;
  return Math.round(parsed * factor) / factor;
}

function stringOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function dateOrNull(value: unknown) {
  const text = stringOrNull(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function coerceExtraction(value: unknown): ReceiptExtraction {
  const objectValue = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawLines = Array.isArray(objectValue.lines) ? objectValue.lines : [];
  const lines = rawLines
    .map((line) => {
      const lineObject = line && typeof line === "object" ? (line as Record<string, unknown>) : {};
      const itemName = stringOrNull(lineObject.itemName ?? lineObject.name ?? lineObject.description);
      if (!itemName) return null;
      return {
        itemName,
        quantity: numberOrNull(lineObject.quantity, 3),
        unitPrice: numberOrNull(lineObject.unitPrice ?? lineObject.unitCost, 4),
        lineTotal: numberOrNull(lineObject.lineTotal ?? lineObject.total, 2),
      };
    })
    .filter((line): line is NonNullable<typeof line> => Boolean(line));

  return {
    supplierName: stringOrNull(objectValue.supplierName ?? objectValue.supplier),
    receiptDate: dateOrNull(objectValue.receiptDate ?? objectValue.date),
    receiptNumber: stringOrNull(objectValue.receiptNumber ?? objectValue.invoiceNumber ?? objectValue.number),
    totalAmount: numberOrNull(objectValue.totalAmount ?? objectValue.total, 2),
    currency: stringOrNull(objectValue.currency),
    rawText: stringOrNull(objectValue.rawText),
    lines,
  };
}

function stripJsonFence(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function collectOpenAIText(payload: unknown) {
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown; type?: string }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function extractReceiptWithOpenAI(file: File): Promise<ReceiptScanProviderResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      status: "not_configured",
      extraction: EMPTY_EXTRACTION,
      errorMessage: RECEIPT_SCAN_NOT_CONFIGURED_MESSAGE,
      provider: "openai",
    };
  }

  const model = process.env.RECEIPT_SCAN_MODEL || process.env.OPENAI_RECEIPT_SCAN_MODEL || "gpt-4.1-mini";
  const bytes = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type || "application/octet-stream"};base64,${bytes.toString("base64")}`;
  const fileName = file.name || (file.type === "application/pdf" ? "receipt.pdf" : "receipt.jpg");
  const fileContent =
    file.type === "application/pdf"
      ? { type: "input_file", filename: fileName, file_data: dataUrl }
      : { type: "input_image", image_url: dataUrl, detail: "high" };

  const prompt = [
    "Extract purchase receipt data for Snacky OS.",
    "Return only data visible on the receipt.",
    "Use YYYY-MM-DD for dates when possible.",
    "Use numeric LYD-style amounts without currency symbols.",
    "If a field is not visible, return null.",
    "Line item names should stay close to the printed receipt text.",
  ].join(" ");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              fileContent,
            ],
          },
        ],
        max_output_tokens: 4000,
        text: {
          format: {
            type: "json_schema",
            name: "receipt_extraction",
            schema: receiptExtractionSchema,
            strict: true,
          },
        },
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        (payload as { error?: { message?: string } } | null)?.error?.message ??
        `Receipt extraction failed with status ${response.status}.`;
      return { status: "failed", extraction: EMPTY_EXTRACTION, errorMessage: message, provider: "openai" };
    }

    const outputText = collectOpenAIText(payload);
    const parsed = JSON.parse(stripJsonFence(outputText));
    return {
      status: "completed",
      extraction: coerceExtraction(parsed),
      errorMessage: null,
      provider: "openai",
    };
  } catch (error) {
    return {
      status: "failed",
      extraction: EMPTY_EXTRACTION,
      errorMessage: error instanceof Error ? error.message : "Receipt extraction failed.",
      provider: "openai",
    };
  }
}

export async function extractReceipt(file: File): Promise<ReceiptScanProviderResult> {
  return extractReceiptWithOpenAI(file);
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\u0600-\u06ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string | null | undefined) {
  return normalizeText(value).replace(/\s+/g, "");
}

function tokenSet(value: string) {
  return new Set(normalizeText(value).split(" ").filter((token) => token.length > 1));
}

function diceCoefficient(left: string, right: string) {
  const a = compactText(left);
  const b = compactText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const grams = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      overlap += 1;
    }
  }

  return (2 * overlap) / (a.length + b.length - 2);
}

function textScore(input: string, candidate: string | null | undefined) {
  const normalizedInput = normalizeText(input);
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedInput || !normalizedCandidate) return 0;
  if (normalizedInput === normalizedCandidate) return 1;

  const inputCompact = compactText(normalizedInput);
  const candidateCompact = compactText(normalizedCandidate);
  if (inputCompact.length >= 4 && candidateCompact.length >= 4 && (inputCompact.includes(candidateCompact) || candidateCompact.includes(inputCompact))) {
    return 0.86;
  }

  const inputTokens = tokenSet(normalizedInput);
  const candidateTokens = tokenSet(normalizedCandidate);
  const denominator = Math.max(inputTokens.size, candidateTokens.size, 1);
  const overlap = [...inputTokens].filter((token) => candidateTokens.has(token)).length / denominator;
  return Math.max(overlap * 0.78, diceCoefficient(normalizedInput, normalizedCandidate));
}

function confidenceLabel(score: number | null): ReceiptConfidenceLabel {
  if (score !== null && score >= 0.82) return "high";
  if (score !== null && score >= 0.55) return "medium";
  return "low";
}

function bestSupplierMatch(supplierName: string | null, suppliers: SupplierRow[]) {
  if (!supplierName) return { supplierId: null, label: null as ReceiptConfidenceLabel | null };
  let best: { supplierId: string | null; score: number } = { supplierId: null, score: 0 };
  for (const supplier of suppliers) {
    const score = textScore(supplierName, supplier.name);
    if (score > best.score) best = { supplierId: supplier.id, score };
  }
  if (best.score < 0.55) return { supplierId: null, label: confidenceLabel(best.score) };
  return { supplierId: best.supplierId, label: confidenceLabel(best.score) };
}

function bestProductMatch(lineName: string, context: MatchContext) {
  let best: { product: ProductRow | null; score: number } = { product: null, score: 0 };

  for (const product of context.products) {
    const aliases = context.aliases.filter((alias) => alias.product_id === product.id);
    const mappings = context.mappings.filter((mapping) => mapping.product_id === product.id);
    const candidates: Array<{ value: string | null | undefined; weight: number }> = [
      { value: product.barcode, weight: 1 },
      { value: product.sku, weight: 0.98 },
      { value: product.name, weight: 0.9 },
      { value: product.brand, weight: 0.48 },
      ...aliases.map((alias) => ({ value: alias.alias_name, weight: Math.max(0.88, Number(alias.confidence ?? 0)) })),
      ...mappings.map((mapping) => ({ value: mapping.vms_product_name, weight: 0.9 })),
      ...mappings.map((mapping) => ({ value: mapping.vms_barcode, weight: 1 })),
    ];
    const score = candidates.reduce((max, candidate) => Math.max(max, Math.min(1, textScore(lineName, candidate.value) * candidate.weight)), 0);
    if (score > best.score) best = { product, score };
  }

  return {
    product: best.product,
    score: best.product ? Math.round(best.score * 100) / 100 : null,
    label: confidenceLabel(best.product ? best.score : null),
  };
}

function buildDraftLine(line: ReceiptExtraction["lines"][number], context: MatchContext): ReceiptScanDraftLine {
  const quantity = Math.max(0, numberOrNull(line.quantity, 3) ?? 1);
  const extractedLineTotal = numberOrNull(line.lineTotal, 2);
  const extractedUnitCost = numberOrNull(line.unitPrice, 4);
  const unitCost = extractedUnitCost ?? (extractedLineTotal !== null && quantity > 0 ? extractedLineTotal / quantity : 0);
  const lineTotal = extractedLineTotal ?? (quantity > 0 ? quantity * unitCost : 0);
  const match = bestProductMatch(line.itemName, context);
  const canDefaultAccept = match.product && match.label !== "low";

  return {
    id: globalThis.crypto.randomUUID(),
    receiptItemName: line.itemName,
    quantity,
    unitCost: Math.round(unitCost * 10000) / 10000,
    lineTotal: Math.round(lineTotal * 100) / 100,
    suggestedProductId: match.product?.id ?? null,
    suggestedProductName: match.product?.name ?? null,
    suggestedProductSku: match.product?.sku ?? null,
    confidenceScore: match.score,
    confidenceLabel: match.label,
    action: canDefaultAccept ? "accept" : "ignore",
  };
}

async function loadMatchContext(supabase: SupabaseServer): Promise<MatchContext> {
  const [suppliersResult, productsResult, aliasesResult, mappingsResult] = await Promise.all([
    supabase.from("suppliers").select("id, name").order("name"),
    supabase.from("products").select("id, sku, barcode, name, category, brand, case_quantity").eq("active", true).order("name"),
    supabase.from("product_aliases").select("alias_name, product_id, confidence"),
    supabase.from("vms_product_mappings").select("vms_product_name, product_id, vms_barcode"),
  ]);

  if (suppliersResult.error) console.warn("[receipt-scan] Could not load suppliers for matching", suppliersResult.error);
  if (productsResult.error) console.warn("[receipt-scan] Could not load products for matching", productsResult.error);
  if (aliasesResult.error) console.warn("[receipt-scan] Could not load product aliases for matching", aliasesResult.error);
  if (mappingsResult.error) console.warn("[receipt-scan] Could not load VMS mappings for matching", mappingsResult.error);

  return {
    suppliers: (suppliersResult.data ?? []) as SupplierRow[],
    products: (productsResult.data ?? []) as ProductRow[],
    aliases: (aliasesResult.error ? [] : aliasesResult.data ?? []) as ProductAliasRow[],
    mappings: (mappingsResult.error ? [] : mappingsResult.data ?? []) as VmsMappingRow[],
  };
}

export async function buildReceiptScanDraft({
  supabase,
  extraction,
  fileUrl,
  fileName,
  fileType,
  status,
  message,
}: {
  supabase: SupabaseServer;
  extraction: ReceiptExtraction;
  fileUrl: string | null;
  fileName: string | null;
  fileType: string | null;
  status: ReceiptScanDraft["status"];
  message: string | null;
}): Promise<ReceiptScanDraft> {
  const context = await loadMatchContext(supabase);
  const supplierMatch = bestSupplierMatch(extraction.supplierName, context.suppliers);

  return {
    scanResultId: null,
    fileUrl,
    fileName,
    fileType,
    supplierName: extraction.supplierName,
    supplierId: supplierMatch.supplierId,
    supplierConfidenceLabel: supplierMatch.label,
    receiptDate: extraction.receiptDate,
    receiptNumber: extraction.receiptNumber,
    totalAmount: extraction.totalAmount,
    currency: extraction.currency,
    rawText: extraction.rawText,
    status,
    message,
    lines: extraction.lines.map((line) => buildDraftLine(line, context)),
  };
}
