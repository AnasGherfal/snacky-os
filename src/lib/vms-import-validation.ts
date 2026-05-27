import { normalizeHeader, type VmsReportType } from "./vms-parser.ts";
import { orderDetailsAliases, orderDetailsDate, orderDetailsPaymentAmount, orderDetailsTransactionStatus, orderDetailsValue } from "./vms-order-details.ts";

export type VmsReferenceMachine = {
  id: string;
  machine_code?: string | null;
  vms_machine_id?: string | null;
  name?: string | null;
  location_id?: string | null;
};

export type VmsReferenceMachineMapping = {
  id?: string | null;
  vms_machine_key?: string | null;
  vms_machine_name?: string | null;
  machine_id?: string | null;
  location_id?: string | null;
  status?: string | null;
  aliases?: string[] | null;
};

export type VmsReferenceMapping = {
  id: string;
  vms_product_id?: string | null;
  vms_product_name?: string | null;
  product_id?: string | null;
  match_status?: string | null;
};

export type VmsReferenceProduct = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  name?: string | null;
};

export type VmsResolvedProduct = {
  status: "matched" | "needs_mapping" | "missing" | "ignored";
  productId: string | null;
  displayValue: string | null;
  source: "vms_mapping" | "product_sku" | "product_barcode" | "product_name" | "none" | "ignored_mapping";
  mapping: VmsReferenceMapping | null;
};

export type VmsRowStatus = "imported" | "needs_mapping" | "unknown_machine" | "invalid_row";

export type VmsValidatedRow = {
  rowNumber: number;
  status: VmsRowStatus;
  severity: "valid" | "warning" | "error";
  reasons: string[];
  machineIdentifier: string | null;
  matchedMachineId: string | null;
  productIdentifier: string | null;
  productName: string | null;
  matchedProductId: string | null;
  originalRow: Record<string, string>;
  mappedRow: Record<string, string>;
};

export type VmsValidationResult = {
  totalRows: number;
  importedRows: number;
  needsProductMappingRows: number;
  unknownMachineRows: number;
  invalidRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  missingProductMappingCount: number;
  unknownMachineCount: number;
  rows: VmsValidatedRow[];
  reviewRowsList: VmsValidatedRow[];
  needsMappingRowsList: VmsValidatedRow[];
  unknownMachineRowsList: VmsValidatedRow[];
  invalidRowsList: VmsValidatedRow[];
  errorRowsList: VmsValidatedRow[];
  warningRowsList: VmsValidatedRow[];
  reviewGroups: VmsReviewIssueGroup[];
};

export type VmsReviewIssueGroup = {
  key: string;
  type: "unknown_product" | "unknown_machine" | "missing_date" | "missing_quantity" | "missing_sales_amount" | "duplicate_suspected" | "header_mapping_missing" | "invalid_row";
  title: string;
  count: number;
  examples: VmsValidatedRow[];
  question: string;
};

export function vmsValue(row: Record<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const found = row[alias] ?? row[normalizeHeader(alias)] ?? row[alias.toLowerCase()];
    if (found !== undefined && String(found).trim() !== "") return String(found).trim();
  }
  return "";
}

export function vmsNumber(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const negative = raw.includes("(") && raw.includes(")");
  let cleaned = raw.replace(/[^\d,.\-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    cleaned = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = cleaned.length - lastComma - 1;
    cleaned = decimals > 0 && decimals <= 2 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null;
}

export function vmsDate(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function vmsMachineIdentifier(row: Record<string, string>) {
  return vmsValue(row, ["machine_identifier", "machine_id", "vms_machine_id", "machine_code", "machine_name", "machine", "terminal_id", "terminal_no", "terminal", "device_id", "device_no", "device", "equipment_id", "machine_no", "machine_number", "vm_code", "asset_code"]);
}

export function vmsProductIdentifier(row: Record<string, string>) {
  return {
    vmsProductId: vmsValue(row, ["product_identifier", "product_id", "vms_product_id", "product_code", "product_number", "product_no", "goods_id", "goods_code", "goods_number", "goods_no", "commodity_id", "commodity_code", "commodity_number", "commodity_no", "sku", "item_code", "item_id", "item_no", "plu", "barcode", "article_no"]),
    vmsProductName: vmsValue(row, ["product_name", "vms_product_name", "product", "product_description", "product_desc", "goods_name", "goods", "commodity_name", "commodity", "item_name", "item", "item_description", "description", "sku_name", "article_name", "merchandise_name", "name"]),
  };
}

export function vmsProductKey(vmsProductId: string, vmsProductName: string) {
  return `${vmsProductId.trim()}::${vmsProductName.trim()}`.toLowerCase();
}

export function vmsLookupKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function vmsNormalizedLookupKey(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();
}

export function vmsProductDisplay(vmsProductId: string, vmsProductName: string) {
  if (vmsProductId && vmsProductName && vmsProductId !== vmsProductName) return `${vmsProductId} - ${vmsProductName}`;
  return vmsProductName || vmsProductId || "";
}

function addMachineKey(map: Map<string, VmsReferenceMachine>, key: string | null | undefined, machine: VmsReferenceMachine) {
  const normalized = vmsLookupKey(key);
  if (normalized) map.set(normalized, machine);
  const compact = vmsNormalizedLookupKey(key);
  if (compact && compact !== normalized) map.set(compact, machine);
}

function addMappingKey(map: Map<string, VmsReferenceMapping>, key: string, mapping: VmsReferenceMapping) {
  if (key.replace(/:/g, "").trim()) map.set(key, mapping);
}

function addProductKey(
  map: Map<string, { product: VmsReferenceProduct; source: VmsResolvedProduct["source"] }>,
  key: string | null | undefined,
  product: VmsReferenceProduct,
  source: VmsResolvedProduct["source"],
) {
  const normalized = vmsLookupKey(key);
  if (normalized && !map.has(normalized)) map.set(normalized, { product, source });
  const compact = vmsNormalizedLookupKey(key);
  if (compact && compact !== normalized && !map.has(compact)) map.set(compact, { product, source });
}

function lookupByFlexibleKey<T>(map: Map<string, T>, value: string | null | undefined) {
  return map.get(vmsLookupKey(value)) ?? map.get(vmsNormalizedLookupKey(value)) ?? null;
}

export function buildMachineMap(machines: VmsReferenceMachine[]) {
  const map = new Map<string, VmsReferenceMachine>();
  machines.forEach((machine) => {
    addMachineKey(map, machine.vms_machine_id, machine);
    addMachineKey(map, machine.machine_code, machine);
    addMachineKey(map, machine.name, machine);
  });
  return map;
}

export function buildMachineMapWithSavedMappings(machines: VmsReferenceMachine[], machineMappings: VmsReferenceMachineMapping[] = []) {
  const machineById = new Map(machines.map((machine) => [String(machine.id), machine]));
  const map = buildMachineMap(machines);

  const khalijUniversityMachine = machines.find((machine) => vmsLookupKey(machine.name) === vmsLookupKey("جامعة طرابلس الاهلية"));
  if (khalijUniversityMachine) {
    ["KhalijUniversity", "Khalij University", "@الخليج", "@خليج"].forEach((alias) => {
      addMachineKey(map, alias, khalijUniversityMachine);
    });
  }

  machineMappings.forEach((mapping) => {
    if (mapping.status && mapping.status !== "confirmed") return;
    const machine = mapping.machine_id ? machineById.get(String(mapping.machine_id)) : null;
    if (!machine) return;
    addMachineKey(map, mapping.vms_machine_key, machine);
    addMachineKey(map, mapping.vms_machine_name, machine);
    (mapping.aliases ?? []).forEach((alias) => addMachineKey(map, alias, machine));
  });

  return map;
}

export function buildProductLookupMap(products: VmsReferenceProduct[]) {
  const map = new Map<string, { product: VmsReferenceProduct; source: VmsResolvedProduct["source"] }>();
  products.forEach((product) => {
    addProductKey(map, product.sku, product, "product_sku");
    addProductKey(map, product.barcode, product, "product_barcode");
    addProductKey(map, product.name, product, "product_name");
  });
  return map;
}

export function buildProductMappingMap(mappings: VmsReferenceMapping[]) {
  const map = new Map<string, VmsReferenceMapping>();
  mappings.forEach((mapping) => {
    const id = String(mapping.vms_product_id ?? "");
    const name = String(mapping.vms_product_name ?? "");
    addMappingKey(map, vmsProductKey(id, name), mapping);
    if (id) addMappingKey(map, vmsProductKey(id, ""), mapping);
    if (name) addMappingKey(map, vmsProductKey("", name), mapping);
    const normalizedId = vmsNormalizedLookupKey(id);
    const normalizedName = vmsNormalizedLookupKey(name);
    addMappingKey(map, vmsProductKey(normalizedId, normalizedName), mapping);
    if (normalizedId) addMappingKey(map, vmsProductKey(normalizedId, ""), mapping);
    if (normalizedName) addMappingKey(map, vmsProductKey("", normalizedName), mapping);
  });
  return map;
}

export function findVmsProductMapping(map: Map<string, VmsReferenceMapping>, vmsProductId: string, vmsProductName: string) {
  return map.get(vmsProductKey(vmsProductId, vmsProductName))
    ?? map.get(vmsProductKey(vmsProductId, ""))
    ?? map.get(vmsProductKey("", vmsProductName))
    ?? map.get(vmsProductKey(vmsNormalizedLookupKey(vmsProductId), vmsNormalizedLookupKey(vmsProductName)))
    ?? map.get(vmsProductKey(vmsNormalizedLookupKey(vmsProductId), ""))
    ?? map.get(vmsProductKey("", vmsNormalizedLookupKey(vmsProductName)))
    ?? null;
}

export function resolveVmsProduct({
  mappingMap,
  productLookupMap,
  vmsProductId,
  vmsProductName,
}: {
  mappingMap: Map<string, VmsReferenceMapping>;
  productLookupMap: Map<string, { product: VmsReferenceProduct; source: VmsResolvedProduct["source"] }>;
  vmsProductId: string;
  vmsProductName: string;
}): VmsResolvedProduct {
  const displayValue = vmsProductDisplay(vmsProductId, vmsProductName) || null;
  if (!displayValue) {
    return { status: "missing", productId: null, displayValue: null, source: "none", mapping: null };
  }

  const mapping = findVmsProductMapping(mappingMap, vmsProductId, vmsProductName || vmsProductId);
  if (mapping?.match_status === "ignored") {
    return { status: "ignored", productId: null, displayValue, source: "ignored_mapping", mapping };
  }

  if (mapping?.product_id && mapping.match_status === "confirmed") {
    return { status: "matched", productId: String(mapping.product_id), displayValue, source: "vms_mapping", mapping };
  }

  const byIdentifier = lookupByFlexibleKey(productLookupMap, vmsProductId);
  if (byIdentifier) {
    return { status: "matched", productId: byIdentifier.product.id, displayValue, source: byIdentifier.source, mapping };
  }

  const byName = lookupByFlexibleKey(productLookupMap, vmsProductName);
  if (byName) {
    return { status: "matched", productId: byName.product.id, displayValue, source: byName.source, mapping };
  }

  return { status: "needs_mapping", productId: null, displayValue, source: "none", mapping };
}

function requiresMachine(reportType: VmsReportType) {
  return ["stock", "sales", "vms_order_details_weekly", "machine_status", "planogram"].includes(reportType);
}

function requiresProductIdentity(reportType: VmsReportType) {
  return ["stock", "sales", "vms_order_details_weekly", "product_list", "planogram"].includes(reportType);
}

export function validateVmsRows({
  reportType,
  rows,
  originalRows,
  firstDataRowNumber,
  machines,
  machineMappings = [],
  mappings,
  products,
  autoCreateMissingProducts = true,
}: {
  reportType: VmsReportType;
  rows: Record<string, string>[];
  originalRows: Record<string, string>[];
  firstDataRowNumber: number;
  machines: VmsReferenceMachine[];
  machineMappings?: VmsReferenceMachineMapping[];
  mappings: VmsReferenceMapping[];
  products: VmsReferenceProduct[];
  autoCreateMissingProducts?: boolean;
}): VmsValidationResult {
  const machineMap = buildMachineMapWithSavedMappings(machines, machineMappings);
  const mappingMap = buildProductMappingMap(mappings);
  const productLookupMap = buildProductLookupMap(products);
  const unknownMachines = new Set<string>();
  const missingMappings = new Set<string>();

  const validatedRows = rows.map((row, index): VmsValidatedRow => {
    const rowNumber = firstDataRowNumber + index;
    const reasons: string[] = [];
    const warnings: string[] = [];
    let machineIsUnknown = false;
    let productNeedsMapping = false;
    const machineId = vmsMachineIdentifier(row);
    const machine = machineId ? lookupByFlexibleKey(machineMap, machineId) : null;
    const { vmsProductId, vmsProductName } = vmsProductIdentifier(row);
    const productResolution = resolveVmsProduct({ mappingMap, productLookupMap, vmsProductId, vmsProductName });

    if (requiresMachine(reportType)) {
      if (!machineId) reasons.push("missing machine id");
      else if (!machine) {
        machineIsUnknown = true;
        warnings.push(`unknown machine: ${machineId}`);
        unknownMachines.add(machineId);
      }
    }

    if (requiresProductIdentity(reportType)) {
      if (productResolution.status === "missing") {
        reasons.push("missing product identifier or name");
      } else if (productResolution.status === "ignored") {
        reasons.push(`product mapping is ignored: ${productResolution.displayValue}`);
      } else if (productResolution.status === "needs_mapping" && reportType === "product_list" && autoCreateMissingProducts) {
        warnings.push(`new product will be created: ${productResolution.displayValue}`);
      } else if (productResolution.status === "needs_mapping") {
        productNeedsMapping = true;
        warnings.push(`unknown product: ${productResolution.displayValue}`);
        if (productResolution.displayValue) missingMappings.add(productResolution.displayValue);
      }
    }

    if (reportType === "stock") {
      const quantity = vmsNumber(vmsValue(row, ["current_qty", "stock_qty", "stock_quantity", "quantity", "qty", "remaining", "remaining_qty", "inventory", "inventory_qty", "on_hand", "balance", "available_qty", "qty_left"]));
      if (quantity === null || quantity < 0) reasons.push("invalid quantity");
      const capturedAt = vmsValue(row, ["captured_at", "last_updated", "updated_at", "date", "report_date", "stock_date"]);
      if (capturedAt && !vmsDate(capturedAt)) warnings.push("invalid date");
    }

    if (reportType === "sales") {
      const amount = vmsNumber(vmsValue(row, ["total_sales_amount", "transaction_amount", "revenue_amount", "sales_amount", "total_sales", "total_sales_lyd", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"]));
      const soldQty = vmsNumber(vmsValue(row, ["sold_qty", "transaction_count", "number_of_transaction", "number_of_transactions", "quantity_sold", "units_sold", "sales_units", "units", "qty", "quantity", "sales_qty", "sales_quantity", "volume", "sales_volume"]));
      if ((amount === null || amount < 0) && (soldQty === null || soldQty < 0)) reasons.push("invalid quantity or amount");
      const rawDate = vmsValue(row, ["sale_date", "period_end", "date", "sales_date", "business_date", "stat_date", "day", "datetime", "timestamp", "settlement_date", "end_date", "report_date"]);
      if (rawDate && !vmsDate(rawDate)) warnings.push("invalid date");
    }

    if (reportType === "vms_order_details_weekly") {
      const amount = orderDetailsPaymentAmount(row);
      const transactionStatus = orderDetailsTransactionStatus(row);
      const rawPaymentTime = orderDetailsValue(row, orderDetailsAliases.paymentTime);
      const rawDeliveryTime = orderDetailsValue(row, orderDetailsAliases.deliveryTime);
      if (amount !== null && amount < 0) reasons.push("invalid payment amount");
      if ((rawPaymentTime && !orderDetailsDate(rawPaymentTime)) || (rawDeliveryTime && !orderDetailsDate(rawDeliveryTime))) warnings.push("invalid transaction date");
      if (!rawPaymentTime && !rawDeliveryTime) warnings.push("missing payment or delivery time");
      if (transactionStatus === "needs_review") warnings.push("transaction status needs review");
    }

    if (reportType === "planogram") {
      const slotCode = vmsValue(row, ["slot_code", "slot", "slot_no", "selection", "selection_code", "selection_no", "tray", "tray_code", "channel", "channel_no", "coil"]);
      if (!slotCode) reasons.push("missing slot/selection code");
      const capacity = vmsValue(row, ["capacity", "max_qty", "max_quantity", "slot_capacity", "par_qty", "current_qty"]);
      if (capacity && (vmsNumber(capacity) === null || Number(vmsNumber(capacity)) <= 0)) warnings.push("invalid quantity");
    }

    const allReasons = [...reasons, ...warnings];
    const status: VmsRowStatus = reasons.length
      ? "invalid_row"
      : machineIsUnknown
        ? "unknown_machine"
        : productNeedsMapping
          ? "needs_mapping"
          : "imported";

    return {
      rowNumber,
      status,
      severity: status === "imported" ? (warnings.length ? "warning" : "valid") : status === "needs_mapping" ? "warning" : "error",
      reasons: allReasons,
      machineIdentifier: machineId || null,
      matchedMachineId: machine?.id ?? null,
      productIdentifier: vmsProductId || null,
      productName: vmsProductName || null,
      matchedProductId: productResolution.productId,
      originalRow: originalRows[index] ?? {},
      mappedRow: row,
    };
  });

  const reviewRowsList = validatedRows.filter((row) => row.status !== "imported");
  const reviewGroups = buildVmsReviewIssueGroups(reviewRowsList);

  return {
    totalRows: validatedRows.length,
    importedRows: validatedRows.filter((row) => row.status === "imported").length,
    needsProductMappingRows: validatedRows.filter((row) => row.status === "needs_mapping").length,
    unknownMachineRows: validatedRows.filter((row) => row.status === "unknown_machine").length,
    invalidRows: validatedRows.filter((row) => row.status === "invalid_row").length,
    validRows: validatedRows.filter((row) => row.severity === "valid").length,
    warningRows: validatedRows.filter((row) => row.severity === "warning").length,
    errorRows: validatedRows.filter((row) => row.severity === "error").length,
    missingProductMappingCount: missingMappings.size,
    unknownMachineCount: unknownMachines.size,
    rows: validatedRows,
    reviewRowsList,
    needsMappingRowsList: validatedRows.filter((row) => row.status === "needs_mapping"),
    unknownMachineRowsList: validatedRows.filter((row) => row.status === "unknown_machine"),
    invalidRowsList: validatedRows.filter((row) => row.status === "invalid_row"),
    errorRowsList: validatedRows.filter((row) => row.severity === "error"),
    warningRowsList: validatedRows.filter((row) => row.severity === "warning"),
    reviewGroups,
  };
}

function issueTypeForRow(row: VmsValidatedRow): VmsReviewIssueGroup["type"] {
  const text = row.reasons.join(" ").toLowerCase();
  if (row.status === "needs_mapping") return "unknown_product";
  if (row.status === "unknown_machine") return "unknown_machine";
  if (text.includes("date") || text.includes("range")) return "missing_date";
  if (text.includes("amount")) return "missing_sales_amount";
  if (text.includes("quantity") || text.includes("qty")) return "missing_quantity";
  if (text.includes("mapping") || text.includes("column")) return "header_mapping_missing";
  if (text.includes("duplicate")) return "duplicate_suspected";
  return "invalid_row";
}

function issueValueForRow(row: VmsValidatedRow, type: VmsReviewIssueGroup["type"]) {
  if (type === "unknown_product") return vmsProductDisplay(row.productIdentifier ?? "", row.productName ?? "") || "Missing product";
  if (type === "unknown_machine") return row.machineIdentifier ?? "Missing machine";
  return row.reasons[0] ?? row.status;
}

function issueQuestion(type: VmsReviewIssueGroup["type"], value: string) {
  if (type === "unknown_product") return `Product '${value}' appears in this upload. Which Snacky product should it map to?`;
  if (type === "unknown_machine") return `Machine '${value}' appears in this upload. Which Snacky machine/location should it map to?`;
  if (type === "missing_date") return "Which report date or date column should Snacky OS use for these rows?";
  if (type === "missing_quantity") return "Which quantity/transaction-count column should Snacky OS use for these rows?";
  if (type === "missing_sales_amount") return "Which sales amount column should Snacky OS use for these rows?";
  if (type === "header_mapping_missing") return "Which VMS column should be mapped for this missing field?";
  if (type === "duplicate_suspected") return "Should these suspected duplicate rows be skipped?";
  return "How should these rows be corrected before import?";
}

function issueTitle(type: VmsReviewIssueGroup["type"], value: string) {
  if (type === "unknown_product") return `Unknown product: ${value}`;
  if (type === "unknown_machine") return `Unknown machine: ${value}`;
  if (type === "missing_date") return "Missing or invalid date";
  if (type === "missing_quantity") return "Missing or invalid quantity";
  if (type === "missing_sales_amount") return "Missing or invalid sales amount";
  if (type === "header_mapping_missing") return "Header mapping missing";
  if (type === "duplicate_suspected") return "Duplicate suspected";
  return `Invalid row: ${value}`;
}

export function buildVmsReviewIssueGroups(rows: VmsValidatedRow[]) {
  const groups = new Map<string, VmsReviewIssueGroup>();
  rows.forEach((row) => {
    const type = issueTypeForRow(row);
    const value = issueValueForRow(row, type);
    const key = `${type}:${vmsLookupKey(value)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 3) existing.examples.push(row);
      return;
    }
    groups.set(key, {
      key,
      type,
      title: issueTitle(type, value),
      count: 1,
      examples: [row],
      question: issueQuestion(type, value),
    });
  });

  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}
