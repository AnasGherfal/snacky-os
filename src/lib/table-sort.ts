export type TableSortDirection = "asc" | "desc";

export type TableSummaryMetric = {
  columnIndex: number;
  label: string;
  value: string;
};

type ParsedCell =
  | { kind: "empty"; value: "" }
  | { kind: "number"; value: number }
  | { kind: "date"; value: number }
  | { kind: "text"; value: string };

const EMPTY_LABELS = new Set(["", "-", "n/a", "na", "not available", "unknown"]);
const TEXT_ONLY_HEADERS = /(action|status|product|machine|location|file|coverage|source|name|month|date|period|range)/i;
const AVERAGE_HEADERS = /(margin|rate|percent|%|average|avg)/i;
const PRIORITY_HEADERS = /(gross profit|profit|units sold|units|revenue|sales|cost|cogs|margin|average transaction)/i;

function normalizeDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function normalizedText(value: string) {
  return normalizeDigits(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numericCandidate(value: string) {
  return normalizedText(value)
    .replace(/[,%٪]/g, "")
    .replace(/[٬،]/g, "")
    .replace(/\bLYD\b/gi, "")
    .replace(/د\.?\s*ل\.?/g, "")
    .replace(/دينار/gi, "")
    .trim();
}

export function parseSortableCell(value: string): ParsedCell {
  const text = normalizedText(value);
  if (EMPTY_LABELS.has(text.toLowerCase())) return { kind: "empty", value: "" };

  const numberText = numericCandidate(text);
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(numberText)) {
    const number = Number(numberText);
    if (Number.isFinite(number)) return { kind: "number", value: number };
  }

  if (/^\d{4}-\d{1,2}-\d{1,2}(?:[ T].*)?$/.test(text)) {
    const timestamp = Date.parse(text);
    if (Number.isFinite(timestamp)) return { kind: "date", value: timestamp };
  }

  return { kind: "text", value: text.toLocaleLowerCase() };
}

export function compareSortableCellText(leftText: string, rightText: string, direction: TableSortDirection) {
  const left = parseSortableCell(leftText);
  const right = parseSortableCell(rightText);

  if (left.kind === "empty" && right.kind === "empty") return 0;
  if (left.kind === "empty") return 1;
  if (right.kind === "empty") return -1;

  const multiplier = direction === "asc" ? 1 : -1;
  if (left.kind === "number" && right.kind === "number") return (left.value - right.value) * multiplier;
  if (left.kind === "date" && right.kind === "date") return (left.value - right.value) * multiplier;

  const leftValue = String(left.value);
  const rightValue = String(right.value);
  return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" }) * multiplier;
}

export function defaultSortDirectionForHeader(header: string): TableSortDirection {
  return /(product|machine|location|file|name|status|source|month|date|coverage)/i.test(header) ? "asc" : "desc";
}

function formatSummaryValue(header: string, sample: string, value: number, values: number[]) {
  if (AVERAGE_HEADERS.test(header) || sample.includes("%") || sample.includes("٪")) {
    return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }

  if (/\bLYD\b/i.test(sample)) {
    return `${Math.round(value).toLocaleString("en-US")} LYD`;
  }

  const allIntegers = values.every(Number.isInteger);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: allIntegers ? 0 : 1,
    maximumFractionDigits: allIntegers ? 0 : 2,
  });
}

export function summarizeTableColumns(headers: string[], rows: string[][], maxMetrics = 6): TableSummaryMetric[] {
  if (!rows.length) return [];

  return headers
    .map((header, columnIndex) => {
      if (TEXT_ONLY_HEADERS.test(header) && !PRIORITY_HEADERS.test(header)) return null;

      const rawValues = rows.map((row) => normalizedText(row[columnIndex] ?? "")).filter((value) => !EMPTY_LABELS.has(value.toLowerCase()));
      if (!rawValues.length) return null;

      const numbers = rawValues
        .map((value) => parseSortableCell(value))
        .filter((parsed): parsed is Extract<ParsedCell, { kind: "number" }> => parsed.kind === "number")
        .map((parsed) => parsed.value);

      if (numbers.length < Math.max(2, Math.ceil(rawValues.length * 0.75))) return null;

      const useAverage = AVERAGE_HEADERS.test(header);
      const aggregate = useAverage
        ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
        : numbers.reduce((sum, value) => sum + value, 0);

      return {
        columnIndex,
        label: `${header} ${useAverage ? "average" : "total"}`,
        priority: PRIORITY_HEADERS.test(header) ? 0 : 1,
        value: formatSummaryValue(header, rawValues[0] ?? "", aggregate, numbers),
      };
    })
    .filter((metric): metric is TableSummaryMetric & { priority: number } => Boolean(metric))
    .sort((left, right) => left.priority - right.priority || left.columnIndex - right.columnIndex)
    .slice(0, maxMetrics)
    .map(({ priority: _priority, ...metric }) => metric);
}
