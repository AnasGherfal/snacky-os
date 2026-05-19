export type VmsReportType = "stock" | "sales" | "product_list" | "machine_status" | "planogram" | "custom";

export type VmsParsedSheet = {
  name: string;
  rows: string[][];
};

export type VmsParsedFile = {
  fileType: "csv" | "xls" | "xlsx";
  sheets: VmsParsedSheet[];
};

export type VmsSheetRecords = {
  headerRowIndex: number;
  headerConfidence: number;
  headers: string[];
  records: Record<string, string>[];
  samples: Record<string, string>;
  columnSamples: Record<string, string[]>;
};

export type VmsFieldDef = {
  field: string;
  label: string;
  required?: boolean;
  requiredGroup?: string;
  aliases: string[];
};

export type VmsMappingDetection = {
  field: string;
  header: string;
  score: number;
  confidence: "high" | "medium" | "low" | "missing";
};

export const vmsReportTypes: { value: VmsReportType; label: string }[] = [
  { value: "stock", label: "Stock / tray status" },
  { value: "sales", label: "Sales statistics" },
  { value: "product_list", label: "Product list" },
  { value: "machine_status", label: "Machine status" },
  { value: "planogram", label: "Planogram / selection management" },
  { value: "custom", label: "Unknown / Custom" },
];

export const vmsExpectedFields: Record<VmsReportType, VmsFieldDef[]> = {
  stock: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "رقم الماكينة", "كود الماكينة"] },
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode", "vms_product_id", "product_id", "product_code", "goods_code", "item_id", "كود المنتج", "رقم المنتج", "الباركود"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "اسم المنتج", "الصنف", "المنتج"] },
    { field: "current_qty", label: "Current quantity", required: true, aliases: ["Stock", "Current Stock", "Inventory", "Qty", "Quantity", "Remaining", "Balance", "current_qty", "stock_qty", "remaining_qty", "on_hand", "available_qty", "عدد", "الكمية", "المخزون"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "اسم الماكينة", "الموقع"] },
    { field: "slot_code", label: "Slot code", aliases: ["Slot", "Slot No", "Tray", "Tray No", "Selection", "Channel", "Coil", "slot_code", "selection_code", "channel_no", "رقم الخانة", "رقم الرف", "الخانة"] },
    { field: "tray_number", label: "Tray number", aliases: ["Tray Number", "Tray No", "Tray", "Shelf", "tray_number", "tray_no", "رقم الرف"] },
    { field: "capacity", label: "Capacity", aliases: ["Capacity", "Max Stock", "Full Qty", "Par", "capacity", "max_qty", "par_qty", "السعة"] },
    { field: "empty_status", label: "Empty status", aliases: ["Empty Status", "Empty", "Empty Tray", "Empty Slot", "Out of Stock", "Out Of Stock", "Sold Out", "Status", "empty_status", "tray_status", "out_of_stock", "sold_out"] },
    { field: "updated_at", label: "Updated at", aliases: ["Updated At", "Last Updated", "Date", "Time", "Timestamp", "captured_at", "updated_at", "تاريخ"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Price", "Unit Price", "Retail Price", "selling_price", "sale_price", "سعر البيع"] },
  ],
  sales: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "رقم الماكينة", "كود الماكينة"] },
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode", "vms_product_id", "product_id", "product_code", "goods_code", "كود المنتج", "رقم المنتج", "الباركود"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "اسم المنتج", "الصنف", "المنتج"] },
    { field: "sold_qty", label: "Sold quantity", requiredGroup: "sales_measure", aliases: ["Sold Qty", "Sales Qty", "Quantity Sold", "Vend Count", "Count", "sold_qty", "quantity_sold", "units_sold", "sales_qty", "الكمية المباعة", "عدد المبيعات"] },
    { field: "total_sales_amount", label: "Total sales amount", requiredGroup: "sales_measure", aliases: ["Sales Amount", "Revenue", "Amount", "Total Sales", "Turnover", "sales_amount", "total_sales", "revenue_amount", "gross_sales", "المبيعات", "الإيراد", "القيمة"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "اسم الماكينة", "الموقع"] },
    { field: "sale_date", label: "Sale date", aliases: ["Date", "Sale Date", "Time", "Transaction Date", "period_end", "sales_date", "business_date", "timestamp", "التاريخ"] },
    { field: "revenue_amount", label: "Revenue amount", aliases: ["Sales Amount", "Revenue", "Amount", "Total Sales", "Turnover", "sales_amount", "total_sales", "المبيعات", "الإيراد", "القيمة"] },
    { field: "cost_amount", label: "Cost amount", aliases: ["Cost", "Product Cost", "Total Cost", "cost_amount", "cogs", "التكلفة"] },
    { field: "profit_amount", label: "Profit amount", aliases: ["Profit", "Gross Profit", "profit_amount", "gross_profit", "الربح"] },
    { field: "payment_method", label: "Payment method", aliases: ["Payment Method", "Payment", "Tender", "Method", "payment_method"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Price", "Unit Price", "selling_price", "sale_price", "سعر البيع"] },
  ],
  product_list: [
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Goods Code", "Item Code", "SKU", "Barcode", "VMS Product ID", "VMS Product Code", "vms_product_id", "product_id", "product_code", "goods_code", "item_code", "كود المنتج", "رقم المنتج", "الباركود"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "اسم المنتج", "المنتج", "الصنف"] },
    { field: "vms_product_id", label: "VMS product ID", requiredGroup: "product", aliases: ["VMS Product ID", "VMS ID", "Product ID", "Goods ID", "vms_product_id", "product_id", "goods_id"] },
    { field: "product_code", label: "Product code", requiredGroup: "product", aliases: ["Product Code", "Goods Code", "Item Code", "SKU", "product_code", "goods_code", "item_code"] },
    { field: "barcode", label: "Barcode", aliases: ["Barcode", "EAN", "UPC", "bar_code", "الباركود"] },
    { field: "category", label: "Category", aliases: ["Category", "Type", "Group", "Product Type", "category", "التصنيف", "النوع"] },
    { field: "brand", label: "Brand", aliases: ["Brand", "Manufacturer", "brand", "manufacturer", "العلامة التجارية"] },
    { field: "cost_price", label: "Cost price", aliases: ["Cost", "Cost Price", "Product Cost", "Purchase Price", "cost_price", "unit_cost", "التكلفة", "سعر الشراء"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Sale Price", "Price", "Retail Price", "Unit Price", "selling_price", "sale_price", "السعر", "سعر البيع"] },
    { field: "active_status", label: "Active status", aliases: ["Status", "Active", "Enabled", "Active Status", "active_status", "الحالة"] },
    { field: "image_url", label: "Image URL", aliases: ["Image URL", "Image", "Photo", "Picture", "image_url", "image"] },
  ],
  machine_status: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "رقم الماكينة", "كود الماكينة"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "اسم الماكينة", "الموقع"] },
    { field: "online_status", label: "Online status", aliases: ["Online Status", "Online", "Offline", "Status", "Connection Status", "Machine Status", "online_status", "network_status"] },
    { field: "temperature", label: "Temperature", aliases: ["Temperature", "Temp", "Cabinet Temperature", "temperature", "temperature_c"] },
    { field: "banknote_balance", label: "Banknote balance", aliases: ["Banknote Balance", "Banknote", "Cash Box", "banknote_balance"] },
    { field: "cash_balance", label: "Cash balance", aliases: ["Cash Balance", "Cash In Machine", "Cash Amount", "cash_balance", "cash_amount"] },
    { field: "last_online_at", label: "Last online at", aliases: ["Last Online", "Last Online At", "Last Updated", "Updated At", "last_online_at", "updated_at"] },
    { field: "error_status", label: "Error status", aliases: ["Error", "Error Status", "Fault", "Alarm", "error_status"] },
  ],
  planogram: [
    { field: "machine_identifier", label: "Machine identifier", required: true, aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine", "vms_machine_id", "machine_id", "machine_code", "terminal_id", "device_id", "رقم الماكينة", "كود الماكينة"] },
    { field: "slot_code", label: "Slot code", required: true, aliases: ["Slot", "Slot No", "Tray", "Tray No", "Selection", "Channel", "Coil", "slot_code", "selection_code", "channel_no", "رقم الخانة", "رقم الرف", "الخانة"] },
    { field: "product_identifier", label: "Product identifier", requiredGroup: "product", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode", "vms_product_id", "product_id", "product_code", "goods_code", "كود المنتج", "رقم المنتج", "الباركود"] },
    { field: "product_name", label: "Product name", requiredGroup: "product", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name", "vms_product_name", "product", "goods", "item", "description", "اسم المنتج", "الصنف", "المنتج"] },
    { field: "machine_name", label: "Machine name", aliases: ["Machine Name", "Device Name", "Location", "machine_name", "اسم الماكينة", "الموقع"] },
    { field: "capacity", label: "Capacity", aliases: ["Capacity", "Max Stock", "Full Qty", "Par", "capacity", "max_qty", "par_qty", "السعة"] },
    { field: "current_qty", label: "Current quantity", aliases: ["Stock", "Current Stock", "Inventory", "Qty", "Quantity", "Remaining", "Balance", "current_qty", "stock_qty", "الكمية", "المخزون"] },
    { field: "selling_price", label: "Selling price", aliases: ["Selling Price", "Price", "Unit Price", "selling_price", "sale_price", "سعر البيع"] },
  ],
  custom: [
    { field: "machine_identifier", label: "Machine identifier", aliases: ["Machine ID", "Machine Code", "Device ID", "Machine", "Machine No", "Vending Machine"] },
    { field: "product_identifier", label: "Product identifier", aliases: ["Product ID", "Product Code", "Goods ID", "Item Code", "SKU", "Barcode"] },
    { field: "product_name", label: "Product name", aliases: ["Product Name", "Goods Name", "Item Name", "Name", "Selection Name"] },
    { field: "slot_code", label: "Slot / tray / selection", aliases: ["Slot", "Slot No", "Tray", "Tray No", "Selection", "Channel", "Coil"] },
    { field: "quantity", label: "Quantity", aliases: ["Quantity", "Qty", "Stock", "Sold Qty", "Count"] },
    { field: "amount", label: "Amount", aliases: ["Amount", "Sales Amount", "Total Sales", "Revenue", "Price"] },
    { field: "date", label: "Date / timestamp", aliases: ["Date", "Time", "Timestamp", "Sale Date", "Updated At"] },
  ],
};

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(current.trim());
      current = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function normalizeHeader(header: string) {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s\-./()]+/g, "_")
    .replace(/[^a-z0-9_\u0600-\u06ff\u4e00-\u9fff]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function cleanRows(rows: unknown[][]) {
  return rows
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some(Boolean));
}

function spreadsheetColumnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function uniqueHeaders(row: string[]) {
  const seen = new Map<string, number>();
  return row.map((header, index) => {
    const base = header.trim() || `Column ${spreadsheetColumnName(index)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function splitTokens(value: string) {
  return normalizeHeader(value).split("_").filter((token) => token.length > 1);
}

function compact(value: string) {
  return normalizeHeader(value).replace(/_/g, "");
}

function looksNumeric(value: string) {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
  return cleaned !== "" && Number.isFinite(Number(cleaned));
}

function looksDate(value: string) {
  if (!value.trim()) return false;
  return !Number.isNaN(new Date(value).getTime()) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value.trim()) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(value.trim());
}

function fieldExpectsNumber(field: string) {
  return /(qty|quantity|amount|price|cost|profit|capacity|temperature|cash|trays|min|par|sold)/.test(field);
}

function fieldExpectsDate(field: string) {
  return /(date|time|period|captured|updated)/.test(field);
}

function scoreHeaderForField(header: string, field: VmsFieldDef, sampleValues: string[] = []) {
  const headerNorm = normalizeHeader(header);
  if (!headerNorm) return 0;

  const headerCompact = compact(header);
  const headerTokens = splitTokens(header);
  const aliases = [field.field, field.label, ...field.aliases];
  let score = 0;

  for (const alias of aliases) {
    const aliasNorm = normalizeHeader(alias);
    if (!aliasNorm) continue;
    const aliasCompact = compact(alias);
    const aliasTokens = splitTokens(alias);

    if (headerNorm === aliasNorm) score = Math.max(score, 100);
    else if (headerCompact === aliasCompact) score = Math.max(score, 96);
    else if (aliasCompact.length >= 4 && headerCompact.includes(aliasCompact)) score = Math.max(score, 86);
    else if (headerCompact.length >= 4 && aliasCompact.includes(headerCompact)) score = Math.max(score, 68);

    if (aliasTokens.length && headerTokens.length) {
      const overlap = aliasTokens.filter((token) => headerTokens.includes(token)).length;
      if (overlap) {
        const coverage = overlap / Math.max(aliasTokens.length, headerTokens.length);
        score = Math.max(score, 42 + Math.round(coverage * 38));
      }
    }
  }

  const nonEmptySamples = sampleValues.filter(Boolean).slice(0, 6);
  if (nonEmptySamples.length) {
    const numericHits = nonEmptySamples.filter(looksNumeric).length;
    const dateHits = nonEmptySamples.filter(looksDate).length;
    if (fieldExpectsNumber(field.field)) score += numericHits >= Math.ceil(nonEmptySamples.length / 2) ? 8 : -8;
    if (fieldExpectsDate(field.field)) score += dateHits >= Math.ceil(nonEmptySamples.length / 2) ? 8 : -8;
  }

  return Math.max(0, Math.min(100, score));
}

function headerRowScore(row: string[], reportType?: VmsReportType) {
  const fields = reportType ? vmsExpectedFields[reportType] : Object.values(vmsExpectedFields).flat();
  let score = 0;
  let textCells = 0;
  let numericCells = 0;

  row.forEach((cell) => {
    if (!cell.trim()) return;
    if (looksNumeric(cell) || looksDate(cell)) numericCells += 1;
    else textCells += 1;
    score += Math.max(...fields.map((field) => scoreHeaderForField(cell, field)), 0) / 12;
  });

  return score + textCells * 2 - numericCells * 1.5;
}

export function detectHeaderRowIndex(rows: unknown[][], reportType?: VmsReportType) {
  const nonEmptyRows = cleanRows(rows);
  if (!nonEmptyRows.length) return 0;

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  nonEmptyRows.slice(0, 25).forEach((row, index) => {
    const score = headerRowScore(row, reportType);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });

  return bestIndex;
}

export function sheetRowsToRecords(rows: unknown[][], options: { reportType?: VmsReportType; headerRowIndex?: number } = {}): VmsSheetRecords {
  const nonEmptyRows = cleanRows(rows);
  if (!nonEmptyRows.length) {
    return { headerRowIndex: 0, headerConfidence: 0, headers: [], records: [], samples: {}, columnSamples: {} };
  }

  const headerRowIndex = Math.max(0, Math.min(options.headerRowIndex ?? detectHeaderRowIndex(nonEmptyRows, options.reportType), nonEmptyRows.length - 1));
  const headers = uniqueHeaders(nonEmptyRows[headerRowIndex]);
  const normalizedHeaders = headers.map(normalizeHeader);
  const samples: Record<string, string> = {};
  const columnSamples: Record<string, string[]> = {};
  const records = nonEmptyRows.slice(headerRowIndex + 1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      const key = normalizedHeaders[index] || normalizeHeader(header);
      record[key] = value;
      if (value) {
        if (!samples[header]) samples[header] = value;
        const current = columnSamples[header] ?? [];
        if (!current.includes(value) && current.length < 3) columnSamples[header] = [...current, value];
      }
    });
    return record;
  }).filter((record) => Object.values(record).some(Boolean));

  return {
    headerRowIndex,
    headerConfidence: Math.max(0, Math.round(headerRowScore(nonEmptyRows[headerRowIndex], options.reportType))),
    headers,
    records,
    samples,
    columnSamples,
  };
}

export async function parseVmsUpload(file: File): Promise<VmsParsedFile> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "csv") {
    return { fileType: "csv", sheets: [{ name: "CSV", rows: parseCsvRows(await file.text()) }] };
  }

  if (extension === "xls" || extension === "xlsx") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer", cellDates: true });
    return {
      fileType: extension,
      sheets: workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        const rows = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" }) : [];
        return { name, rows: cleanRows(rows) };
      }).filter((sheet) => sheet.rows.length),
    };
  }

  throw new Error("Upload a .xlsx, .xls, or .csv file.");
}

export function detectColumnMappingDetails(headers: string[], reportType: VmsReportType, samples: Record<string, string[]> = {}) {
  const usedHeaders = new Set<string>();
  const mapping: Record<string, string> = {};
  const details: VmsMappingDetection[] = [];

  for (const field of vmsExpectedFields[reportType]) {
    const candidates = headers
      .filter((header) => !usedHeaders.has(header))
      .map((header) => ({
        header,
        score: scoreHeaderForField(header, field, samples[header] ?? []),
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const minScore = field.required || field.requiredGroup ? 48 : 55;
    const header = best && best.score >= minScore ? best.header : "";
    if (header) usedHeaders.add(header);
    mapping[field.field] = header;
    details.push({
      field: field.field,
      header,
      score: header ? best.score : 0,
      confidence: !header ? "missing" : best.score >= 84 ? "high" : best.score >= 62 ? "medium" : "low",
    });
  }

  return { mapping, details };
}

export function detectColumnMapping(headers: string[], reportType: VmsReportType, samples: Record<string, string[]> = {}) {
  return detectColumnMappingDetails(headers, reportType, samples).mapping;
}

export function applyColumnMapping(records: Record<string, string>[], mapping: Record<string, string>) {
  return records.map((record) => {
    const mapped = { ...record };
    for (const [field, header] of Object.entries(mapping)) {
      if (!header) continue;
      mapped[field] = record[normalizeHeader(header)] ?? "";
    }
    return mapped;
  });
}

export function parseReportType(value: FormDataEntryValue | string | null | undefined): VmsReportType | null {
  const raw = String(value ?? "");
  return vmsReportTypes.some((type) => type.value === raw) ? (raw as VmsReportType) : null;
}

export function requiredMissing(mapping: Record<string, string>, reportType: VmsReportType) {
  const fields = vmsExpectedFields[reportType];
  const missing = fields.filter((field) => field.required && !mapping[field.field]).map((field) => field.label);
  const groups = new Map<string, VmsFieldDef[]>();

  fields.forEach((field) => {
    if (!field.requiredGroup) return;
    groups.set(field.requiredGroup, [...(groups.get(field.requiredGroup) ?? []), field]);
  });

  groups.forEach((groupFields) => {
    if (!groupFields.some((field) => mapping[field.field])) {
      missing.push(groupFields.map((field) => field.label).join(" OR "));
    }
  });

  return missing;
}
