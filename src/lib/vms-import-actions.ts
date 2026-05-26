"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canConfirmVmsImports, canCreateVmsImports } from "@/lib/authz";
import {
  applyColumnMapping,
  findSalesReportPeriod,
  parseReportType,
  parseVmsUpload,
  requiredMissing,
  sheetRowsToRecords,
  normalizeHeader,
  VMS_SALES_DATE_RANGE_ERROR,
  vmsExpectedFields,
  type VmsSalesReportPeriod,
  type VmsReportType,
} from "@/lib/vms-parser";
import {
  VMS_IMPORT_MODES,
  createVmsSalesSourceRowKey,
  parseVmsImportMode,
  splitColumnMappingByRequirement,
  vmsHeaderSignature,
  type VmsImportMode,
} from "@/lib/vms-sales-import";
import { buildProductLookupMap, resolveVmsProduct, vmsLookupKey, vmsProductDisplay } from "@/lib/vms-import-validation";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type ImportSummary = {
  reportType: VmsReportType;
  importMode: VmsImportMode;
  fileName: string;
  fileType: string;
  sheetName: string;
  totalRows: number;
  rowsFound: number;
  importedRows: number;
  needsProductMappingRows: number;
  unknownMachineRows: number;
  invalidRows: number;
  skippedRows: number;
  rowsSkippedDuplicate: number;
  rowsNeedingReview: number;
  productsCreated: number;
  productsUpdated: number;
  mappingsCreated: number;
  mappingsUpdated: number;
  mappingsNeedingReview: number;
  autoCreateMissingProducts: boolean;
  updateCostFromVms: boolean;
  unknownMachines: string[];
  unmappedProducts: string[];
  errors: string[];
  columnMapping: Record<string, string>;
  salesReportPeriod?: VmsSalesReportPeriod | null;
};

type VmsRawRowStatus = "pending" | "imported" | "needs_mapping" | "unknown_machine" | "invalid_row" | "skipped";

type VmsRawRowPayload = {
  import_batch_id: string;
  row_number: number;
  raw_data: Record<string, string>;
  normalized_data: Record<string, string>;
  validation_status: VmsRawRowStatus;
  validation_errors: string[];
  machine_match_status: string | null;
  product_match_status: string | null;
  matched_machine_id: string | null;
  matched_product_id: string | null;
};

function value(row: Record<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const found = row[alias] ?? row[normalizeHeader(alias)] ?? row[alias.toLowerCase()];
    if (found !== undefined && found !== "") return found;
  }
  return "";
}

function booleanOption(input: FormDataEntryValue | string | null | undefined, defaultValue: boolean) {
  if (input === null || input === undefined || input === "") return defaultValue;
  const normalized = String(input).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function numberValue(input: string) {
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

function dateValue(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

const salesRowDateAliases = ["sale_date", "period_end", "date", "sales_date", "business_date", "stat_date", "day", "datetime", "timestamp", "settlement_date", "end_date", "report_date"];

function dateOnlyFromDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function startOfDateIso(dateOnly: string) {
  return `${dateOnly}T00:00:00.000Z`;
}

function endOfDateIso(dateOnly: string) {
  return `${dateOnly}T23:59:59.999Z`;
}

function monthStartFromDateOnly(dateOnly: string) {
  const [year, month] = dateOnly.split("-");
  return `${year}-${month}-01`;
}

function salesPeriodFromRowDate(row: Record<string, string>): VmsSalesReportPeriod | null {
  const periodDate = dateValue(value(row, salesRowDateAliases));
  if (!periodDate) return null;
  const reportStartDate = dateOnlyFromDate(periodDate);
  return {
    reportStartDate,
    reportEndDate: reportStartDate,
    salesMonth: monthStartFromDateOnly(reportStartDate),
    sourceTitle: "",
    sourceRowIndex: -1,
  };
}

function hasSalesRowDate(rows: Record<string, string>[]) {
  return rows.some((row) => Boolean(salesPeriodFromRowDate(row)));
}

function productKey(vmsProductId: string, vmsProductName: string) {
  return `${vmsProductId.trim()}::${vmsProductName.trim()}`.toLowerCase();
}

function uniquePush(list: string[], item: string) {
  if (item && !list.includes(item)) list.push(item);
}

function addMappingKey(map: Map<string, any>, vmsProductId: string, vmsProductName: string, mapping: any) {
  const key = productKey(vmsProductId, vmsProductName);
  if (key.replace(/:/g, "").trim()) map.set(key, mapping);
}

function findMapping(map: Map<string, any>, vmsProductId: string, vmsProductName: string) {
  return map.get(productKey(vmsProductId, vmsProductName)) ?? map.get(productKey(vmsProductId, "")) ?? map.get(productKey("", vmsProductName)) ?? null;
}

function machineIdentifier(row: Record<string, string>) {
  return value(row, ["machine_identifier", "machine_id", "vms_machine_id", "machine_code", "machine_name", "machine", "terminal_id", "terminal_no", "terminal", "device_id", "device_no", "device", "equipment_id", "machine_no", "machine_number", "vm_code", "asset_code"]);
}

function productIdentifier(row: Record<string, string>) {
  return {
    vmsProductId: value(row, ["product_identifier", "vms_product_id", "product_code", "product_id", "product_number", "product_no", "goods_id", "goods_code", "goods_number", "goods_no", "commodity_id", "commodity_code", "commodity_number", "commodity_no", "sku", "item_code", "item_id", "item_no", "plu", "barcode", "article_no"]),
    vmsProductName: value(row, ["product_name", "vms_product_name", "product", "product_description", "product_desc", "goods_name", "goods", "commodity_name", "commodity", "item_name", "item", "item_description", "description", "sku_name", "article_name", "merchandise_name", "name"]),
  };
}

function rawRowPayload({
  batchId,
  rowNumber,
  originalRow,
  mappedRow,
  status = "pending",
  reasons = [],
  machineMatchStatus = null,
  productMatchStatus = null,
  matchedMachineId = null,
  matchedProductId = null,
}: {
  batchId: string;
  rowNumber: number;
  originalRow: Record<string, string>;
  mappedRow: Record<string, string>;
  status?: VmsRawRowStatus;
  reasons?: string[];
  machineMatchStatus?: string | null;
  productMatchStatus?: string | null;
  matchedMachineId?: string | null;
  matchedProductId?: string | null;
}): VmsRawRowPayload {
  return {
    import_batch_id: batchId,
    row_number: rowNumber,
    raw_data: originalRow,
    normalized_data: mappedRow,
    validation_status: status,
    validation_errors: reasons,
    machine_match_status: machineMatchStatus,
    product_match_status: productMatchStatus,
    matched_machine_id: matchedMachineId,
    matched_product_id: matchedProductId,
  };
}

async function upsertRawRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  rows: VmsRawRowPayload[],
) {
  for (let index = 0; index < rows.length; index += 250) {
    const chunk = rows.slice(index, index + 250);
    if (!chunk.length) continue;
    const { error } = await supabase
      .from("vms_import_rows")
      .upsert(chunk, { onConflict: "import_batch_id,row_number" });
    if (error) {
      console.error("[vms-import] Raw row upsert failed", error);
      return false;
    }
  }
  return true;
}

function reportRequiresMachine(reportType: VmsReportType) {
  return ["stock", "sales", "machine_status", "planogram"].includes(reportType);
}

function reportRequiresProduct(reportType: VmsReportType) {
  return ["stock", "sales", "product_list", "planogram"].includes(reportType);
}

function markInvalidRow(summary: ImportSummary, rowNumber: number, reason: string) {
  summary.invalidRows += 1;
  summary.skippedRows += 1;
  summary.errors.push(`Row ${rowNumber}: ${reason}`);
}

function markUnknownMachine(summary: ImportSummary, rowNumber: number, identifier: string) {
  summary.unknownMachineRows += 1;
  summary.skippedRows += 1;
  uniquePush(summary.unknownMachines, identifier || `Row ${rowNumber}`);
  summary.errors.push(`Row ${rowNumber}: unknown machine ${identifier || "blank"}.`);
}

function markNeedsProductMapping(summary: ImportSummary, productLabel: string) {
  summary.needsProductMappingRows += 1;
  uniquePush(summary.unmappedProducts, productLabel);
}

function explicitSellingPrice(row: Record<string, string>) {
  return numberValue(value(row, ["commodity_price", "commodity_unit_price", "selling_price", "sale_price", "sales_price", "vms_selling_price", "selling_price_lyd", "unit_price", "retail_price", "price"]));
}

function explicitCostPrice(row: Record<string, string>) {
  return numberValue(value(row, ["cost_price", "purchase_price", "vms_cost_price", "cost_price_lyd", "unit_cost", "cost"]));
}

function cleanCatalogText(input: unknown) {
  return String(input ?? "").trim();
}

function stableCatalogHash(input: string) {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

function generatedCatalogSku(vmsProductId: string, barcode: string, productName: string) {
  const directSource = cleanCatalogText(vmsProductId) || cleanCatalogText(barcode);
  if (directSource) return directSource.slice(0, 96);

  const asciiName = cleanCatalogText(productName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const hash = stableCatalogHash(productName || "vms-product");
  return asciiName ? `VMS-${asciiName}-${hash}` : `VMS-${hash}`;
}

function productListBarcode(row: Record<string, string>) {
  const explicitBarcode = cleanCatalogText(value(row, ["barcode", "bar_code", "ean", "upc"]));
  if (explicitBarcode) return explicitBarcode;
  const identifier = cleanCatalogText(value(row, ["product_identifier"]));
  return /^\d{8,14}$/.test(identifier) ? identifier : "";
}

function productListCategory(row: Record<string, string>) {
  return cleanCatalogText(value(row, ["category", "type", "product_category", "group", "product_type"]));
}

function productListBrand(row: Record<string, string>) {
  return cleanCatalogText(value(row, ["brand", "manufacturer"]));
}

function productListImage(row: Record<string, string>) {
  return cleanCatalogText(value(row, ["image_url", "image", "photo", "picture"]));
}

function productListActiveStatus(row: Record<string, string>) {
  const raw = cleanCatalogText(value(row, ["active_status", "active", "status", "enabled"])).toLowerCase();
  if (!raw) return null;
  if (["0", "false", "no", "n", "inactive", "disabled", "hidden", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "y", "active", "enabled", "visible", "on"].includes(raw)) return true;
  return null;
}

function findCatalogProduct(
  products: any[],
  {
    productId,
    sku,
    barcode,
    name,
  }: {
    productId?: string | null;
    sku?: string | null;
    barcode?: string | null;
    name?: string | null;
  },
) {
  const skuKey = vmsLookupKey(sku);
  const barcodeKey = vmsLookupKey(barcode);
  const nameKey = vmsLookupKey(name);
  return (
    (productId ? products.find((product) => String(product.id) === String(productId)) : null) ??
    (skuKey ? products.find((product) => vmsLookupKey(product.sku) === skuKey) : null) ??
    (barcodeKey ? products.find((product) => vmsLookupKey(product.barcode) === barcodeKey) : null) ??
    (nameKey ? products.find((product) => vmsLookupKey(product.name) === nameKey) : null) ??
    null
  );
}

function mergeProductReference(products: any[], product: any) {
  const index = products.findIndex((item) => String(item.id) === String(product.id));
  const reference = {
    id: product.id,
    sku: product.sku ?? null,
    barcode: product.barcode ?? null,
    name: product.name ?? null,
  };
  if (index >= 0) products[index] = { ...products[index], ...reference };
  else products.push(reference);
}

async function upsertVmsCatalogProduct({
  supabase,
  productRows,
  existingProductId,
  row,
  vmsProductId,
  vmsProductName,
  updateCostFromVms,
  batchId,
  lastSeenAt,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  productRows: any[];
  existingProductId: string | null;
  row: Record<string, string>;
  vmsProductId: string;
  vmsProductName: string;
  updateCostFromVms: boolean;
  batchId: string;
  lastSeenAt: Date;
}) {
  const barcode = productListBarcode(row);
  const productName = cleanCatalogText(vmsProductName || vmsProductId || barcode);
  const sku = generatedCatalogSku(vmsProductId, barcode, productName);
  const category = productListCategory(row);
  const brand = productListBrand(row);
  const imageUrl = productListImage(row);
  const active = productListActiveStatus(row);
  const sellingPrice = explicitSellingPrice(row);
  const costPrice = explicitCostPrice(row);
  const existingProduct = findCatalogProduct(productRows, {
    productId: existingProductId,
    sku,
    barcode,
    name: productName,
  });
  const now = new Date().toISOString();

  if (!productName) {
    return { product: null, action: "invalid" as const, error: "missing product identifier or name" };
  }

  if (existingProduct?.id) {
    const payload: Record<string, unknown> = {
      import_source: "vms_import",
      last_vms_import_batch_id: batchId,
      last_vms_seen_at: lastSeenAt.toISOString(),
      updated_at: now,
    };
    if (productName) payload.name = productName;
    if (barcode) payload.barcode = barcode;
    if (category) payload.category = category;
    if (brand) payload.brand = brand;
    if (imageUrl) payload.image_url = imageUrl;
    if (active !== null) payload.active = active;
    if (sellingPrice !== null && sellingPrice >= 0) {
      Object.assign(payload, {
        selling_price: sellingPrice,
        current_selling_price_lyd: sellingPrice,
        vms_selling_price_lyd: sellingPrice,
        selling_price_source: "vms",
        price_updated_at: now,
      });
    }
    if (updateCostFromVms && costPrice !== null && costPrice >= 0) {
      Object.assign(payload, {
        cost_price: costPrice,
        current_cost_price_lyd: costPrice,
        cost_price_source: "vms",
        price_updated_at: now,
      });
    }

    const { data, error } = await supabase
      .from("products")
      .update(payload)
      .eq("id", existingProduct.id)
      .select("id, sku, barcode, name")
      .maybeSingle();

    if (error) return { product: null, action: "invalid" as const, error: error.message };
    const product = data ?? existingProduct;
    mergeProductReference(productRows, product);
    return { product, action: "updated" as const, error: null };
  }

  const payload: Record<string, unknown> = {
    sku,
    barcode: barcode || null,
    name: productName,
    category: category || "snack",
    brand: brand || null,
    image_url: imageUrl || null,
    active: active ?? true,
    cost_price: updateCostFromVms && costPrice !== null && costPrice >= 0 ? costPrice : 0,
    selling_price: sellingPrice !== null && sellingPrice >= 0 ? sellingPrice : 0,
    current_cost_price_lyd: updateCostFromVms && costPrice !== null && costPrice >= 0 ? costPrice : 0,
    current_selling_price_lyd: sellingPrice !== null && sellingPrice >= 0 ? sellingPrice : 0,
    cost_price_source: updateCostFromVms && costPrice !== null && costPrice >= 0 ? "vms" : "initial_import",
    selling_price_source: sellingPrice !== null && sellingPrice >= 0 ? "vms" : "initial_import",
    price_updated_at: sellingPrice !== null || (updateCostFromVms && costPrice !== null) ? now : null,
    vms_selling_price_lyd: sellingPrice !== null && sellingPrice >= 0 ? sellingPrice : null,
    import_source: "vms_import",
    last_vms_import_batch_id: batchId,
    last_vms_seen_at: lastSeenAt.toISOString(),
  };

  const { data, error } = await supabase
    .from("products")
    .insert(payload)
    .select("id, sku, barcode, name")
    .maybeSingle();

  if (error) {
    const { data: duplicate } = await supabase
      .from("products")
      .select("id, sku, barcode, name")
      .eq("sku", sku)
      .maybeSingle();
    if (duplicate?.id) {
      mergeProductReference(productRows, duplicate);
      return { product: duplicate, action: "updated" as const, error: null };
    }
    return { product: null, action: "invalid" as const, error: error.message };
  }

  if (data) mergeProductReference(productRows, data);
  return { product: data, action: "created" as const, error: null };
}

async function ensureConfirmedMapping({
  supabase,
  mappingsByKey,
  profile,
  vmsProductId,
  vmsProductName,
  productId,
  importedSellingPrice,
  importedCostPrice,
  machineId,
  vmsMachineIdentifier,
  machineName,
  lastSeenAt,
  batchId,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  mappingsByKey: Map<string, any>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  vmsProductId: string;
  vmsProductName: string;
  productId: string;
  importedSellingPrice: number | null;
  importedCostPrice: number | null;
  machineId: string | null;
  vmsMachineIdentifier: string | null;
  machineName: string | null;
  lastSeenAt: Date;
  batchId: string;
}) {
  const mappingName = cleanCatalogText(vmsProductName || vmsProductId);
  const existing = findMapping(mappingsByKey, vmsProductId, mappingName);
  const payload = {
    vms_product_id: vmsProductId || null,
    vms_product_name: mappingName,
    product_id: productId,
    match_status: "confirmed",
    confidence_score: 1,
    vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : existing?.vms_selling_price_lyd ?? null,
    vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : existing?.vms_cost_price_lyd ?? null,
    latest_machine_id: machineId,
    latest_vms_machine_id: vmsMachineIdentifier,
    latest_machine_name: machineName,
    last_seen_at: lastSeenAt.toISOString(),
    last_import_batch_id: batchId,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data } = await supabase
      .from("vms_product_mappings")
      .update(payload)
      .eq("id", existing.id)
      .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
      .maybeSingle();
    const mapping = data ?? { ...existing, ...payload };
    addMappingKey(mappingsByKey, vmsProductId, mappingName, mapping);
    if (vmsProductId) addMappingKey(mappingsByKey, vmsProductId, "", mapping);
    if (mappingName) addMappingKey(mappingsByKey, "", mappingName, mapping);
    return { mapping, action: "updated" as const };
  }

  const { data, error } = await supabase
    .from("vms_product_mappings")
    .insert(payload)
    .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
    .maybeSingle();

  if (error) {
    console.error("[vms-import] Confirmed mapping insert failed", error);
    return null;
  }

  if (data) {
    addMappingKey(mappingsByKey, vmsProductId, mappingName, data);
    if (vmsProductId) addMappingKey(mappingsByKey, vmsProductId, "", data);
    if (mappingName) addMappingKey(mappingsByKey, "", mappingName, data);
    await logActivity({
      profile,
      action: "create",
      entityType: "vms_mapping",
      entityId: data.id,
      entityLabel: data.vms_product_name,
      afterData: data,
      summary: `Confirmed VMS product mapping for ${data.vms_product_name}`,
    });
  }

  return data ? { mapping: data, action: "created" as const } : null;
}

function previewRedirect(previewId: string, sheetName: string, reportType: string, error?: string, headerRow?: number) {
  const params = new URLSearchParams({ previewId, sheet: sheetName, reportType });
  if (headerRow !== undefined) params.set("headerRow", String(headerRow));
  if (error) params.set("error", error);
  redirect(`/vms-import?${params.toString()}`);
}

function readMapping(formData: FormData, reportType: VmsReportType) {
  const mapping: Record<string, string> = {};
  for (const field of vmsExpectedFields[reportType]) {
    mapping[field.field] = String(formData.get(`map_${field.field}`) || "");
  }
  return mapping;
}

async function saveHeaderMappingMemory({
  supabase,
  profile,
  reportType,
  headerNames,
  mapping,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  reportType: VmsReportType;
  headerNames: string[];
  mapping: Record<string, string>;
}) {
  if (!headerNames.length) return;
  const sourceSignature = vmsHeaderSignature(reportType, headerNames);
  const splitMapping = splitColumnMappingByRequirement(reportType, mapping);
  const { error } = await supabase
    .from("vms_header_mappings")
    .upsert({
      report_type: reportType,
      source_signature: sourceSignature,
      header_names: headerNames,
      required_field_mapping: splitMapping.required,
      optional_field_mapping: splitMapping.optional,
      last_used_mapping: mapping,
      updated_by: profile?.team_member_id ?? null,
      updated_at: new Date().toISOString(),
      created_by: profile?.team_member_id ?? null,
    }, { onConflict: "report_type,source_signature" });
  if (error) {
    console.error("[vms-import] Header mapping memory save failed", {
      reportType,
      sourceSignature,
      errorCode: error.code,
      errorMessage: error.message,
      error,
    });
  }
}

async function loadMachineMappingMemory(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const [{ data: mappings, error: mappingError }, { data: aliases, error: aliasError }] = await Promise.all([
    supabase.from("vms_machine_mappings").select("id, vms_machine_key, vms_machine_name, machine_id, location_id, status, aliases"),
    supabase.from("vms_machine_aliases").select("mapping_id, alias, alias_key"),
  ]);
  if (mappingError || aliasError) {
    console.error("[vms-import] Machine mapping memory load failed", {
      mappingErrorCode: mappingError?.code,
      mappingErrorMessage: mappingError?.message,
      aliasErrorCode: aliasError?.code,
      aliasErrorMessage: aliasError?.message,
    });
    return [];
  }
  const aliasByMapping = new Map<string, string[]>();
  (aliases ?? []).forEach((alias: any) => {
    const key = String(alias.mapping_id ?? "");
    if (!key) return;
    aliasByMapping.set(key, [...(aliasByMapping.get(key) ?? []), String(alias.alias ?? alias.alias_key ?? "")].filter(Boolean));
  });
  return (mappings ?? []).map((mapping: any) => ({
    ...mapping,
    aliases: [...(Array.isArray(mapping.aliases) ? mapping.aliases : []), ...(aliasByMapping.get(String(mapping.id)) ?? [])],
  }));
}

function addMachineMemoryKey(map: Map<string, any>, key: string | null | undefined, machine: any) {
  const normalized = vmsLookupKey(key);
  if (normalized && !map.has(normalized)) map.set(normalized, machine);
}

async function rememberMachineMapping({
  supabase,
  profile,
  vmsMachineIdentifier,
  machine,
  status = "confirmed",
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  vmsMachineIdentifier: string;
  machine?: any | null;
  status?: "confirmed" | "needs_review";
}) {
  const key = vmsLookupKey(vmsMachineIdentifier);
  if (!key) return;
  const payload: Record<string, unknown> = {
    vms_machine_key: key,
    vms_machine_name: vmsMachineIdentifier,
    machine_id: machine?.id ?? null,
    location_id: machine?.location_id ?? null,
    confidence_score: machine?.id ? 1 : 0,
    status,
    aliases: [vmsMachineIdentifier],
    updated_by: profile?.team_member_id ?? null,
    updated_at: new Date().toISOString(),
    created_by: profile?.team_member_id ?? null,
  };
  const { data, error } = await supabase
    .from("vms_machine_mappings")
    .upsert(payload, { onConflict: "vms_machine_key" })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[vms-import] Machine mapping memory save failed", {
      vmsMachineIdentifier,
      machineId: machine?.id ?? null,
      errorCode: error.code,
      errorMessage: error.message,
      error,
    });
    return;
  }
  if (data?.id) {
    await supabase
      .from("vms_machine_aliases")
      .upsert({
        mapping_id: data.id,
        alias: vmsMachineIdentifier,
        alias_key: key,
      }, { onConflict: "alias_key" });
  }
}

async function ensureNeedsReviewMapping(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  mappingsByKey: Map<string, any>,
  profile: Awaited<ReturnType<typeof getCurrentProfile>>,
  vmsProductId: string,
  vmsProductName: string,
) {
  const key = productKey(vmsProductId, vmsProductName);
  if (mappingsByKey.has(key)) return mappingsByKey.get(key);

  const { data } = await supabase
    .from("vms_product_mappings")
    .insert({
      vms_product_id: vmsProductId || null,
      vms_product_name: vmsProductName,
      match_status: "needs_review",
      confidence_score: 0,
    })
    .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
    .maybeSingle();

  if (data) {
    mappingsByKey.set(key, data);
    if (vmsProductId) mappingsByKey.set(productKey(vmsProductId, ""), data);
    if (vmsProductName) mappingsByKey.set(productKey("", vmsProductName), data);
    await logActivity({
      profile,
      action: "create",
      entityType: "vms_mapping",
      entityId: data.id,
      entityLabel: data.vms_product_name,
      afterData: data,
      summary: `Created VMS product mapping for ${data.vms_product_name}`,
    });
  }
  return data;
}

async function applyMachineStatus(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  machineId: string,
  row: Record<string, string>,
  fallbackDate: Date,
) {
  const updates: Record<string, unknown> = {
    last_vms_status_at: (dateValue(value(row, ["last_online_at", "captured_at", "date", "last_updated", "updated_at", "report_date", "sync_time"])) ?? fallbackDate).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const onlineStatus = value(row, ["online_status", "status", "connection_status", "machine_status", "network_status", "state"]);
  const temperature = numberValue(value(row, ["temperature", "temperature_c", "temp", "cabinet_temperature"]));
  const cashBalance = numberValue(value(row, ["cash_balance", "banknote_balance", "cash_amount", "cash_in_machine", "cash_box"]));
  const emptyTrays = numberValue(value(row, ["empty_trays", "empty_slots", "empty_selections", "empty_channels", "empty_count"]));

  if (onlineStatus) updates.vms_online_status = onlineStatus;
  if (temperature !== null) updates.vms_temperature_c = temperature;
  if (cashBalance !== null) updates.vms_cash_balance_lyd = cashBalance;
  if (emptyTrays !== null) updates.vms_empty_trays = Math.max(0, Math.floor(emptyTrays));

  await supabase.from("machines").update(updates).eq("id", machineId);
}

async function markStaleSnapshotRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  table: "vms_stock_snapshots" | "vms_sales_snapshots",
  batchId: string,
  activeRowNumbers: number[],
) {
  const stalePayload = { import_row_status: "reprocessed_stale" };
  if (!activeRowNumbers.length) {
    const { error } = await supabase.from(table).update(stalePayload).eq("import_batch_id", batchId);
    if (error) throw error;
    return;
  }

  const uniqueRowNumbers = Array.from(new Set(activeRowNumbers)).sort((a, b) => a - b);
  const { error: nullError } = await supabase
    .from(table)
    .update(stalePayload)
    .eq("import_batch_id", batchId)
    .is("import_row_number", null);
  if (nullError) throw nullError;

  const { error } = await supabase
    .from(table)
    .update(stalePayload)
    .eq("import_batch_id", batchId)
    .not("import_row_number", "in", `(${uniqueRowNumbers.join(",")})`);
  if (error) throw error;
}

async function runVmsImport({
  supabase,
  profile,
  existingBatchId,
  reportType,
  importMode = VMS_IMPORT_MODES.APPEND_NEW,
  fileName,
  fileType,
  sheetName,
  headerNames = [],
  rows,
  originalRows,
  columnMapping,
  firstDataRowNumber = 2,
  sourceRowNumbers,
  salesReportPeriod = null,
  reportStartDate = salesReportPeriod?.reportStartDate ?? null,
  reportEndDate = salesReportPeriod?.reportEndDate ?? null,
  autoCreateMissingProducts = true,
  updateCostFromVms = false,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  existingBatchId?: string;
  reportType: VmsReportType;
  importMode?: VmsImportMode;
  fileName: string;
  fileType: string;
  sheetName: string;
  headerNames?: string[];
  rows: Record<string, string>[];
  originalRows?: Record<string, string>[];
  columnMapping: Record<string, string>;
  firstDataRowNumber?: number;
  sourceRowNumbers?: number[];
  salesReportPeriod?: VmsSalesReportPeriod | null;
  reportStartDate?: string | null;
  reportEndDate?: string | null;
  autoCreateMissingProducts?: boolean;
  updateCostFromVms?: boolean;
}) {
  if (reportType === "sales" && !salesReportPeriod && !hasSalesRowDate(rows)) {
    const target = existingBatchId ? `/vms-import/${existingBatchId}` : "/vms-import";
    redirect(`${target}?error=${encodeURIComponent(VMS_SALES_DATE_RANGE_ERROR)}`);
  }

  const summary: ImportSummary = {
    reportType,
    importMode,
    fileName,
    fileType,
    sheetName,
    totalRows: rows.length,
    rowsFound: rows.length,
    importedRows: 0,
    needsProductMappingRows: 0,
    unknownMachineRows: 0,
    invalidRows: 0,
    skippedRows: 0,
    rowsSkippedDuplicate: 0,
    rowsNeedingReview: 0,
    productsCreated: 0,
    productsUpdated: 0,
    mappingsCreated: 0,
    mappingsUpdated: 0,
    mappingsNeedingReview: 0,
    autoCreateMissingProducts,
    updateCostFromVms,
    unknownMachines: [],
    unmappedProducts: [],
    errors: [],
    columnMapping,
    salesReportPeriod,
  };

  let batch: { id: string; reprocess_count?: number | null } | null = null;

  if (existingBatchId) {
    const { data: existingBatch, error: existingBatchError } = await supabase
      .from("vms_import_batches")
      .select("id, reprocess_count")
      .eq("id", existingBatchId)
      .maybeSingle();

    if (existingBatchError || !existingBatch?.id) {
      console.error("[vms-import] Reprocess batch lookup failed", existingBatchError);
      redirect("/vms-import?error=Could%20not%20find%20that%20VMS%20import%20batch.");
    }

    batch = existingBatch;
    await supabase
      .from("vms_import_batches")
      .update({
        status: "processing",
        import_mode: importMode,
        report_start_date: reportStartDate,
        report_end_date: reportEndDate,
        row_count: rows.length,
        rows_found: rows.length,
        rows_imported: 0,
        rows_skipped: 0,
        rows_skipped_duplicate: 0,
        rows_needing_review: 0,
        error_count: 0,
        errors: [],
        unknown_machines: [],
        unmapped_products: [],
        column_mapping: columnMapping,
      })
      .eq("id", batch.id);

  } else {
    const { data: newBatch, error: batchError } = await supabase
      .from("vms_import_batches")
      .insert({
        source_type: `${reportType}_${fileType}`,
        file_name: fileName,
        file_type: fileType,
        sheet_name: sheetName,
        report_type: reportType,
        imported_by: profile?.team_member_id ?? null,
        uploaded_by: profile?.team_member_id ?? null,
        uploaded_at: new Date().toISOString(),
        status: "processing",
        import_mode: importMode,
        report_start_date: reportStartDate,
        report_end_date: reportEndDate,
        row_count: rows.length,
        rows_found: rows.length,
        column_mapping: columnMapping,
      })
      .select("id, reprocess_count")
      .single();

    if (batchError || !newBatch?.id) {
      console.error("[vms-import] Failed to create batch", batchError);
      redirect("/vms-import?error=Could%20not%20create%20import%20batch.");
    }

    batch = newBatch;
  }

  if (!batch?.id) redirect("/vms-import?error=Could%20not%20prepare%20VMS%20import%20batch.");

  const initialRawRows = rows.map((row, index) => rawRowPayload({
    batchId: batch.id,
    rowNumber: sourceRowNumbers?.[index] ?? index + firstDataRowNumber,
    originalRow: originalRows?.[index] ?? row,
    mappedRow: row,
  }));
  await upsertRawRows(supabase, initialRawRows);

  if (importMode === VMS_IMPORT_MODES.PREVIEW_ONLY) {
    summary.skippedRows = rows.length;
    const batchUpdate: Record<string, unknown> = {
      status: "previewed",
      row_count: summary.totalRows,
      rows_found: summary.rowsFound,
      rows_imported: 0,
      rows_skipped: rows.length,
      rows_skipped_duplicate: 0,
      rows_needing_review: 0,
      error_count: 0,
      errors: [],
      preview_summary: summary,
      review_summary: [],
      notes: JSON.stringify(summary),
    };
    await supabase.from("vms_import_batches").update(batchUpdate).eq("id", batch.id);
    await saveHeaderMappingMemory({ supabase, profile, reportType, headerNames, mapping: columnMapping });
    await logActivity({
      profile,
      action: "preview_vms",
      entityType: "vms_import",
      entityId: batch.id,
      entityLabel: `${reportType} ${fileType.toUpperCase()} ${fileName}`,
      afterData: summary,
      metadata: { report_type: reportType, file_name: fileName, file_type: fileType, sheet_name: sheetName, import_mode: importMode },
      summary: `Previewed ${summary.totalRows} ${reportType} rows from VMS ${fileType.toUpperCase()}`,
    });
    revalidatePath("/vms-import");
    redirect(`/vms-import/${batch.id}`);
  }

  const [{ data: machines }, { data: mappings }, { data: products }, machineMappingMemory] = await Promise.all([
    supabase.from("machines").select("id, machine_code, vms_machine_id, name, location_id"),
    supabase.from("vms_product_mappings").select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd"),
    supabase.from("products").select("id, sku, barcode, name"),
    loadMachineMappingMemory(supabase),
  ]);

  const machineByVmsId = new Map<string, any>();
  (machines ?? []).forEach((machine: any) => {
    if (machine.vms_machine_id) machineByVmsId.set(vmsLookupKey(machine.vms_machine_id), machine);
    if (machine.machine_code) machineByVmsId.set(vmsLookupKey(machine.machine_code), machine);
    if (machine.name) machineByVmsId.set(vmsLookupKey(machine.name), machine);
  });
  const machineById = new Map((machines ?? []).map((machine: any) => [String(machine.id), machine]));
  (machineMappingMemory ?? []).forEach((mapping: any) => {
    if (mapping.status && mapping.status !== "confirmed") return;
    const machine = mapping.machine_id ? machineById.get(String(mapping.machine_id)) : null;
    if (!machine) return;
    addMachineMemoryKey(machineByVmsId, mapping.vms_machine_key, machine);
    addMachineMemoryKey(machineByVmsId, mapping.vms_machine_name, machine);
    (mapping.aliases ?? []).forEach((alias: string) => addMachineMemoryKey(machineByVmsId, alias, machine));
  });

  const mappingsByKey = new Map<string, any>();
  (mappings ?? []).forEach((mapping: any) => {
    const vmsProductId = String(mapping.vms_product_id ?? "");
    const vmsProductName = String(mapping.vms_product_name ?? "");
    addMappingKey(mappingsByKey, vmsProductId, vmsProductName, mapping);
    if (vmsProductId) addMappingKey(mappingsByKey, vmsProductId, "", mapping);
    if (vmsProductName) addMappingKey(mappingsByKey, "", vmsProductName, mapping);
  });
  const productRows = ((products ?? []) as any[]).map((product) => ({
    id: product.id,
    sku: product.sku ?? null,
    barcode: product.barcode ?? null,
    name: product.name ?? null,
  }));
  let productLookupMap = buildProductLookupMap(productRows);

  const stockSnapshots: any[] = [];
  const salesSnapshots: any[] = [];
  const planogramRows: any[] = [];
  const latestMappingRowsById = new Map<string, any>();
  const vmsSellingPriceByProductId = new Map<string, number>();
  const vmsCostPriceByProductId = new Map<string, number>();
  const finalRawRows: VmsRawRowPayload[] = [];
  const rememberedMachineKeys = new Set<string>();
  let fatalImportError = false;

  for (const [index, row] of rows.entries()) {
    const rowNumber = sourceRowNumbers?.[index] ?? index + firstDataRowNumber;
    const originalRow = originalRows?.[index] ?? row;
    const finishRow = (
      status: VmsRawRowStatus,
      reasons: string[] = [],
      matches: {
        machineMatchStatus?: string | null;
        productMatchStatus?: string | null;
        matchedMachineId?: string | null;
        matchedProductId?: string | null;
      } = {},
    ) => {
      finalRawRows.push(rawRowPayload({
        batchId: batch.id,
        rowNumber,
        originalRow,
        mappedRow: row,
        status,
        reasons,
        machineMatchStatus: matches.machineMatchStatus ?? (reportRequiresMachine(reportType) ? (identifier ? (machine ? "matched" : "unknown") : "missing") : null),
        productMatchStatus: matches.productMatchStatus ?? (reportRequiresProduct(reportType) ? (productNeedsMapping ? "needs_mapping" : productId ? "matched" : "missing") : null),
        matchedMachineId: matches.matchedMachineId ?? machine?.id ?? null,
        matchedProductId: matches.matchedProductId ?? productId,
      }));
    };
    const identifier = machineIdentifier(row);
    const machine = identifier ? machineByVmsId.get(vmsLookupKey(identifier)) : null;
    const rememberMachineOnce = async (status: "confirmed" | "needs_review") => {
      const key = vmsLookupKey(identifier);
      if (!identifier || !key || rememberedMachineKeys.has(key)) return;
      rememberedMachineKeys.add(key);
      await rememberMachineMapping({ supabase, profile, vmsMachineIdentifier: identifier, machine, status });
    };
    const { vmsProductId, vmsProductName } = productIdentifier(row);
    const productNameForMapping = vmsProductName || vmsProductId;
    const productLabel = vmsProductDisplay(vmsProductId, vmsProductName);
    const importedSellingPrice = explicitSellingPrice(row);
    const importedCostPrice = explicitCostPrice(row);
    const lastSeenAt = dateValue(value(row, ["updated_at", "last_online_at", "captured_at", "last_updated", "date", "sale_date", "period_end", "report_date", "sync_time"]))
      ?? (reportType === "sales" && salesReportPeriod ? new Date(startOfDateIso(salesReportPeriod.reportEndDate)) : new Date());

    let mapping: any = null;
    let productId: string | null = null;
    let productNeedsMapping = false;

    if (reportRequiresProduct(reportType)) {
      if (!productLabel) {
        const reason = "missing product identifier or name. Check the product code/name column mapping.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }

      const productResolution = resolveVmsProduct({
        mappingMap: mappingsByKey,
        productLookupMap,
        vmsProductId,
        vmsProductName,
      });
      mapping = productResolution.mapping;

      if (productResolution.status === "ignored") {
        const reason = `product mapping is ignored: ${productLabel}.`;
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }

      if (productResolution.status === "matched") {
        productId = productResolution.productId;
      } else if (productResolution.status === "needs_mapping" && reportType !== "product_list") {
        productNeedsMapping = true;
        markNeedsProductMapping(summary, productLabel);
        mapping = mapping ?? await ensureNeedsReviewMapping(supabase, mappingsByKey, profile, vmsProductId, productNameForMapping);
      }

      if (mapping?.id) {
        latestMappingRowsById.set(String(mapping.id), {
          id: mapping.id,
          vms_product_id: vmsProductId || null,
          vms_product_name: productNameForMapping,
          confidence_score: mapping.match_status === "confirmed" ? 1 : 0,
          vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : mapping.vms_selling_price_lyd ?? null,
          vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : mapping.vms_cost_price_lyd ?? null,
          latest_machine_id: machine?.id ?? null,
          latest_vms_machine_id: identifier || null,
          latest_machine_name: machine?.name ?? null,
          last_seen_at: lastSeenAt.toISOString(),
          last_import_batch_id: batch.id,
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (reportType === "custom") {
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (reportType === "product_list") {
      if (!autoCreateMissingProducts && !productId) {
        const existingReviewMapping = findMapping(mappingsByKey, vmsProductId, productNameForMapping);
        const reviewMapping = existingReviewMapping ?? await ensureNeedsReviewMapping(supabase, mappingsByKey, profile, vmsProductId, productNameForMapping);
        if (!existingReviewMapping && reviewMapping?.id) summary.mappingsCreated += 1;
        summary.mappingsNeedingReview += 1;
        markNeedsProductMapping(summary, productLabel);
        summary.skippedRows += 1;
        if (reviewMapping?.id) {
          latestMappingRowsById.set(String(reviewMapping.id), {
            id: reviewMapping.id,
            vms_product_id: vmsProductId || null,
            vms_product_name: productNameForMapping,
            confidence_score: reviewMapping.match_status === "confirmed" ? 1 : 0,
            vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : reviewMapping.vms_selling_price_lyd ?? null,
            vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : reviewMapping.vms_cost_price_lyd ?? null,
            latest_machine_id: machine?.id ?? null,
            latest_vms_machine_id: identifier || null,
            latest_machine_name: machine?.name ?? null,
            last_seen_at: lastSeenAt.toISOString(),
            last_import_batch_id: batch.id,
            updated_at: new Date().toISOString(),
          });
        }
        finishRow("needs_mapping", [`missing Snacky product: ${productLabel}`], {
          productMatchStatus: "needs_mapping",
          matchedProductId: null,
        });
        continue;
      }

      const catalogResult = await upsertVmsCatalogProduct({
        supabase,
        productRows,
        existingProductId: productId,
        row,
        vmsProductId,
        vmsProductName,
        updateCostFromVms,
        batchId: batch.id,
        lastSeenAt,
      });

      if (!catalogResult.product?.id) {
        const reason = catalogResult.error || "product catalog row could not be saved.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }

      productLookupMap = buildProductLookupMap(productRows);
      const catalogProductId = String(catalogResult.product.id);
      productId = catalogProductId;
      productNeedsMapping = false;
      if (catalogResult.action === "created") summary.productsCreated += 1;
      if (catalogResult.action === "updated") summary.productsUpdated += 1;

      const confirmedMapping = await ensureConfirmedMapping({
        supabase,
        mappingsByKey,
        profile,
        vmsProductId,
        vmsProductName: productNameForMapping,
        productId: catalogProductId,
        importedSellingPrice,
        importedCostPrice,
        machineId: machine?.id ?? null,
        vmsMachineIdentifier: identifier || null,
        machineName: machine?.name ?? null,
        lastSeenAt,
        batchId: batch.id,
      });

      if (!confirmedMapping?.mapping?.id) {
        const reason = "product was saved but VMS mapping could not be confirmed.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason], {
          productMatchStatus: "matched",
          matchedProductId: productId,
        });
        continue;
      }
      if (confirmedMapping.action === "created") summary.mappingsCreated += 1;
      if (confirmedMapping.action === "updated") summary.mappingsUpdated += 1;

      if (importedSellingPrice !== null && importedSellingPrice >= 0) vmsSellingPriceByProductId.set(catalogProductId, importedSellingPrice);
      if (updateCostFromVms && importedCostPrice !== null && importedCostPrice >= 0) vmsCostPriceByProductId.set(catalogProductId, importedCostPrice);

      summary.importedRows += 1;
      finishRow("imported", [], {
        productMatchStatus: "matched",
        matchedProductId: catalogProductId,
      });
      continue;
    }

    if (productId) {
      if (importedSellingPrice !== null && importedSellingPrice >= 0) vmsSellingPriceByProductId.set(productId, importedSellingPrice);
      if (updateCostFromVms && importedCostPrice !== null && importedCostPrice >= 0) vmsCostPriceByProductId.set(productId, importedCostPrice);
    }

    if (reportRequiresProduct(reportType) && !productNeedsMapping && !productId) {
      const reason = "product could not be matched to a Snacky product.";
      markInvalidRow(summary, rowNumber, reason);
      finishRow("invalid_row", [reason]);
      continue;
    }

    if (reportRequiresMachine(reportType)) {
      if (!identifier) {
        const reason = "missing machine id. Check the machine column mapping.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }
      if (!machine) {
        await rememberMachineOnce("needs_review");
        markUnknownMachine(summary, rowNumber, identifier);
        finishRow("unknown_machine", [`unknown machine: ${identifier}`]);
        continue;
      }
      await rememberMachineOnce("confirmed");
    }

    if (reportType === "machine_status") {
      await applyMachineStatus(supabase, machine.id, row, lastSeenAt);
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (productNeedsMapping) {
      summary.skippedRows += 1;
      finishRow("needs_mapping", [`unknown product: ${productLabel}`]);
      continue;
    }

    if (reportType === "planogram") {
      const slotCode = value(row, ["slot_code", "slot", "slot_no", "selection", "selection_code", "selection_no", "tray", "tray_code", "channel", "channel_no", "coil"]);
      if (!slotCode) {
        const reason = "missing slot/selection code.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }
      const capacity = Math.max(1, Math.floor(numberValue(value(row, ["capacity", "max_qty", "max_quantity", "slot_capacity", "par_qty", "current_qty"])) ?? 1));
      planogramRows.push({
        machine_id: machine.id,
        slot_code: slotCode,
        product_id: productId,
        capacity,
        min_qty: Math.max(0, Math.floor(numberValue(value(row, ["min_qty", "minimum", "min", "reorder_point", "warning_qty", "alert_qty"])) ?? 0)),
        par_qty: Math.max(1, Math.floor(numberValue(value(row, ["par_qty", "par", "target_qty", "target_stock", "target_quantity"])) ?? capacity)),
        active: true,
      });
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    if (reportType === "stock") {
      const currentQty = numberValue(value(row, ["current_qty", "stock_qty", "stock_quantity", "quantity", "qty", "remaining", "remaining_qty", "inventory", "inventory_qty", "on_hand", "balance", "available_qty", "qty_left"]));
      if (currentQty === null || currentQty < 0) {
        const reason = "invalid current quantity.";
        markInvalidRow(summary, rowNumber, reason);
        finishRow("invalid_row", [reason]);
        continue;
      }

      const capturedAt = dateValue(value(row, ["updated_at", "captured_at", "last_updated", "date", "report_date", "stock_date"])) ?? new Date();
      const temperature = numberValue(value(row, ["temperature", "temperature_c", "temp", "cabinet_temperature"]));
      const cashBalance = numberValue(value(row, ["cash_balance", "banknote_balance", "cash_amount", "cash_in_machine", "cash_box"]));
      await applyMachineStatus(supabase, machine.id, row, capturedAt);
      stockSnapshots.push({
        import_batch_id: batch.id,
        import_row_number: rowNumber,
        import_row_status: "imported",
        machine_id: machine.id,
        vms_machine_id: identifier,
        slot_code: value(row, ["slot_code", "slot", "slot_no", "selection", "selection_code", "selection_no", "tray", "tray_code", "channel", "channel_no", "coil"]),
        vms_product_id: vmsProductId || null,
        vms_product_name: productNameForMapping || null,
        product_id: productId,
        current_qty: Math.floor(currentQty),
        capacity: numberValue(value(row, ["capacity", "max_qty", "max_quantity", "slot_capacity"])) ?? null,
        captured_at: capturedAt.toISOString(),
        temperature_c: temperature,
        cash_balance_lyd: cashBalance,
        tray_status: value(row, ["empty_status", "out_of_stock", "sold_out", "tray_status", "status", "empty_trays"]) || null,
        metadata: { raw: row },
      });
      summary.importedRows += 1;
      finishRow("imported");
      continue;
    }

    const soldQty = numberValue(value(row, ["sold_qty", "transaction_count", "number_of_transaction", "number_of_transactions", "quantity_sold", "units_sold", "sales_units", "units", "qty", "quantity", "sales_qty", "sales_quantity", "volume", "sales_volume"]));
    const salesAmount = numberValue(value(row, ["total_sales_amount", "transaction_amount", "revenue_amount", "sales_amount", "total_sales", "total_sales_lyd", "sale_amount", "amount", "total_amount", "paid_amount", "revenue", "gross_sales", "turnover", "net_sales"]));
    if ((salesAmount === null || salesAmount < 0) && (soldQty === null || soldQty < 0)) {
      const reason = "invalid sales quantity or amount.";
      markInvalidRow(summary, rowNumber, reason);
      finishRow("invalid_row", [reason]);
      continue;
    }

    const rowPeriod = salesReportPeriod ?? salesPeriodFromRowDate(row);
    if (!rowPeriod) {
      markInvalidRow(summary, rowNumber, VMS_SALES_DATE_RANGE_ERROR);
      finishRow("invalid_row", [VMS_SALES_DATE_RANGE_ERROR]);
      continue;
    }

    const machineCode = value(row, ["machine_code", "machine_identifier", "vms_machine_id", "machine_id", "terminal_id", "device_id"]) || identifier;
    const machineName = value(row, ["machine_name", "machine", "device_name", "location"]) || machine?.name || "";
    const productNumber = value(row, ["product_number", "product_identifier", "vms_product_id", "product_code", "product_id", "goods_number", "goods_code", "commodity_number", "commodity_code"]);
    const commodityPrice = explicitSellingPrice(row);
    const refundCount = numberValue(value(row, ["refund_count", "refund_qty", "refund_quantity"]));
    const refundAmount = numberValue(value(row, ["refund_amount", "refund_total"]));
    const totalTransaction = numberValue(value(row, ["total_transaction", "total_transactions"]));
    const vmsTransactionId = value(row, ["vms_transaction_id", "transaction_id", "transaction_no", "txn_id", "order_id", "order_no", "receipt_id", "receipt_no"]);
    const grossSalesAmount = Math.max(0, salesAmount ?? 0);
    const netSalesAmount = Math.max(0, grossSalesAmount - Math.max(0, refundAmount ?? 0));
    const sourceRowKey = createVmsSalesSourceRowKey({
      vmsTransactionId,
      machineId: machine.id,
      machineCode,
      machineName,
      productId,
      productCode: productNumber || vmsProductId,
      productName: productNameForMapping,
      saleStartDate: rowPeriod.reportStartDate,
      saleEndDate: rowPeriod.reportEndDate,
      reportStartDate: salesReportPeriod?.reportStartDate ?? rowPeriod.reportStartDate,
      reportEndDate: salesReportPeriod?.reportEndDate ?? rowPeriod.reportEndDate,
      soldQty: Math.max(0, Math.floor(soldQty ?? 0)),
      grossSalesAmount,
      netSalesAmount,
    });
    salesSnapshots.push({
      import_batch_id: batch.id,
      import_row_number: rowNumber,
      import_row_status: "imported",
      source_row_key: sourceRowKey,
      vms_transaction_id: vmsTransactionId || null,
      machine_id: machine.id,
      product_id: productId,
      sold_qty: Math.max(0, Math.floor(soldQty ?? 0)),
      sales_amount: Math.max(0, salesAmount ?? 0),
      cash_sales_amount: numberValue(value(row, ["cash_sales_amount", "cash_sales", "cash_sales_lyd", "cash_amount", "cash_revenue", "cash_total"])) ?? 0,
      card_sales_amount: numberValue(value(row, ["card_sales_amount", "card_sales", "card_sales_lyd", "card_amount", "credit_card", "card_revenue", "online_sales"])) ?? 0,
      cost_amount: numberValue(value(row, ["cost_amount", "cost", "cogs", "total_cost", "product_cost"])),
      profit_amount: numberValue(value(row, ["profit_amount", "profit", "gross_profit", "margin_amount", "net_profit"])),
      period_start: startOfDateIso(rowPeriod.reportStartDate),
      period_end: endOfDateIso(rowPeriod.reportEndDate),
      machine_code: machineCode || null,
      machine_name: machineName || null,
      product_number: productNumber || vmsProductId || null,
      product_name: productNameForMapping || null,
      commodity_price: commodityPrice,
      transaction_count: Math.max(0, Math.floor(soldQty ?? 0)),
      transaction_amount: Math.max(0, salesAmount ?? 0),
      refund_count: refundCount === null ? null : Math.max(0, Math.floor(refundCount)),
      refund_amount: refundAmount === null ? null : Math.max(0, refundAmount),
      total_transaction: totalTransaction,
      sales_period_start: rowPeriod.reportStartDate,
      sales_period_end: rowPeriod.reportEndDate,
      sales_month: rowPeriod.salesMonth,
      gross_sales_amount: grossSalesAmount,
      net_sales_amount: netSalesAmount,
      gross_profit_amount: numberValue(value(row, ["profit_amount", "profit", "gross_profit", "margin_amount", "net_profit"])),
      metadata: { raw: row, sales_report_period: rowPeriod },
    });
    summary.importedRows += 1;
    finishRow("imported");
  }

  if (stockSnapshots.length) {
    const { error } = await supabase.from("vms_stock_snapshots").upsert(stockSnapshots, { onConflict: "import_batch_id,import_row_number" });
    if (error) {
      console.error("[vms-import] Stock snapshot upsert failed", error);
      summary.errors.push("Stock snapshot save failed.");
      summary.skippedRows += stockSnapshots.length;
      summary.importedRows -= stockSnapshots.length;
    } else if (existingBatchId) {
      try {
        await markStaleSnapshotRows(supabase, "vms_stock_snapshots", batch.id, stockSnapshots.map((row) => Number(row.import_row_number)).filter(Number.isFinite));
      } catch (staleError) {
        console.error("[vms-import] Stock stale marking failed", staleError);
        summary.errors.push("Old stock snapshot rows could not be marked stale.");
      }
    }
  } else if (existingBatchId && reportType === "stock") {
    try {
      await markStaleSnapshotRows(supabase, "vms_stock_snapshots", batch.id, []);
    } catch (staleError) {
      console.error("[vms-import] Stock stale marking failed", staleError);
      summary.errors.push("Old stock snapshot rows could not be marked stale.");
    }
  }

  if (salesSnapshots.length) {
    if (existingBatchId) {
      const { error } = await supabase.from("vms_sales_snapshots").upsert(salesSnapshots, { onConflict: "import_batch_id,import_row_number" });
      if (error) {
        console.error("[vms-import] Sales snapshot reprocess upsert failed", error);
        summary.errors.push("Sales snapshot save failed.");
        summary.skippedRows += salesSnapshots.length;
        summary.importedRows -= salesSnapshots.length;
        fatalImportError = true;
      }
      try {
        await markStaleSnapshotRows(supabase, "vms_sales_snapshots", batch.id, salesSnapshots.map((row) => Number(row.import_row_number)).filter(Number.isFinite));
      } catch (staleError) {
        console.error("[vms-import] Sales stale marking failed", staleError);
        summary.errors.push("Old sales snapshot rows could not be marked stale.");
      }
    } else {
      const { data: rpcResult, error } = await supabase.rpc("apply_vms_sales_snapshot_import", {
        p_batch_id: batch.id,
        p_import_mode: importMode,
        p_report_start_date: reportStartDate,
        p_report_end_date: reportEndDate,
        p_sales_rows: salesSnapshots,
      });
      if (error) {
        console.error("[vms-import] Sales snapshot transaction failed", {
          batchId: batch.id,
          importMode,
          reportStartDate,
          reportEndDate,
          errorCode: error.code,
          errorMessage: error.message,
          error,
        });
        summary.errors.push("Sales snapshot save failed.");
        summary.skippedRows += salesSnapshots.length;
        summary.importedRows -= salesSnapshots.length;
        fatalImportError = true;
      } else {
        const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
        const insertedRows = Number(result?.rows_inserted ?? salesSnapshots.length);
        const duplicateRows = Number(result?.rows_skipped_duplicate ?? Math.max(0, salesSnapshots.length - insertedRows));
        summary.importedRows -= Math.max(0, salesSnapshots.length - insertedRows);
        summary.skippedRows += duplicateRows;
        summary.rowsSkippedDuplicate += duplicateRows;
      }
    }
  } else if (existingBatchId && reportType === "sales") {
    try {
      await markStaleSnapshotRows(supabase, "vms_sales_snapshots", batch.id, []);
    } catch (staleError) {
      console.error("[vms-import] Sales stale marking failed", staleError);
      summary.errors.push("Old sales snapshot rows could not be marked stale.");
    }
  }

  if (planogramRows.length) {
    const { error } = await supabase.from("machine_slots").upsert(planogramRows, { onConflict: "machine_id,slot_code" });
    if (error) {
      console.error("[vms-import] Planogram upsert failed", error);
      summary.errors.push("Planogram upsert failed.");
      summary.skippedRows += planogramRows.length;
      summary.importedRows -= planogramRows.length;
    }
  }

  if (latestMappingRowsById.size) {
    const { error } = await supabase.from("vms_product_mappings").upsert([...latestMappingRowsById.values()], { onConflict: "id" });
    if (error) {
      console.error("[vms-import] VMS product mapping metadata update failed", error);
      summary.errors.push("VMS product mapping metadata update failed.");
    }
  }

  if (finalRawRows.length) {
    await upsertRawRows(supabase, finalRawRows);
  }

  if (!fatalImportError) {
    const productIds = new Set([...vmsSellingPriceByProductId.keys(), ...vmsCostPriceByProductId.keys()]);
    for (const productId of productIds) {
      const payload: Record<string, unknown> = { price_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const sellingPrice = vmsSellingPriceByProductId.get(productId);
      const costPrice = vmsCostPriceByProductId.get(productId);
      if (sellingPrice !== undefined) Object.assign(payload, { vms_selling_price_lyd: sellingPrice, current_selling_price_lyd: sellingPrice, selling_price: sellingPrice, selling_price_source: "vms" });
      if (costPrice !== undefined) Object.assign(payload, { current_cost_price_lyd: costPrice, cost_price: costPrice, cost_price_source: "vms" });
      const { error } = await supabase.from("products").update(payload).eq("id", productId);
      if (error) {
        console.error("[vms-import] Product price update failed", { productId, error });
        summary.errors.push("Product price update failed.");
      }
    }
  }

  summary.rowsNeedingReview = summary.needsProductMappingRows + summary.unknownMachineRows + summary.invalidRows;
  const status = fatalImportError
    ? "failed"
    : summary.errors.length || summary.skippedRows || summary.unknownMachines.length || summary.unmappedProducts.length
      ? "completed_with_warnings"
      : "imported";
  const batchUpdate: Record<string, unknown> = {
    status,
    row_count: summary.totalRows,
    rows_found: summary.rowsFound,
    rows_imported: summary.importedRows,
    rows_skipped: summary.skippedRows,
    rows_skipped_duplicate: summary.rowsSkippedDuplicate,
    rows_needing_review: summary.rowsNeedingReview,
    error_count: summary.errors.length,
    errors: summary.errors,
    unknown_machines: summary.unknownMachines,
    unmapped_products: summary.unmappedProducts,
    preview_summary: summary,
    review_summary: {
      unknown_machines: summary.unknownMachines,
      unmapped_products: summary.unmappedProducts,
      errors: summary.errors,
    },
    notes: JSON.stringify(summary),
  };
  if (fatalImportError) batchUpdate.failed_at = new Date().toISOString();
  if (existingBatchId) {
    batchUpdate.last_reprocessed_at = new Date().toISOString();
    batchUpdate.reprocess_count = Number(batch.reprocess_count ?? 0) + 1;
  }

  await supabase
    .from("vms_import_batches")
    .update(batchUpdate)
    .eq("id", batch.id);

  await saveHeaderMappingMemory({ supabase, profile, reportType, headerNames, mapping: columnMapping });

  await logActivity({
    profile,
    action: "import_vms",
    entityType: "vms_import",
    entityId: batch.id,
    entityLabel: `${reportType} ${fileType.toUpperCase()} ${fileName}`,
    afterData: summary,
    metadata: { report_type: reportType, file_name: fileName, file_type: fileType, sheet_name: sheetName },
    summary: `${existingBatchId ? "Reprocessed" : "Imported"} ${summary.importedRows} ${reportType} rows from VMS ${fileType.toUpperCase()}`,
  });

  revalidatePath("/vms-import");
  revalidatePath("/vms-mappings");
  revalidatePath("/products");
  revalidatePath("/machines");
  revalidatePath("/planograms");
  revalidatePath("/refills");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/sales");
  revalidatePath("/products-dashboard");
  revalidatePath("/machines-dashboard");
  revalidatePath("/inventory-dashboard");
  redirect(`/vms-import/${batch.id}`);
}

type VmsPreviewSheetPayload = { name: string; rows: string[][] };

function isMissingPreviewRowsSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const supabaseError = error as { code?: string; message?: string; details?: string; hint?: string };
  const text = `${supabaseError.message ?? ""} ${supabaseError.details ?? ""} ${supabaseError.hint ?? ""}`.toLowerCase();
  return supabaseError.code === "42P01"
    || supabaseError.code === "42703"
    || supabaseError.code === "PGRST204"
    || supabaseError.code === "PGRST205"
    || text.includes("does not exist")
    || text.includes("schema cache");
}

async function saveVmsPreviewRows({
  supabase,
  previewId,
  sheets,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  previewId: string;
  sheets: VmsPreviewSheetPayload[];
}) {
  const rows = sheets.flatMap((sheet) => sheet.rows.map((row, index) => ({
    preview_id: previewId,
    sheet_name: sheet.name,
    row_number: index + 1,
    raw_row: row,
  })));
  if (!rows.length) return;

  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    const { error } = await supabase.from("vms_import_preview_rows").insert(chunk);
    if (!error) continue;

    if (isMissingPreviewRowsSchemaError(error)) {
      console.warn("[vms-import] Preview row table is unavailable; using preview sheet JSON only", error);
      return;
    }

    console.error("[vms-import] Failed to save preview rows", error);
    redirect("/vms-import?error=Could%20not%20save%20VMS%20preview%20rows.%20Run%20the%20latest%20migration.");
  }
}

export async function prepareVmsImport(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canCreateVmsImports(profile)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const reportType = parseReportType(formData.get("report_type") || formData.get("import_type")) ?? "custom";
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/vms-import?error=Upload%20a%20VMS%20Excel%20or%20CSV%20file.");

  let parsed;
  try {
    parsed = await parseVmsUpload(file);
  } catch (error) {
    redirect(`/vms-import?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not parse VMS file.")}`);
  }
  if (!parsed.sheets.length) redirect("/vms-import?error=Could%20not%20read%20any%20sheets%20or%20rows%20from%20that%20file.");

  const { data: preview, error } = await supabase
    .from("vms_import_previews")
    .insert({
      file_name: file.name,
      file_type: parsed.fileType,
      file_size_bytes: file.size,
      report_type: reportType,
      sheets: parsed.sheets,
      uploaded_by: profile.team_member_id,
    })
    .select("id")
    .single();

  if (error || !preview?.id) {
    console.error("[vms-import] Failed to create preview", error);
    redirect("/vms-import?error=Could%20not%20prepare%20VMS%20import%20preview.");
  }

  await saveVmsPreviewRows({
    supabase,
    previewId: preview.id,
    sheets: parsed.sheets,
  });

  redirect(`/vms-import?previewId=${preview.id}&sheet=${encodeURIComponent(parsed.sheets[0].name)}&reportType=${reportType}&step=2`);
}

export async function importVmsCsv(formData: FormData) {
  return prepareVmsImport(formData);
}

export async function completeVmsImport(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const previewId = String(formData.get("preview_id") || "");
  const sheetName = String(formData.get("sheet_name") || "");
  const reportType = parseReportType(formData.get("report_type"));
  const headerRowRaw = Number(formData.get("header_row") ?? 0);
  const headerRowIndex = Number.isFinite(headerRowRaw) ? Math.max(0, Math.floor(headerRowRaw)) : 0;
  const autoCreateMissingProducts = booleanOption(formData.get("auto_create_products"), true);
  const updateCostFromVms = booleanOption(formData.get("update_cost_from_vms"), false);
  const importMode = parseVmsImportMode(formData.get("import_mode"));
  const submittedReportStartDate = String(formData.get("report_start_date") || "").trim() || null;
  const submittedReportEndDate = String(formData.get("report_end_date") || "").trim() || null;
  if (!previewId || !sheetName || !reportType) redirect("/vms-import?error=Missing%20VMS%20import%20preview%20details.");

  const { data: preview } = await supabase.from("vms_import_previews").select("*").eq("id", previewId).maybeSingle();
  if (!preview) redirect("/vms-import?error=VMS%20import%20preview%20not%20found.");

  const sheets = (preview.sheets ?? []) as { name: string; rows: string[][] }[];
  const sheet = sheets.find((candidate) => candidate.name === sheetName) ?? sheets[0];
  if (!sheet) redirect("/vms-import?error=Selected%20sheet%20was%20not%20found.");

  const mapping = readMapping(formData, reportType);
  const missing = requiredMissing(mapping, reportType);
  if (missing.length) previewRedirect(previewId, sheet.name, reportType, `Map required fields: ${missing.join(", ")}`, headerRowIndex);

  const { headers, records } = sheetRowsToRecords(sheet.rows, { reportType, headerRowIndex });
  const rows = applyColumnMapping(records, mapping);
  if (!rows.length) previewRedirect(previewId, sheet.name, reportType, "Selected sheet has no data rows.", headerRowIndex);
  const salesReportPeriod = reportType === "sales" ? findSalesReportPeriod(sheet.rows, headerRowIndex) : null;
  if (reportType === "sales" && !salesReportPeriod && !hasSalesRowDate(rows)) {
    previewRedirect(previewId, sheet.name, reportType, VMS_SALES_DATE_RANGE_ERROR, headerRowIndex);
  }

  await runVmsImport({
    supabase,
    profile,
    reportType,
    importMode,
    fileName: preview.file_name,
    fileType: preview.file_type,
    sheetName: sheet.name,
    headerNames: headers,
    rows,
    originalRows: records,
    columnMapping: mapping,
    firstDataRowNumber: headerRowIndex + 2,
    salesReportPeriod,
    reportStartDate: submittedReportStartDate ?? salesReportPeriod?.reportStartDate ?? null,
    reportEndDate: submittedReportEndDate ?? salesReportPeriod?.reportEndDate ?? null,
    autoCreateMissingProducts,
    updateCostFromVms,
  });
}

function jsonRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? "")]),
  );
}

export async function reprocessVmsImportBatch(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !canConfirmVmsImports(profile)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const batchId = String(formData.get("batch_id") || "");
  if (!batchId) redirect("/vms-import?error=Missing%20VMS%20import%20batch.");

  const { data: batch, error: batchError } = await supabase
    .from("vms_import_batches")
    .select("id, file_name, file_type, sheet_name, report_type, column_mapping, notes")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError || !batch?.id) {
    console.error("[vms-import:reprocess] Batch lookup failed", batchError);
    redirect("/vms-import?error=Could%20not%20find%20that%20VMS%20import%20batch.");
  }

  const reportType = parseReportType(batch.report_type);
  if (!reportType) redirect(`/vms-import/${batchId}?error=That%20batch%20does%20not%20have%20a%20valid%20report%20type.`);

  const { data: rawRows, error: rawRowsError } = await supabase
    .from("vms_import_rows")
    .select("row_number, raw_data, normalized_data")
    .eq("import_batch_id", batchId)
    .order("row_number", { ascending: true });

  if (rawRowsError) {
    console.error("[vms-import:reprocess] Raw row lookup failed", rawRowsError);
    redirect(`/vms-import/${batchId}?error=Could%20not%20load%20raw%20rows%20for%20that%20batch.`);
  }

  if (!rawRows?.length) {
    redirect(`/vms-import/${batchId}?error=This%20batch%20does%20not%20have%20saved%20raw%20rows.%20Upload%20the%20file%20again%20once%20to%20enable%20reprocessing.`);
  }
  let previousSummary: Partial<ImportSummary> = {};
  try {
    previousSummary = batch.notes ? JSON.parse(String(batch.notes)) as Partial<ImportSummary> : {};
  } catch {
    previousSummary = {};
  }

  await runVmsImport({
    supabase,
    profile,
    existingBatchId: batchId,
    reportType,
    fileName: batch.file_name ?? "VMS import",
    fileType: batch.file_type ?? "csv",
    sheetName: batch.sheet_name ?? "Sheet",
    rows: rawRows.map((row: any) => jsonRecord(row.normalized_data)),
    originalRows: rawRows.map((row: any) => jsonRecord(row.raw_data)),
    columnMapping: jsonRecord(batch.column_mapping),
    sourceRowNumbers: rawRows.map((row: any) => Number(row.row_number)),
    salesReportPeriod: previousSummary.salesReportPeriod ?? null,
    autoCreateMissingProducts: previousSummary.autoCreateMissingProducts ?? true,
    updateCostFromVms: previousSummary.updateCostFromVms ?? false,
  });
}
