import { normalizeHeader, type VmsReportType } from "@/lib/vms-parser";

export type VmsReferenceMachine = {
  id: string;
  machine_code?: string | null;
  vms_machine_id?: string | null;
  name?: string | null;
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
    vmsProductId: vmsValue(row, ["product_identifier", "product_id", "vms_product_id", "product_code", "product_no", "goods_id", "goods_code", "goods_no", "commodity_id", "commodity_code", "sku", "item_code", "item_id", "item_no", "plu", "barcode", "article_no"]),
    vmsProductName: vmsValue(row, ["product_name", "vms_product_name", "product", "product_description", "product_desc", "goods_name", "goods", "commodity_name", "commodity", "item_name", "item", "item_description", "description", "sku_name", "article_name", "merchandise_name", "name"]),
  };
}

export function vmsProductKey(vmsProductId: string, vmsProductName: string) {
  return `${vmsProductId.trim()}::${vmsProductName.trim()}`.toLowerCase();
}

export function vmsLookupKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function vmsProductDisplay(vmsProductId: string, vmsProductName: string) {
  if (vmsProductId && vmsProductName && vmsProductId !== vmsProductName) return `${vmsProductId} - ${vmsProductName}`;
  return vmsProductName || vmsProductId || "";
}

function addMachineKey(map: Map<string, VmsReferenceMachine>, key: string | null | undefined, machine: VmsReferenceMachine) {
  const normalized = vmsLookupKey(key);
  if (normalized) map.set(normalized, machine);
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
  });
  return map;
}

export function findVmsProductMapping(map: Map<string, VmsReferenceMapping>, vmsProductId: string, vmsProductName: string) {
  return map.get(vmsProductKey(vmsProductId, vmsProductName)) ?? map.get(vmsProductKey(vmsProductId, "")) ?? map.get(vmsProductKey("", vmsProductName)) ?? null;
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

  const byIdentifier = productLookupMap.get(vmsLookupKey(vmsProductId));
  if (byIdentifier) {
    return { status: "matched", productId: byIdentifier.product.id, displayValue, source: byIdentifier.source, mapping };
  }

  const byName = productLookupMap.get(vmsLookupKey(vmsProductName));
  if (byName) {
    return { status: "matched", productId: byName.product.id, displayValue, source: byName.source, mapping };
  }

  return { status: "needs_mapping", productId: null, displayValue, source: "none", mapping };
}

function requiresMachine(reportType: VmsReportType) {
  return ["stock", "sales", "machine_status", "planogram"].includes(reportType);
}

function requiresProductIdentity(reportType: VmsReportType) {
  return ["stock", "sales", "product_list", "planogram"].includes(reportType);
}

export function validateVmsRows({
  reportType,
  rows,
  originalRows,
  firstDataRowNumber,
  machines,
  mappings,
  products,
  autoCreateMissingProducts = true,
}: {
  reportType: VmsReportType;
  rows: Record<string, string>[];
  originalRows: Record<string, string>[];
  firstDataRowNumber: number;
  machines: VmsReferenceMachine[];
  mappings: VmsReferenceMapping[];
  products: VmsReferenceProduct[];
  autoCreateMissingProducts?: boolean;
}): VmsValidationResult {
  const machineMap = buildMachineMap(machines);
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
    const machine = machineId ? machineMap.get(vmsLookupKey(machineId)) : null;
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
      const amount = vmsNumber(vmsValue(row, ["total_sales_amount", "revenue_amount", "sales_amount", "total_sales", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"]));
      const soldQty = vmsNumber(vmsValue(row, ["sold_qty", "quantity_sold", "units_sold", "sales_units", "units", "qty", "quantity", "sales_qty", "sales_quantity", "volume", "sales_volume"]));
      if ((amount === null || amount < 0) && (soldQty === null || soldQty < 0)) reasons.push("invalid quantity or amount");
      const rawDate = vmsValue(row, ["sale_date", "period_end", "date", "sales_date", "business_date", "stat_date", "day", "datetime", "timestamp", "settlement_date", "end_date", "report_date"]);
      if (rawDate && !vmsDate(rawDate)) warnings.push("invalid date");
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
      productIdentifier: vmsProductId || null,
      productName: vmsProductName || null,
      matchedProductId: productResolution.productId,
      originalRow: originalRows[index] ?? {},
      mappedRow: row,
    };
  });

  const reviewRowsList = validatedRows.filter((row) => row.status !== "imported");

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
  };
}
