import "server-only";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import type { UserProfile } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { XyApiError, assertXyVmsReady, buildXyRequestDebug, callXyApi, callXyApiRaw, getXyVmsConfig, type XyApiRawResult, type XyRequestDebug, type XyVmsConfig, type XyVmsEndpoint, type XyVmsParams } from "@/lib/xy-vms-api";

type SupabaseServer = NonNullable<ReturnType<typeof getSupabaseServerClient>>;
type SyncRunStatus = "running" | "completed" | "completed_with_warnings" | "failed";
type SyncType = "machines" | "products" | "machine_goods" | "machine_status" | "test_official" | "test_unsigned" | "all";
type JsonRecord = Record<string, unknown>;

type SyncOptions = {
  profile?: UserProfile | null;
};

type SyncContext = {
  supabase: SupabaseServer;
  profile?: UserProfile | null;
  config: XyVmsConfig;
  syncRunId: string;
  capturedAt: string;
};

type SyncStats = {
  rowCount: number;
  rowsImported: number;
  rowsUpdated: number;
  rowsSkipped: number;
  errors: string[];
  responseSummary: JsonRecord;
};

type ProductReference = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  name?: string | null;
};

type MappingReference = {
  id: string;
  vms_product_id?: string | null;
  vms_product_name?: string | null;
  product_id?: string | null;
  match_status?: string | null;
  vms_third_party_product_id?: string | null;
  vms_barcode?: string | null;
};

type LocationReference = {
  id: string;
  name: string;
};

type MachineReference = {
  id: string;
  machine_code: string;
  vms_machine_id: string | null;
};

type XyMachineReference = {
  id: string;
  name: string;
  machine_code: string;
  vms_machine_id: string;
};

type ProductResolver = {
  productsById: Map<string, ProductReference>;
  productsBySku: Map<string, ProductReference>;
  productsByBarcode: Map<string, ProductReference>;
  productsByName: Map<string, ProductReference>;
  mappingsByKey: Map<string, MappingReference>;
};

function emptyStats(): SyncStats {
  return {
    rowCount: 0,
    rowsImported: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    errors: [],
    responseSummary: {},
  };
}

function mergeStats(target: SyncStats, source: SyncStats) {
  target.rowCount += source.rowCount;
  target.rowsImported += source.rowsImported;
  target.rowsUpdated += source.rowsUpdated;
  target.rowsSkipped += source.rowsSkipped;
  target.errors.push(...source.errors);
  target.responseSummary = { ...target.responseSummary, ...source.responseSummary };
}

function normalizeKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function text(row: JsonRecord, key: string) {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function firstText(row: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = text(row, key);
    if (value) return value;
  }
  return "";
}

function numberValue(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value: unknown) {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, Math.floor(parsed));
}

function parseDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function singleNumericText(value: string) {
  return /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function redactXyString(value: string, config: XyVmsConfig) {
  let redacted = value;
  [
    [config.secret, config.maskedSecret],
    [config.key, config.maskedKey],
  ].forEach(([raw, masked]) => {
    if (raw) redacted = redacted.split(raw).join(masked);
  });
  return redacted;
}

function sanitizeForLog<T>(value: T, config: XyVmsConfig): T {
  if (typeof value === "string") return redactXyString(value, config) as T;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? (JSON.parse(redactXyString(serialized, config)) as T) : value;
  } catch {
    return value;
  }
}

function sanitizeStatsForLog(stats: SyncStats, config: XyVmsConfig): SyncStats {
  return {
    ...stats,
    errors: stats.errors.map((error) => redactXyString(error, config)),
    responseSummary: sanitizeForLog(stats.responseSummary, config),
  };
}

function arrayify(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as JsonRecord[];
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    for (const key of ["list", "rows", "items", "records", "data"]) {
      if (Array.isArray(record[key])) return arrayify(record[key]);
    }
    return [record];
  }
  return [];
}

function summarizeRawResponse(endpoint: XyVmsEndpoint, result: XyApiRawResult): JsonRecord {
  const rows = arrayify(result.response.data);
  return {
    endpoint,
    requestDebug: result.requestDebug,
    httpStatus: result.httpStatus,
    xyCode: result.response.code ?? null,
    message: result.response.message ?? null,
    dataRowCount: rows.length,
    sampleRows: rows.slice(0, 3),
    requestSigned: result.requestSigned,
  };
}

function failedEndpointSummary(endpoint: XyVmsEndpoint, error: unknown, requestDebug?: XyRequestDebug): JsonRecord {
  return {
    endpoint,
    requestDebug: error instanceof XyApiError ? error.requestDebug ?? requestDebug ?? null : requestDebug ?? null,
    httpStatus: error instanceof XyApiError ? error.status ?? null : null,
    xyCode: error instanceof XyApiError ? error.code ?? error.response?.code ?? null : null,
    message: error instanceof XyApiError ? error.response?.message ?? error.message : safeErrorMessage(error),
    dataRowCount: 0,
    sampleRows: [],
  };
}

function summaryRowCount(summary: JsonRecord) {
  const value = Number(summary.dataRowCount ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function summaryCode(summary: JsonRecord) {
  return String(summary.xyCode ?? "");
}

function summaryMessage(summary: JsonRecord) {
  return String(summary.message ?? "");
}

function summaryHttpOk(summary: JsonRecord) {
  const status = Number(summary.httpStatus ?? 0);
  return status >= 200 && status < 300;
}

function looksLikeAuthSignFailure(summary: JsonRecord) {
  const value = `${summaryCode(summary)} ${summaryMessage(summary)}`.toLowerCase();
  return ["auth", "author", "key", "secret", "sign", "signature", "timestamp", "encrypt", "token", "permission"].some((word) => value.includes(word));
}

function officialAuthFailureMessage(summary: JsonRecord) {
  return looksLikeAuthSignFailure(summary) ? "XY signature/key authentication failed. Check key, secret, timestamp, and reqData." : null;
}

function assertUnsignedTestReady(config: XyVmsConfig) {
  const missing = [
    config.enabled ? "" : "XY_VMS_ENABLED=true",
    config.baseUrl ? "" : "XY_VMS_BASE_URL",
    config.merchantId ? "" : "XY_VMS_MERCHANT_ID",
  ].filter(Boolean);
  if (missing.length) throw new Error(`XY VMS API is not ready: ${missing.join(", ")}.`);
}

function detailImages(row: JsonRecord) {
  const raw = row.fjgg ?? row.detail_images ?? row.images;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return trimmed.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function productKey(vmsProductId: string, vmsProductName: string) {
  return `${normalizeKey(vmsProductId)}::${normalizeKey(vmsProductName)}`;
}

function addMappingReference(resolver: ProductResolver, mapping: MappingReference) {
  const vmsProductId = String(mapping.vms_product_id ?? "");
  const vmsProductName = String(mapping.vms_product_name ?? "");
  if (vmsProductId || vmsProductName) resolver.mappingsByKey.set(productKey(vmsProductId, vmsProductName), mapping);
  if (vmsProductId) resolver.mappingsByKey.set(productKey(vmsProductId, ""), mapping);
  if (vmsProductName) resolver.mappingsByKey.set(productKey("", vmsProductName), mapping);
}

function findMapping(resolver: ProductResolver, vmsProductId: string, vmsProductName: string) {
  return (
    resolver.mappingsByKey.get(productKey(vmsProductId, vmsProductName)) ??
    resolver.mappingsByKey.get(productKey(vmsProductId, "")) ??
    resolver.mappingsByKey.get(productKey("", vmsProductName)) ??
    null
  );
}

function xyProductIdentity(row: JsonRecord) {
  return {
    vmsProductId: firstText(row, ["spbh", "vms_product_id", "product_id"]),
    thirdPartyProductId: firstText(row, ["dsfspbh", "third_party_product_id", "sku"]),
    productName: firstText(row, ["spmc", "product_name", "name"]),
    barcode: firstText(row, ["sptxm", "barcode", "bar_code"]),
    imageUrl: firstText(row, ["fjlj", "sptp", "image_url", "image"]),
    sellingPrice: numberValue(row.spjg ?? row.spsj ?? row.selling_price),
  };
}

function cleanProductText(input: unknown) {
  return String(input ?? "").trim();
}

function stableProductHash(input: string) {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

function generatedXyProductSku(identity: ReturnType<typeof xyProductIdentity>) {
  const directSource = cleanProductText(identity.thirdPartyProductId) || cleanProductText(identity.vmsProductId) || cleanProductText(identity.barcode);
  if (directSource) return directSource.slice(0, 96);

  const productName = cleanProductText(identity.productName);
  const asciiName = productName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const hash = stableProductHash(productName || "xy-product");
  return asciiName ? `XY-${asciiName}-${hash}` : `XY-${hash}`;
}

function addProductReference(resolver: ProductResolver, product: ProductReference) {
  resolver.productsById.set(product.id, product);
  const skuKey = normalizeKey(product.sku);
  const barcodeKey = normalizeKey(product.barcode);
  const nameKey = normalizeKey(product.name);
  if (skuKey) resolver.productsBySku.set(skuKey, product);
  if (barcodeKey) resolver.productsByBarcode.set(barcodeKey, product);
  if (nameKey) resolver.productsByName.set(nameKey, product);
}

function xyProductCategory(row: JsonRecord) {
  return firstText(row, ["spfl", "splb", "lbmc", "category", "product_category", "type"]) || "snack";
}

function xyProductBrand(row: JsonRecord) {
  return firstText(row, ["pp", "ppmc", "brand", "manufacturer"]);
}

function findProduct(resolver: ProductResolver, row: JsonRecord) {
  const identity = xyProductIdentity(row);
  const mapping = findMapping(resolver, identity.vmsProductId, identity.productName);
  if (mapping?.product_id && mapping.match_status === "confirmed") {
    return resolver.productsById.get(mapping.product_id) ?? { id: mapping.product_id };
  }

  const skuKeys = [identity.thirdPartyProductId, identity.vmsProductId].map(normalizeKey).filter(Boolean);
  for (const key of skuKeys) {
    const product = resolver.productsBySku.get(key);
    if (product) return product;
  }

  const barcodeKey = normalizeKey(identity.barcode);
  if (barcodeKey) {
    const product = resolver.productsByBarcode.get(barcodeKey);
    if (product) return product;
  }

  const nameKey = normalizeKey(identity.productName);
  if (nameKey) {
    const product = resolver.productsByName.get(nameKey);
    if (product) return product;
  }

  return null;
}

async function loadProductResolver(supabase: SupabaseServer): Promise<ProductResolver> {
  const resolver: ProductResolver = {
    productsById: new Map(),
    productsBySku: new Map(),
    productsByBarcode: new Map(),
    productsByName: new Map(),
    mappingsByKey: new Map(),
  };

  const [{ data: products, error: productsError }, { data: mappings, error: mappingsError }] = await Promise.all([
    supabase.from("products").select("id, sku, barcode, name"),
    supabase.from("vms_product_mappings").select("id, vms_product_id, vms_product_name, product_id, match_status, vms_third_party_product_id, vms_barcode"),
  ]);

  if (productsError) throw new Error(`Could not load Snacky products: ${productsError.message}`);
  if (mappingsError) throw new Error(`Could not load VMS product mappings: ${mappingsError.message}`);

  const productRows = (products ?? []) as ProductReference[];
  const mappingRows = (mappings ?? []) as MappingReference[];

  productRows.forEach((product) => addProductReference(resolver, product));

  mappingRows.forEach((mapping) => addMappingReference(resolver, mapping));
  return resolver;
}

async function createMissingXyProductFromRow(supabase: SupabaseServer, resolver: ProductResolver, row: JsonRecord, capturedAt: string) {
  const identity = xyProductIdentity(row);
  const productName = identity.productName || identity.thirdPartyProductId || identity.vmsProductId || identity.barcode;
  if (!productName) return { product: null, action: "skipped" as const, error: "XY product row is missing a product name and identifier." };

  const sku = generatedXyProductSku(identity);
  const now = new Date().toISOString();
  const sellingPrice = identity.sellingPrice !== null && identity.sellingPrice >= 0 ? identity.sellingPrice : 0;
  const payload = {
    sku,
    barcode: identity.barcode || null,
    name: productName,
    category: xyProductCategory(row),
    brand: xyProductBrand(row) || null,
    cost_price: 0,
    selling_price: sellingPrice,
    current_cost_price_lyd: 0,
    current_selling_price_lyd: sellingPrice,
    cost_price_source: "initial_import",
    selling_price_source: identity.sellingPrice !== null && identity.sellingPrice >= 0 ? "vms" : "initial_import",
    price_updated_at: identity.sellingPrice !== null && identity.sellingPrice >= 0 ? now : null,
    vms_selling_price_lyd: identity.sellingPrice !== null && identity.sellingPrice >= 0 ? identity.sellingPrice : null,
    image_url: identity.imageUrl || null,
    import_source: "vms_import",
    last_vms_seen_at: capturedAt,
    active: true,
  };

  const { data, error } = await supabase
    .from("products")
    .insert(payload)
    .select("id, sku, barcode, name")
    .maybeSingle();

  if (error) {
    const { data: duplicate, error: duplicateError } = await supabase
      .from("products")
      .select("id, sku, barcode, name")
      .eq("sku", sku)
      .maybeSingle();
    if (duplicateError) return { product: null, action: "invalid" as const, error: duplicateError.message };
    if (duplicate?.id) {
      addProductReference(resolver, duplicate);
      return { product: duplicate as ProductReference, action: "updated" as const, error: null };
    }
    return { product: null, action: "invalid" as const, error: error.message };
  }

  if (data) addProductReference(resolver, data);
  return { product: data as ProductReference | null, action: "created" as const, error: null };
}

async function upsertXyProductMapping({
  supabase,
  resolver,
  row,
  productId,
  machine,
  capturedAt,
  syncRunId,
}: {
  supabase: SupabaseServer;
  resolver: ProductResolver;
  row: JsonRecord;
  productId: string | null;
  machine?: { id: string; vms_machine_id: string; name: string } | null;
  capturedAt: string;
  syncRunId: string;
}) {
  const identity = xyProductIdentity(row);
  const vmsProductName = identity.productName || identity.vmsProductId || identity.thirdPartyProductId || identity.barcode || "Unknown XY product";
  const existing = findMapping(resolver, identity.vmsProductId, vmsProductName);
  const matchStatus = productId ? "confirmed" : existing?.match_status === "ignored" ? "ignored" : "needs_review";
  const payload = {
    vms_product_id: identity.vmsProductId || null,
    vms_product_name: vmsProductName,
    vms_third_party_product_id: identity.thirdPartyProductId || null,
    vms_barcode: identity.barcode || null,
    vms_image_url: identity.imageUrl || null,
    product_id: productId,
    match_status: matchStatus,
    vms_selling_price_lyd: identity.sellingPrice !== null && identity.sellingPrice >= 0 ? identity.sellingPrice : null,
    latest_machine_id: machine?.id ?? null,
    latest_vms_machine_id: machine?.vms_machine_id ?? null,
    latest_machine_name: machine?.name ?? null,
    last_seen_at: capturedAt,
    vms_raw_metadata: { provider: "xy", sync_run_id: syncRunId, raw: row },
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from("vms_product_mappings")
      .update(payload)
      .eq("id", existing.id)
      .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_third_party_product_id, vms_barcode")
      .maybeSingle();
    if (error) throw new Error(`Could not update VMS product mapping ${vmsProductName}: ${error.message}`);
    const mapping = data ?? { ...existing, ...payload };
    addMappingReference(resolver, mapping);
    return { action: "updated" as const, mapping };
  }

  const { data, error } = await supabase
    .from("vms_product_mappings")
    .insert({ ...payload, created_at: capturedAt })
    .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_third_party_product_id, vms_barcode")
    .maybeSingle();

  if (error) throw new Error(`Could not create VMS product mapping ${vmsProductName}: ${error.message}`);
  if (data) addMappingReference(resolver, data);
  return { action: "created" as const, mapping: data };
}

async function updateMatchedProductFromXy(supabase: SupabaseServer, productId: string, row: JsonRecord, capturedAt: string) {
  const identity = xyProductIdentity(row);
  const payload: Record<string, unknown> = {
    last_vms_seen_at: capturedAt,
    updated_at: new Date().toISOString(),
  };
  if (identity.barcode) payload.barcode = identity.barcode;
  if (identity.imageUrl) payload.image_url = identity.imageUrl;
  if (identity.productName) payload.name = identity.productName;
  if (identity.sellingPrice !== null && identity.sellingPrice >= 0) {
    Object.assign(payload, {
      selling_price: identity.sellingPrice,
      current_selling_price_lyd: identity.sellingPrice,
      vms_selling_price_lyd: identity.sellingPrice,
      selling_price_source: "vms",
      price_updated_at: new Date().toISOString(),
    });
  }

  const { error } = await supabase.from("products").update(payload).eq("id", productId);
  if (error) throw new Error(`Could not update matched product ${identity.productName || productId}: ${error.message}`);
}

async function insertChunks(supabase: SupabaseServer, table: string, rows: JsonRecord[], chunkSize = 200) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`Could not insert ${table} rows: ${error.message}`);
  }
}

function syncRunStatus(stats: SyncStats): SyncRunStatus {
  if (!stats.errors.length) return "completed";
  if (stats.rowCount === 0 && stats.rowsImported === 0 && stats.rowsUpdated === 0) return "failed";
  return "completed_with_warnings";
}

async function createSyncRun(supabase: SupabaseServer, syncType: SyncType, profile: UserProfile | null | undefined, config: XyVmsConfig) {
  const { data, error } = await supabase
    .from("vms_sync_runs")
    .insert({
      provider: "xy",
      sync_type: syncType,
      status: "running",
      endpoint: syncType === "all" ? "sync_all" : null,
      merchant_id_masked: config.maskedMerchantId,
      requested_by: profile?.team_member_id ?? null,
      request_summary: {
        provider: "xy",
        sync_type: syncType,
        base_url: config.baseUrl,
        merchant_id: config.maskedMerchantId,
        key: config.maskedKey,
        secret: config.maskedSecret,
        signing_mode: config.signingMode,
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) throw new Error(`Could not create XY sync run: ${error?.message ?? "missing id"}`);

  await logActivity({
    profile,
    action: "xy_vms_sync_started",
    entityType: "vms_sync",
    entityId: data.id,
    entityLabel: `XY ${syncType}`,
    metadata: { sync_type: syncType, provider: "xy", merchant_id: config.maskedMerchantId },
    summary: `Started XY VMS ${syncType.replaceAll("_", " ")} sync`,
  });

  return data.id as string;
}

async function finishSyncRun({
  supabase,
  profile,
  syncRunId,
  syncType,
  status,
  stats,
  message,
}: {
  supabase: SupabaseServer;
  profile?: UserProfile | null;
  syncRunId: string;
  syncType: SyncType;
  status: SyncRunStatus;
  stats: SyncStats;
  message: string;
}) {
  const { error } = await supabase
    .from("vms_sync_runs")
    .update({
      status,
      row_count: stats.rowCount,
      rows_imported: stats.rowsImported,
      rows_updated: stats.rowsUpdated,
      rows_skipped: stats.rowsSkipped,
      error_count: stats.errors.length,
      message,
      response_summary: stats.responseSummary,
      errors: stats.errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", syncRunId);

  if (error) console.error("[xy-vms] Failed to update sync run", error);

  await logActivity({
    profile,
    action: status === "failed" ? "xy_vms_sync_failed" : "xy_vms_sync_completed",
    entityType: "vms_sync",
    entityId: syncRunId,
    entityLabel: `XY ${syncType}`,
    afterData: { status, ...stats, errors: stats.errors.slice(0, 25) },
    metadata: { sync_type: syncType, provider: "xy" },
    summary: message,
  });
}

function revalidateXyPages() {
  [
    "/admin/vms-api",
    "/dashboard",
    "/machines",
    "/machines-dashboard",
    "/products",
    "/vms-mappings",
    "/refills",
    "/routes/new",
    "/inventory-dashboard",
  ].forEach((path) => revalidatePath(path));
}

async function runXySync(syncType: SyncType, options: SyncOptions, work: (context: SyncContext) => Promise<SyncStats>) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const profile = options.profile ?? null;
  const config = getXyVmsConfig();
  const syncRunId = await createSyncRun(supabase, syncType, profile, config);

  try {
    if (syncType === "test_unsigned") assertUnsignedTestReady(config);
    else assertXyVmsReady(config);
    const stats = await work({
      supabase,
      profile,
      config,
      syncRunId,
      capturedAt: new Date().toISOString(),
    });
    const safeStats = sanitizeStatsForLog(stats, config);
    const status = syncRunStatus(safeStats);
    const message =
      status === "completed"
        ? `Completed XY VMS ${syncType.replaceAll("_", " ")} sync`
        : status === "failed"
          ? `XY VMS ${syncType.replaceAll("_", " ")} sync failed`
          : `Completed XY VMS ${syncType.replaceAll("_", " ")} sync with warnings`;
    await finishSyncRun({ supabase, profile, syncRunId, syncType, status, stats: safeStats, message });
    revalidateXyPages();
    return { syncRunId, status, ...safeStats };
  } catch (error) {
    const stats = emptyStats();
    stats.errors.push(safeErrorMessage(error));
    const safeStats = sanitizeStatsForLog(stats, config);
    await finishSyncRun({
      supabase,
      profile,
      syncRunId,
      syncType,
      status: "failed",
      stats: safeStats,
      message: `XY VMS ${syncType.replaceAll("_", " ")} sync failed`,
    });
    revalidateXyPages();
    return { syncRunId, status: "failed" as const, ...safeStats };
  }
}

async function ensureLocations(supabase: SupabaseServer, rows: JsonRecord[]) {
  const names = Array.from(new Set(rows.map((row) => text(row, "dwmc")).filter(Boolean)));
  const locations = new Map<string, LocationReference>();
  if (!names.length) return locations;

  const { data: existing, error } = await supabase
    .from("locations")
    .select("id, name")
    .in("name", names);
  if (error) throw new Error(`Could not load locations for XY machines: ${error.message}`);
  ((existing ?? []) as LocationReference[]).forEach((location) => locations.set(location.name, location));

  const missing = names.filter((name) => !locations.has(name));
  if (missing.length) {
    const rowsByLocation = new Map(rows.map((row) => [text(row, "dwmc"), row]));
    const { data: inserted, error: insertError } = await supabase
      .from("locations")
      .insert(
        missing.map((name) => {
          const source = rowsByLocation.get(name) ?? {};
          return {
            name,
            location_type: "other",
            latitude: numberValue(source.dwwd),
            longitude: numberValue(source.dwjd),
            metadata: { source: "xy_vms", raw: source },
          };
        }),
      )
      .select("id, name");
    if (insertError) throw new Error(`Could not create locations from XY machines: ${insertError.message}`);
    ((inserted ?? []) as LocationReference[]).forEach((location) => locations.set(location.name, location));
  }

  return locations;
}

async function syncMachinesWork(context: SyncContext) {
  const stats = emptyStats();
  const response = await callXyApi("queryMachine", { shbh: context.config.merchantId });
  const rows = arrayify(response.data);
  stats.rowCount = rows.length;
  stats.responseSummary = { queryMachine: { code: response.code, message: response.message, rows: rows.length } };

  const locations = await ensureLocations(context.supabase, rows);
  const vmsIds = rows.map((row) => text(row, "jqbh")).filter(Boolean);
  const [{ data: byVms, error: byVmsError }, { data: byCode, error: byCodeError }] = await Promise.all([
    vmsIds.length
      ? context.supabase.from("machines").select("id, machine_code, vms_machine_id").in("vms_machine_id", vmsIds)
      : Promise.resolve({ data: [], error: null }),
    vmsIds.length
      ? context.supabase.from("machines").select("id, machine_code, vms_machine_id").in("machine_code", vmsIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (byVmsError) throw new Error(`Could not load machines by VMS ID: ${byVmsError.message}`);
  if (byCodeError) throw new Error(`Could not load machines by code: ${byCodeError.message}`);

  const existingByVms = new Map(((byVms ?? []) as MachineReference[]).map((machine) => [machine.vms_machine_id, machine]));
  const existingByCode = new Map(((byCode ?? []) as MachineReference[]).map((machine) => [machine.machine_code, machine]));

  for (const row of rows) {
    const vmsMachineId = text(row, "jqbh");
    if (!vmsMachineId) {
      stats.rowsSkipped += 1;
      stats.errors.push("XY machine row was missing jqbh.");
      continue;
    }

    const locationName = text(row, "dwmc");
    const location = locationName ? locations.get(locationName) : null;
    const machineName = text(row, "jqmc") || locationName || `XY Machine ${vmsMachineId}`;
    const machineType = firstText(row, ["jqlx", "jqlb"]) ? `Xingyuan ${firstText(row, ["jqlx", "jqlb"])}` : "Xingyuan vending";
    const payload = {
      vms_machine_id: vmsMachineId,
      name: machineName,
      machine_type: machineType,
      location_id: location?.id ?? null,
      vms_provider: "xy",
      vms_category: text(row, "jqlb") || null,
      vms_type: text(row, "jqlx") || null,
      vms_location_name: locationName || null,
      vms_longitude: numberValue(row.dwjd),
      vms_latitude: numberValue(row.dwwd),
      vms_raw_metadata: { provider: "xy", sync_run_id: context.syncRunId, raw: row },
      vms_last_synced_at: context.capturedAt,
      updated_at: new Date().toISOString(),
    };
    const existing = existingByVms.get(vmsMachineId) ?? existingByCode.get(vmsMachineId);

    if (existing?.id) {
      const { error } = await context.supabase.from("machines").update(payload).eq("id", existing.id);
      if (error) {
        stats.rowsSkipped += 1;
        stats.errors.push(`Machine ${vmsMachineId} update failed: ${error.message}`);
      } else {
        stats.rowsUpdated += 1;
      }
      continue;
    }

    const { data, error } = await context.supabase
      .from("machines")
      .insert({
        ...payload,
        machine_code: vmsMachineId,
        status: "active",
      })
      .select("id, machine_code, vms_machine_id")
      .maybeSingle();
    if (error || !data?.id) {
      stats.rowsSkipped += 1;
      stats.errors.push(`Machine ${vmsMachineId} create failed: ${error?.message ?? "missing id"}`);
    } else {
      existingByVms.set(vmsMachineId, data);
      existingByCode.set(vmsMachineId, data);
      stats.rowsImported += 1;
    }
  }

  return stats;
}

async function syncProductsWork(context: SyncContext) {
  const stats = emptyStats();
  const response = await callXyApi("queryGoodDetails", { shbh: context.config.merchantId });
  const rows = arrayify(response.data);
  const resolver = await loadProductResolver(context.supabase);
  const snapshots: JsonRecord[] = [];

  stats.rowCount = rows.length;
  stats.responseSummary = { queryGoodDetails: { code: response.code, message: response.message, rows: rows.length } };

  for (const row of rows) {
    const identity = xyProductIdentity(row);
    const product = findProduct(resolver, row);
    let productId = product?.id ?? null;

    try {
      if (!productId) {
        const created = await createMissingXyProductFromRow(context.supabase, resolver, row, context.capturedAt);
        if (created.product?.id) {
          productId = created.product.id;
          if (created.action === "created") stats.rowsImported += 1;
          else stats.rowsUpdated += 1;
        } else if (created.error) {
          stats.errors.push(`Product ${identity.productName || identity.vmsProductId || "unknown"} was not auto-created: ${created.error}`);
        }
      }

      await upsertXyProductMapping({
        supabase: context.supabase,
        resolver,
        row,
        productId,
        capturedAt: context.capturedAt,
        syncRunId: context.syncRunId,
      });
      stats.rowsUpdated += 1;

      if (productId) {
        await updateMatchedProductFromXy(context.supabase, productId, row, context.capturedAt);
        stats.rowsUpdated += 1;
      }
    } catch (error) {
      stats.rowsSkipped += 1;
      stats.errors.push(safeErrorMessage(error));
    }

    snapshots.push({
      sync_run_id: context.syncRunId,
      vms_product_id: identity.vmsProductId || null,
      third_party_product_id: identity.thirdPartyProductId || null,
      product_id: productId,
      product_name: identity.productName || identity.vmsProductId || null,
      barcode: identity.barcode || null,
      selling_price_lyd: identity.sellingPrice,
      image_url: identity.imageUrl || null,
      detail_images: detailImages(row),
      raw_data: row,
      captured_at: context.capturedAt,
    });
  }

  if (snapshots.length) {
    await insertChunks(context.supabase, "vms_product_catalog_snapshots", snapshots);
    stats.rowsImported += snapshots.length;
  }

  return stats;
}

async function loadXyMachines(supabase: SupabaseServer) {
  const { data, error } = await supabase
    .from("machines")
    .select("id, name, machine_code, vms_machine_id")
    .not("vms_machine_id", "is", null)
    .order("name");
  if (error) throw new Error(`Could not load XY machines: ${error.message}`);
  const machines = ((data ?? []) as MachineReference[]).filter((machine): machine is XyMachineReference => Boolean(machine.vms_machine_id));
  if (!machines.length) throw new Error("No XY machines found. Run Sync Machines first.");
  return machines;
}

async function createStockImportBatch(context: SyncContext) {
  const { data, error } = await context.supabase
    .from("vms_import_batches")
    .insert({
      source_type: "api",
      file_name: "XY queryMachineHdGoodPlus",
      file_type: "api",
      sheet_name: "queryMachineHdGoodPlus",
      report_type: "stock",
      imported_by: context.profile?.team_member_id ?? null,
      status: "draft",
      row_count: 0,
      rows_imported: 0,
      rows_skipped: 0,
      notes: JSON.stringify({ provider: "xy", sync_run_id: context.syncRunId }),
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`Could not create VMS API import batch: ${error?.message ?? "missing id"}`);
  return data.id as string;
}

async function finishStockImportBatch(context: SyncContext, batchId: string, stats: SyncStats) {
  const importedAt = new Date().toISOString();
  const status: "failed" | "imported" | "imported_with_warnings" =
    stats.rowsImported > 0
      ? (stats.errors.length ? "imported_with_warnings" : "imported")
      : (stats.errors.length ? "failed" : "imported");
  const shouldActivate = stats.rowsImported > 0;
  const { error } = await context.supabase
    .from("vms_import_batches")
    .update({
      status,
      is_active: shouldActivate,
      imported_at: importedAt,
      row_count: stats.rowCount,
      rows_imported: stats.rowsImported,
      rows_skipped: stats.rowsSkipped,
      error_count: stats.errors.length,
      errors: stats.errors,
      notes: JSON.stringify({ provider: "xy", sync_run_id: context.syncRunId, summary: stats.responseSummary }),
    })
    .eq("id", batchId);
  if (error) throw new Error(`Could not finalize VMS API import batch: ${error.message}`);

  if (!shouldActivate) return;

  const { data: activeBatches, error: activeBatchError } = await context.supabase
    .from("vms_import_batches")
    .select("id")
    .in("report_type", ["stock", "machine_stock_snapshot"])
    .in("status", ["imported", "imported_with_warnings", "partially_imported"])
    .eq("is_active", true)
    .neq("id", batchId);
  if (activeBatchError) {
    console.warn("[xy-vms-sync] Could not load older active VMS stock batches", { batchId, error: activeBatchError });
    return;
  }

  const staleBatchIds = ((activeBatches ?? []) as Array<{ id?: string | null }>)
    .map((batch) => String(batch.id ?? "").trim())
    .filter(Boolean);
  if (!staleBatchIds.length) return;

  const { error: deactivateError } = await context.supabase
    .from("vms_import_batches")
    .update({ is_active: false })
    .in("id", staleBatchIds);
  if (deactivateError) {
    console.warn("[xy-vms-sync] Could not deactivate older active VMS stock batches", { batchId, staleBatchIds, error: deactivateError });
  }
}

async function syncMachineGoodsWork(context: SyncContext) {
  const stats = emptyStats();
  const machines = await loadXyMachines(context.supabase);
  const resolver = await loadProductResolver(context.supabase);
  const batchId = await createStockImportBatch(context);
  const snapshots: JsonRecord[] = [];
  let rowNumber = 0;

  for (const machine of machines) {
    try {
      const response = await callXyApi("queryMachineHdGoodPlus", {
        shbh: context.config.merchantId,
        jqbh: machine.vms_machine_id,
      });
      const rows = arrayify(response.data);
      stats.rowCount += rows.length;

      for (const row of rows) {
        rowNumber += 1;
        const identity = xyProductIdentity(row);
        const product = findProduct(resolver, row);
        const productId = product?.id ?? null;
        const currentQty = integerValue(row.hdkc);
        const capacity = integerValue(row.hdrl);

        if (currentQty === null) {
          stats.rowsSkipped += 1;
          stats.errors.push(`Machine ${machine.vms_machine_id} slot ${text(row, "hdbh") || rowNumber} missing hdkc.`);
          continue;
        }

        try {
          await upsertXyProductMapping({
            supabase: context.supabase,
            resolver,
            row,
            productId,
            machine,
            capturedAt: context.capturedAt,
            syncRunId: context.syncRunId,
          });
        } catch (error) {
          stats.errors.push(safeErrorMessage(error));
        }

        snapshots.push({
          import_batch_id: batchId,
          import_row_number: rowNumber,
          import_row_status: "imported",
          sync_run_id: context.syncRunId,
          source_provider: "xy",
          machine_id: machine.id,
          vms_machine_id: machine.vms_machine_id,
          slot_code: text(row, "hdbh") || null,
          vms_product_id: identity.vmsProductId || null,
          third_party_product_id: identity.thirdPartyProductId || null,
          vms_product_name: identity.productName || null,
          product_id: productId,
          current_qty: currentQty,
          capacity,
          captured_at: context.capturedAt,
          locked_inventory_qty: integerValue(row.sdkcsl),
          vms_selling_price_lyd: identity.sellingPrice,
          product_image_url: identity.imageUrl || null,
          production_date: parseDate(row.scrq),
          aisle_status: text(row, "hdzt") || null,
          tray_status: text(row, "hdzt") || null,
          metadata: { provider: "xy", raw: row },
        });
      }

      stats.responseSummary[machine.vms_machine_id] = { rows: rows.length, message: response.message };
    } catch (error) {
      stats.errors.push(`Machine ${machine.vms_machine_id}: ${safeErrorMessage(error)}`);
    }
  }

  if (snapshots.length) {
    await insertChunks(context.supabase, "vms_stock_snapshots", snapshots);
    stats.rowsImported += snapshots.length;
  }

  await finishStockImportBatch(context, batchId, stats);
  return stats;
}

async function syncMachineStatusWork(context: SyncContext) {
  const stats = emptyStats();
  const machines = await loadXyMachines(context.supabase);
  const snapshots: JsonRecord[] = [];

  for (const machine of machines) {
    try {
      const response = await callXyApi("queryMachineState", {
        shbh: context.config.merchantId,
        jqbh: machine.vms_machine_id,
      });
      const state = arrayify(response.data)[0] ?? {};
      stats.rowCount += 1;

      const networkStatus = text(state, "wlzt");
      const temperatureRaw = text(state, "wd");
      const humidityRaw = text(state, "sd");
      snapshots.push({
        sync_run_id: context.syncRunId,
        machine_id: machine.id,
        vms_machine_id: machine.vms_machine_id,
        network_status: networkStatus || null,
        temperature_raw: temperatureRaw || null,
        humidity_raw: humidityRaw || null,
        raw_data: state,
        captured_at: context.capturedAt,
      });

      const machineUpdate: Record<string, unknown> = {
        vms_online_status: networkStatus || null,
        vms_temperature_raw: temperatureRaw || null,
        vms_humidity_raw: humidityRaw || null,
        last_vms_status_at: context.capturedAt,
        vms_last_synced_at: context.capturedAt,
        updated_at: new Date().toISOString(),
      };
      const numericTemperature = singleNumericText(temperatureRaw);
      if (numericTemperature !== null) machineUpdate.vms_temperature_c = numericTemperature;

      const { error: updateError } = await context.supabase.from("machines").update(machineUpdate).eq("id", machine.id);
      if (updateError) {
        stats.errors.push(`Machine ${machine.vms_machine_id} status update failed: ${updateError.message}`);
      } else {
        stats.rowsUpdated += 1;
      }
      stats.responseSummary[machine.vms_machine_id] = { message: response.message, network_status: networkStatus || null };
    } catch (error) {
      stats.errors.push(`Machine ${machine.vms_machine_id}: ${safeErrorMessage(error)}`);
    }
  }

  if (snapshots.length) {
    await insertChunks(context.supabase, "vms_machine_status_snapshots", snapshots);
    stats.rowsImported += snapshots.length;
  }

  return stats;
}

async function testOfficialEndpoint(context: SyncContext, endpoint: XyVmsEndpoint, params: XyVmsParams) {
  const requestDebug = buildXyRequestDebug(endpoint, params, context.config);
  try {
    const result = await callXyApiRaw(endpoint, params);
    return { result, summary: summarizeRawResponse(endpoint, result) };
  } catch (error) {
    return { result: null, summary: failedEndpointSummary(endpoint, error, requestDebug) };
  }
}

async function testOfficialApiWork(context: SyncContext) {
  const stats = emptyStats();
  const machineTest = await testOfficialEndpoint(context, "queryMachine", { shbh: context.config.merchantId });

  stats.responseSummary.queryMachine = machineTest.summary;
  stats.rowCount += summaryRowCount(machineTest.summary);

  if (!summaryHttpOk(machineTest.summary) || summaryCode(machineTest.summary) !== "1") {
    const authMessage = officialAuthFailureMessage(machineTest.summary);
    if (authMessage) stats.errors.push(authMessage);
    stats.errors.push(`queryMachine failed: ${summaryMessage(machineTest.summary) || "No response message."}`);
  }

  return stats;
}

async function testUnsignedEndpoint(context: SyncContext, endpoint: XyVmsEndpoint, params: XyVmsParams) {
  try {
    const result = await callXyApiRaw(endpoint, params, { signingMode: "unsigned" });
    return { result, summary: summarizeRawResponse(endpoint, result) };
  } catch (error) {
    return { result: null, summary: failedEndpointSummary(endpoint, error) };
  }
}

async function testUnsignedMerchantWork(context: SyncContext) {
  const stats = emptyStats();
  const businessParams = { shbh: context.config.merchantId };
  const machineTest = await testUnsignedEndpoint(context, "queryMachine", businessParams);

  stats.responseSummary.queryMachine = machineTest.summary;
  stats.rowCount += summaryRowCount(machineTest.summary);

  if (summaryCode(machineTest.summary) !== "1") {
    stats.errors.push(
      looksLikeAuthSignFailure(machineTest.summary)
        ? "XY requires API key/secret/sign. Please request credentials from XY."
        : `queryMachine failed: ${summaryMessage(machineTest.summary) || "No response message."}`,
    );
    return stats;
  }

  const productTest = await testUnsignedEndpoint(context, "queryGoodDetails", businessParams);
  stats.responseSummary.queryGoodDetails = productTest.summary;
  stats.rowCount += summaryRowCount(productTest.summary);
  if (summaryCode(productTest.summary) !== "1") {
    stats.errors.push(
      looksLikeAuthSignFailure(productTest.summary)
        ? "XY requires API key/secret/sign. Please request credentials from XY."
        : `queryGoodDetails failed: ${summaryMessage(productTest.summary) || "No response message."}`,
    );
  }

  const machineRows = machineTest.result ? arrayify(machineTest.result.response.data) : [];
  const firstMachineId = machineRows.map((row) => text(row, "jqbh")).find(Boolean);
  if (!firstMachineId) {
    stats.errors.push("queryMachine returned code 1 but no jqbh machine rows.");
    return stats;
  }

  const machineParams = { shbh: context.config.merchantId, jqbh: firstMachineId };
  const goodsTest = await testUnsignedEndpoint(context, "queryMachineHdGoodPlus", machineParams);
  stats.responseSummary.queryMachineHdGoodPlus = goodsTest.summary;
  stats.rowCount += summaryRowCount(goodsTest.summary);
  if (summaryCode(goodsTest.summary) !== "1") {
    stats.errors.push(
      looksLikeAuthSignFailure(goodsTest.summary)
        ? "XY requires API key/secret/sign. Please request credentials from XY."
        : `queryMachineHdGoodPlus failed: ${summaryMessage(goodsTest.summary) || "No response message."}`,
    );
  }

  const stateTest = await testUnsignedEndpoint(context, "queryMachineState", machineParams);
  stats.responseSummary.queryMachineState = stateTest.summary;
  stats.rowCount += summaryRowCount(stateTest.summary);
  if (summaryCode(stateTest.summary) !== "1") {
    stats.errors.push(
      looksLikeAuthSignFailure(stateTest.summary)
        ? "XY requires API key/secret/sign. Please request credentials from XY."
        : `queryMachineState failed: ${summaryMessage(stateTest.summary) || "No response message."}`,
    );
  }

  return stats;
}

export async function syncXyMachines(options: SyncOptions = {}) {
  return runXySync("machines", options, syncMachinesWork);
}

export async function syncXyProducts(options: SyncOptions = {}) {
  return runXySync("products", options, syncProductsWork);
}

export async function syncXyMachineGoods(options: SyncOptions = {}) {
  return runXySync("machine_goods", options, syncMachineGoodsWork);
}

export async function syncXyMachineStatus(options: SyncOptions = {}) {
  return runXySync("machine_status", options, syncMachineStatusWork);
}

export async function testXyOfficialApi(options: SyncOptions = {}) {
  return runXySync("test_official", options, testOfficialApiWork);
}

export async function testXyUnsignedMerchant(options: SyncOptions = {}) {
  return runXySync("test_unsigned", options, testUnsignedMerchantWork);
}

export async function syncXyAll(options: SyncOptions = {}) {
  return runXySync("all", options, async (context) => {
    const aggregate = emptyStats();
    const steps: [string, (context: SyncContext) => Promise<SyncStats>][] = [
      ["machines", syncMachinesWork],
      ["products", syncProductsWork],
      ["machine_goods", syncMachineGoodsWork],
      ["machine_status", syncMachineStatusWork],
    ];

    for (const [name, step] of steps) {
      try {
        const stats = await step(context);
        mergeStats(aggregate, stats);
        aggregate.responseSummary[name] = stats.responseSummary;
      } catch (error) {
        aggregate.errors.push(`${name}: ${safeErrorMessage(error)}`);
      }
    }

    return aggregate;
  });
}
