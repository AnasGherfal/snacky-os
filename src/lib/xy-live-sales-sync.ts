import "server-only";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import type { UserProfile } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { callXyWebApi, getXyWebApiConfig } from "@/lib/xy-web-api";
import {
  extractXyLiveSalesRows,
  normalizeXyLiveSalesRow,
  renderXyLiveSalesRequestTemplate,
  type XyLiveSalesRawRow,
} from "@/lib/xy-live-sales";

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;

type SyncOptions = {
  profile?: UserProfile | null;
  now?: Date;
};

type MachineRef = {
  id: string;
  name: string | null;
  machine_code: string | null;
  vms_machine_id: string | null;
};

type ProductRef = {
  id: string;
  name: string | null;
  sku: string | null;
  barcode: string | null;
};

type MappingRef = {
  vms_product_id: string | null;
  vms_product_name: string | null;
  vms_third_party_product_id: string | null;
  vms_barcode: string | null;
  product_id: string | null;
  match_status: string | null;
};

export type XyLiveSalesConfig = {
  enabled: boolean;
  path: string;
  requestTemplate: string;
  responseRowsPath: string | null;
  pageSize: number;
  maxPages: number;
  lookbackHours: number;
  ready: boolean;
  missing: string[];
};

export type XyLiveSalesSyncResult = {
  outcome: "disabled" | "unavailable" | "in_progress" | "completed" | "failed";
  syncRunId: string | null;
  importBatchId: string | null;
  fetchedRows: number;
  insertedRows: number;
  duplicateRows: number;
  mappedMachineRows: number;
  mappedProductRows: number;
  successfulSaleRows: number;
  latestSaleAt: string | null;
  message: string;
};

function envFlag(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envNumber(value: string | undefined, defaultValue: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function cleanPath(value: string) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? `/${trimmed.replace(/^\/+/, "")}` : "";
}

const VERIFIED_XY_LIVE_SALES_PATH = "/service-order/jqjymx/queryJqjymx";
const VERIFIED_XY_LIVE_SALES_RESPONSE_ROWS_PATH = "data";
const VERIFIED_XY_LIVE_SALES_REQUEST_TEMPLATE = JSON.stringify({
  orderBy: "jysj desc",
  userid: "",
  pageNum: "{{page}}",
  pageSize: "{{pageSize}}",
  jqmc: "",
  jqlx: "",
  shmc: "",
  chzt: "",
  dsfjybh: "",
  starttime: "{{startDateTime}}",
  endtime: "{{endDateTime}}",
  language: "{{language}}",
  channel: "{{channel}}",
});

export function getXyLiveSalesConfig(): XyLiveSalesConfig {
  const enabled = envFlag(process.env.XY_WEB_LIVE_SALES_ENABLED, false);
  const path = cleanPath(process.env.XY_WEB_SALES_PATH ?? VERIFIED_XY_LIVE_SALES_PATH);
  const requestTemplate = String(process.env.XY_WEB_SALES_REQUEST_TEMPLATE ?? VERIFIED_XY_LIVE_SALES_REQUEST_TEMPLATE).trim();
  const responseRowsPath = String(process.env.XY_WEB_SALES_RESPONSE_ROWS_PATH ?? VERIFIED_XY_LIVE_SALES_RESPONSE_ROWS_PATH).trim() || null;
  const pageSize = envNumber(process.env.XY_WEB_SALES_PAGE_SIZE, 100, 1, 1000);
  const maxPages = envNumber(process.env.XY_WEB_SALES_MAX_PAGES, 20, 1, 100);
  const lookbackHours = envNumber(process.env.XY_WEB_SALES_LOOKBACK_HOURS, 72, 1, 24 * 31);
  const web = getXyWebApiConfig();
  const missing = [
    enabled ? "" : "XY_WEB_LIVE_SALES_ENABLED=true",
    web.enabled ? "" : "XY_WEB_ENABLED=true",
    web.authorization ? "" : "XY_WEB_API_AUTHORIZATION",
  ].filter(Boolean);
  return {
    enabled,
    path,
    requestTemplate,
    responseRowsPath,
    pageSize,
    maxPages,
    lookbackHours,
    ready: missing.length === 0,
    missing,
  };
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function normalizeKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff\u4e00-\u9fff]+/g, "");
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatTripoli(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const y = values.get("year") ?? "";
  const m = values.get("month") ?? "";
  const d = values.get("day") ?? "";
  const h = values.get("hour") ?? "00";
  const min = values.get("minute") ?? "00";
  const s = values.get("second") ?? "00";
  return {
    date: `${y}-${m}-${d}`,
    dateTime: `${y}-${m}-${d} ${h}:${min}:${s}`,
  };
}

function templateValues({
  start,
  end,
  page,
  pageSize,
}: {
  start: Date;
  end: Date;
  page: number;
  pageSize: number;
}) {
  const web = getXyWebApiConfig();
  const startLocal = formatTripoli(start);
  const endLocal = formatTripoli(end);
  return {
    merchantId: web.merchantId,
    language: web.language,
    channel: web.channel,
    page,
    pageSize,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startDate: startLocal.date,
    endDate: endLocal.date,
    startDateTime: startLocal.dateTime,
    endDateTime: endLocal.dateTime,
  };
}

async function recentRunningSync(supabase: SupabaseAdmin) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("vms_sync_runs")
    .select("id, started_at")
    .eq("provider", "xy_web")
    .eq("sync_type", "sales_live")
    .eq("status", "running")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not check live-sales sync lock: ${error.message}`);
  return data;
}

async function createSyncRun(supabase: SupabaseAdmin, profile: UserProfile | null | undefined, config: XyLiveSalesConfig) {
  const web = getXyWebApiConfig();
  const { data, error } = await supabase
    .from("vms_sync_runs")
    .insert({
      provider: "xy_web",
      sync_type: "sales_live",
      status: "running",
      endpoint: config.path,
      merchant_id_masked: web.maskedMerchantId,
      requested_by: profile?.team_member_id ?? null,
      request_summary: {
        provider: "xy_web",
        sync_type: "sales_live",
        endpoint: config.path,
        merchant_id: web.maskedMerchantId,
        page_size: config.pageSize,
        max_pages: config.maxPages,
        lookback_hours: config.lookbackHours,
        response_rows_path: config.responseRowsPath,
      },
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`Could not create live-sales sync run: ${error?.message ?? "missing id"}`);
  return String(data.id);
}

async function finishSyncRun(
  supabase: SupabaseAdmin,
  syncRunId: string,
  status: "completed" | "completed_with_warnings" | "failed",
  summary: Record<string, unknown>,
  errors: string[],
  message: string,
) {
  const { error } = await supabase
    .from("vms_sync_runs")
    .update({
      status,
      row_count: Number(summary.fetched_rows ?? 0),
      rows_imported: Number(summary.inserted_rows ?? 0),
      rows_updated: 0,
      rows_skipped: Number(summary.duplicate_rows ?? 0),
      error_count: errors.length,
      message,
      response_summary: summary,
      errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", syncRunId);
  if (error) console.error("[xy-live-sales] Could not finish sync run", { syncRunId, error });
}

async function createImportBatch(
  supabase: SupabaseAdmin,
  profile: UserProfile | null | undefined,
  config: XyLiveSalesConfig,
  start: Date,
  end: Date,
) {
  const startLocal = formatTripoli(start).date;
  const endLocal = formatTripoli(end).date;
  const { data, error } = await supabase
    .from("vms_import_batches")
    .insert({
      source_type: "api",
      file_name: "XY live sales API",
      file_type: "api",
      sheet_name: config.path,
      report_type: "vms_order_details_weekly",
      imported_by: profile?.team_member_id ?? null,
      uploaded_by: profile?.team_member_id ?? null,
      status: "draft",
      is_active: false,
      import_mode: "append",
      report_start_date: startLocal,
      report_end_date: endLocal,
      source_usage: {
        source_type: "xy_live_sales_api",
        main_sales_source: true,
        reconciliation_only: false,
      },
      dashboard_usage: ["sales", "products", "machines", "smart_routes"],
      notes: JSON.stringify({
        provider: "xy_web",
        source: "live_sales",
        endpoint: config.path,
        lookback_hours: config.lookbackHours,
      }),
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`Could not create live-sales import batch: ${error?.message ?? "missing id"}`);
  return String(data.id);
}

function addLookup<T>(map: Map<string, T>, key: unknown, value: T) {
  const normalized = normalizeKey(key);
  if (normalized && !map.has(normalized)) map.set(normalized, value);
}

async function loadResolvers(supabase: SupabaseAdmin) {
  const [machinesResult, productsResult, mappingsResult] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, vms_machine_id").eq("status", "active"),
    supabase.from("products").select("id, name, sku, barcode").eq("active", true),
    supabase.from("vms_product_mappings").select("vms_product_id, vms_product_name, vms_third_party_product_id, vms_barcode, product_id, match_status"),
  ]);
  if (machinesResult.error) throw new Error(`Could not load live-sales machines: ${machinesResult.error.message}`);
  if (productsResult.error) throw new Error(`Could not load live-sales products: ${productsResult.error.message}`);
  if (mappingsResult.error) throw new Error(`Could not load live-sales product mappings: ${mappingsResult.error.message}`);

  const machineByKey = new Map<string, MachineRef>();
  ((machinesResult.data ?? []) as MachineRef[]).forEach((machine) => {
    addLookup(machineByKey, machine.vms_machine_id, machine);
    addLookup(machineByKey, machine.machine_code, machine);
    addLookup(machineByKey, machine.name, machine);
  });

  const productById = new Map<string, ProductRef>();
  const productByKey = new Map<string, ProductRef>();
  ((productsResult.data ?? []) as ProductRef[]).forEach((product) => {
    productById.set(product.id, product);
    addLookup(productByKey, product.sku, product);
    addLookup(productByKey, product.barcode, product);
    addLookup(productByKey, product.name, product);
  });

  const mappedProductByKey = new Map<string, ProductRef>();
  ((mappingsResult.data ?? []) as MappingRef[])
    .filter((mapping) => mapping.match_status === "confirmed" && mapping.product_id)
    .forEach((mapping) => {
      const product = productById.get(String(mapping.product_id));
      if (!product) return;
      addLookup(mappedProductByKey, mapping.vms_product_id, product);
      addLookup(mappedProductByKey, mapping.vms_product_name, product);
      addLookup(mappedProductByKey, mapping.vms_third_party_product_id, product);
      addLookup(mappedProductByKey, mapping.vms_barcode, product);
    });

  return { machineByKey, productByKey, mappedProductByKey };
}

function resolveMachine(row: ReturnType<typeof normalizeXyLiveSalesRow>, machineByKey: Map<string, MachineRef>) {
  return machineByKey.get(normalizeKey(row.machineCode))
    ?? machineByKey.get(normalizeKey(row.machineName))
    ?? null;
}

function resolveProduct(
  row: ReturnType<typeof normalizeXyLiveSalesRow>,
  mappedProductByKey: Map<string, ProductRef>,
  productByKey: Map<string, ProductRef>,
) {
  return mappedProductByKey.get(normalizeKey(row.productNumber))
    ?? mappedProductByKey.get(normalizeKey(row.productName))
    ?? productByKey.get(normalizeKey(row.productNumber))
    ?? productByKey.get(normalizeKey(row.productName))
    ?? null;
}

function transactionTimestamp(row: ReturnType<typeof normalizeXyLiveSalesRow>) {
  return row.paymentTime ?? row.deliveryTime ?? row.refundTime ?? null;
}

function toDbRow({
  raw,
  normalized,
  batchId,
  rowNumber,
  mappedMachineId,
  mappedProductId,
}: {
  raw: XyLiveSalesRawRow;
  normalized: ReturnType<typeof normalizeXyLiveSalesRow>;
  batchId: string;
  rowNumber: number;
  mappedMachineId: string | null;
  mappedProductId: string | null;
}) {
  return {
    import_batch_id: batchId,
    row_number: rowNumber,
    merchant_id: normalized.canonicalRow.merchant_id || null,
    merchant_name: normalized.canonicalRow.merchant_name || null,
    machine_code: normalized.machineCode || null,
    machine_name: normalized.machineName || null,
    order_number: normalized.orderNumber || null,
    cargo_lane_number: normalized.cargoLane || null,
    product_number: normalized.productNumber || null,
    vms_product_name: normalized.productName || null,
    commodity_price_1: normalized.salesPrice,
    commodity_price_2: null,
    discounted_price: normalized.discountedPrice,
    delivery_time: normalized.deliveryTime?.toISOString() ?? null,
    shipping_status: normalized.shippingStatus || normalized.transactionStatus,
    purchaser: normalized.purchaser || null,
    refund_time: normalized.refundTime?.toISOString() ?? null,
    remarks: "XY live sales API",
    refund_status: normalized.transactionStatus === "refunded" ? "refunded" : null,
    third_party_transaction_number: normalized.thirdPartyTransactionNumber || null,
    third_party_order_no: normalized.thirdPartyOrderNo || null,
    payment_amount: normalized.paymentAmount,
    payment_time: normalized.paymentTime?.toISOString() ?? null,
    quantity: normalized.quantity,
    raw_row: raw,
    normalized_row: normalized.canonicalRow,
    mapped_machine_id: mappedMachineId,
    mapped_product_id: mappedProductId,
    transaction_status: normalized.transactionStatus,
    duplicate_hash: normalized.duplicateHash,
    business_date: normalized.businessDate,
  };
}

async function saveRows(supabase: SupabaseAdmin, rows: ReturnType<typeof toDbRow>[]) {
  let insertedRows = 0;
  let duplicateRows = 0;
  const chunkSize = 250;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { data, error } = await supabase
      .from("vms_transactions_raw")
      .upsert(chunk, { onConflict: "duplicate_hash", ignoreDuplicates: true })
      .select("id, duplicate_hash");
    if (error) throw new Error(`Could not save XY live sales transactions: ${error.message}`);
    const inserted = Array.isArray(data) ? data.length : 0;
    insertedRows += inserted;
    duplicateRows += Math.max(0, chunk.length - inserted);
  }
  return { insertedRows, duplicateRows };
}

function isVerifiedXyTransactionRow(row: XyLiveSalesRawRow) {
  const normalized = normalizeXyLiveSalesRow(row);
  return Boolean(
    normalized.machineCode
    && (normalized.productNumber || normalized.productName)
    && (normalized.paymentTime || normalized.thirdPartyTransactionNumber),
  );
}

function latestSaleAt(rows: Array<ReturnType<typeof normalizeXyLiveSalesRow>>) {
  const values = rows
    .filter((row) => row.transactionStatus === "successful_sale")
    .map(transactionTimestamp)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime());
  return values.at(-1)?.toISOString() ?? null;
}

function revalidateSalesPages() {
  [
    "/admin/vms-api",
    "/sales",
    "/dashboard",
    "/products-dashboard",
    "/machines-dashboard",
    "/routes/new",
    "/settings/smart-routes",
  ].forEach((path) => revalidatePath(path));
}

export async function syncXyLiveSales(options: SyncOptions = {}): Promise<XyLiveSalesSyncResult> {
  const config = getXyLiveSalesConfig();
  if (!config.enabled) {
    return {
      outcome: "disabled",
      syncRunId: null,
      importBatchId: null,
      fetchedRows: 0,
      insertedRows: 0,
      duplicateRows: 0,
      mappedMachineRows: 0,
      mappedProductRows: 0,
      successfulSaleRows: 0,
      latestSaleAt: null,
      message: "XY live sales sync is disabled.",
    };
  }
  if (!config.ready) {
    return {
      outcome: "unavailable",
      syncRunId: null,
      importBatchId: null,
      fetchedRows: 0,
      insertedRows: 0,
      duplicateRows: 0,
      mappedMachineRows: 0,
      mappedProductRows: 0,
      successfulSaleRows: 0,
      latestSaleAt: null,
      message: `XY live sales is not configured: ${config.missing.join(", ")}.`,
    };
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const running = await recentRunningSync(supabase);
  if (running?.id) {
    return {
      outcome: "in_progress",
      syncRunId: String(running.id),
      importBatchId: null,
      fetchedRows: 0,
      insertedRows: 0,
      duplicateRows: 0,
      mappedMachineRows: 0,
      mappedProductRows: 0,
      successfulSaleRows: 0,
      latestSaleAt: null,
      message: "An XY live sales sync is already running.",
    };
  }

  const now = options.now ?? new Date();
  const start = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const syncRunId = await createSyncRun(supabase, options.profile, config);
  let importBatchId: string | null = null;

  try {
    importBatchId = await createImportBatch(supabase, options.profile, config, start, now);
    const { machineByKey, productByKey, mappedProductByKey } = await loadResolvers(supabase);
    const allRawRows: XyLiveSalesRawRow[] = [];

    for (let page = 1; page <= config.maxPages; page += 1) {
      const body = renderXyLiveSalesRequestTemplate(
        config.requestTemplate,
        templateValues({ start, end: now, page, pageSize: config.pageSize }),
      );
      const result = await callXyWebApi(config.path, body);
      const extractedRows = extractXyLiveSalesRows(result.response, config.responseRowsPath);
      const rows = extractedRows.filter(isVerifiedXyTransactionRow);
      allRawRows.push(...rows);
      if (extractedRows.length < config.pageSize) break;
    }

    const normalizedRows = allRawRows.map(normalizeXyLiveSalesRow);
    const dbRows = normalizedRows.map((normalized, index) => {
      const machine = resolveMachine(normalized, machineByKey);
      const product = resolveProduct(normalized, mappedProductByKey, productByKey);
      return toDbRow({
        raw: allRawRows[index],
        normalized,
        batchId: importBatchId as string,
        rowNumber: index + 1,
        mappedMachineId: machine?.id ?? null,
        mappedProductId: product?.id ?? null,
      });
    });

    const { insertedRows, duplicateRows } = await saveRows(supabase, dbRows);
    const mappedMachineRows = dbRows.filter((row) => row.mapped_machine_id).length;
    const mappedProductRows = dbRows.filter((row) => row.mapped_product_id).length;
    const successfulSaleRows = normalizedRows.filter((row) => row.transactionStatus === "successful_sale").length;
    const failedRows = normalizedRows.filter((row) => ["failed_vend", "failed_payment"].includes(row.transactionStatus)).length;
    const refundedRows = normalizedRows.filter((row) => row.transactionStatus === "refunded").length;
    const needsReviewRows = normalizedRows.filter((row) => row.transactionStatus === "needs_review").length;
    const latestSale = latestSaleAt(normalizedRows);
    const successfulSalesAmount = normalizedRows.reduce((sum, row) => (
      row.transactionStatus === "successful_sale" ? sum + Math.max(0, row.paymentAmount ?? 0) : sum
    ), 0);
    const rowDates = normalizedRows.map((row) => row.businessDate).filter((value): value is string => Boolean(value)).sort();
    const errors: string[] = [];
    if (needsReviewRows) errors.push(`${needsReviewRows} live sales row(s) need status review.`);
    if (dbRows.some((row) => !row.mapped_machine_id)) errors.push("Some live sales rows could not be mapped to a Snacky machine.");
    if (dbRows.some((row) => !row.mapped_product_id)) errors.push("Some live sales rows could not be mapped to a Snacky product.");

    const batchStatus = insertedRows > 0
      ? (errors.length ? "imported_with_warnings" : "imported")
      : "partially_imported";
    const batchUpdate = await supabase
      .from("vms_import_batches")
      .update({
        status: batchStatus,
        is_active: insertedRows > 0,
        imported_at: new Date().toISOString(),
        row_count: allRawRows.length,
        rows_found: allRawRows.length,
        rows_imported: insertedRows,
        rows_skipped: duplicateRows,
        rows_skipped_duplicate: duplicateRows,
        rows_needing_review: needsReviewRows,
        error_count: errors.length,
        errors,
        report_start_date: rowDates[0] ?? formatTripoli(start).date,
        report_end_date: rowDates.at(-1) ?? formatTripoli(now).date,
        detected_min_datetime: normalizedRows
          .map(transactionTimestamp)
          .filter((value): value is Date => Boolean(value))
          .sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null,
        detected_max_datetime: latestSale,
        total_successful_sales: successfulSalesAmount,
        successful_rows_count: successfulSaleRows,
        failed_rows_count: failedRows,
        refunded_rows_count: refundedRows,
        latest_error: errors[0] ?? null,
        parse_diagnostics: {
          source: "xy_live_sales_api",
          endpoint: config.path,
          fetched_rows: allRawRows.length,
          inserted_rows: insertedRows,
          duplicate_rows: duplicateRows,
          mapped_machine_rows: mappedMachineRows,
          mapped_product_rows: mappedProductRows,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", importBatchId);
    if (batchUpdate.error) throw new Error(`Could not finalize XY live-sales import batch: ${batchUpdate.error.message}`);

    const summary = {
      endpoint: config.path,
      range_start: start.toISOString(),
      range_end: now.toISOString(),
      fetched_rows: allRawRows.length,
      inserted_rows: insertedRows,
      duplicate_rows: duplicateRows,
      mapped_machine_rows: mappedMachineRows,
      mapped_product_rows: mappedProductRows,
      successful_sale_rows: successfulSaleRows,
      failed_rows: failedRows,
      refunded_rows: refundedRows,
      needs_review_rows: needsReviewRows,
      latest_sale_at: latestSale,
      import_batch_id: importBatchId,
    };
    await finishSyncRun(
      supabase,
      syncRunId,
      errors.length ? "completed_with_warnings" : "completed",
      summary,
      errors,
      errors.length ? "XY live sales sync completed with mapping/status warnings" : "XY live sales sync completed",
    );

    await logActivity({
      profile: options.profile ?? null,
      action: "xy_live_sales_sync_completed",
      entityType: "vms_sync",
      entityId: syncRunId,
      entityLabel: "XY live sales",
      metadata: summary,
      summary: `Synced ${insertedRows} new XY live transaction row(s)`,
    });

    revalidateSalesPages();
    return {
      outcome: "completed",
      syncRunId,
      importBatchId,
      fetchedRows: allRawRows.length,
      insertedRows,
      duplicateRows,
      mappedMachineRows,
      mappedProductRows,
      successfulSaleRows,
      latestSaleAt: latestSale,
      message: errors.length
        ? "XY live sales synced with mapping/status warnings."
        : "XY live sales synced successfully.",
    };
  } catch (error) {
    const message = safeError(error);
    if (importBatchId) {
      await supabase
        .from("vms_import_batches")
        .update({
          status: "failed",
          is_active: false,
          failed_at: new Date().toISOString(),
          error_count: 1,
          errors: [message],
          latest_error: message,
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", importBatchId);
    }
    await finishSyncRun(supabase, syncRunId, "failed", {
      endpoint: config.path,
      import_batch_id: importBatchId,
      fetched_rows: 0,
      inserted_rows: 0,
      duplicate_rows: 0,
    }, [message], "XY live sales sync failed");
    revalidateSalesPages();
    return {
      outcome: "failed",
      syncRunId,
      importBatchId,
      fetchedRows: 0,
      insertedRows: 0,
      duplicateRows: 0,
      mappedMachineRows: 0,
      mappedProductRows: 0,
      successfulSaleRows: 0,
      latestSaleAt: null,
      message,
    };
  }
}

export async function latestXyLiveSalesHealth() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return {
    latestSaleAt: null,
    latestRunAt: null,
    latestRunStatus: null,
    latestInsertedRows: 0,
  };

  const [paymentResult, deliveryResult, runResult] = await Promise.all([
    supabase
      .from("vms_transactions_raw")
      .select("payment_time")
      .eq("transaction_status", "successful_sale")
      .not("mapped_machine_id", "is", null)
      .not("mapped_product_id", "is", null)
      .not("payment_time", "is", null)
      .order("payment_time", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("vms_transactions_raw")
      .select("delivery_time")
      .eq("transaction_status", "successful_sale")
      .not("mapped_machine_id", "is", null)
      .not("mapped_product_id", "is", null)
      .not("delivery_time", "is", null)
      .order("delivery_time", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("vms_sync_runs")
      .select("status, completed_at, response_summary")
      .eq("provider", "xy_web")
      .eq("sync_type", "sales_live")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const latestPaymentAt = String((paymentResult.data as { payment_time?: string | null } | null)?.payment_time ?? "") || null;
  const latestDeliveryAt = String((deliveryResult.data as { delivery_time?: string | null } | null)?.delivery_time ?? "") || null;
  const latestSaleAt = [latestPaymentAt, latestDeliveryAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const run = runResult.data as { status?: string | null; completed_at?: string | null; response_summary?: Record<string, unknown> | null } | null;
  return {
    latestSaleAt,
    latestRunAt: run?.completed_at ?? null,
    latestRunStatus: run?.status ?? null,
    latestInsertedRows: Number(run?.response_summary?.inserted_rows ?? 0),
  };
}


export async function ensureFreshXyLiveSales(options: SyncOptions & { maxAgeMs?: number } = {}) {
  const config = getXyLiveSalesConfig();
  if (!config.enabled) {
    return { outcome: "disabled" as const, refreshed: false, reason: "XY live sales sync is disabled." };
  }
  if (!config.ready) {
    return { outcome: "unavailable" as const, refreshed: false, reason: `Missing ${config.missing.join(", ")}.` };
  }

  const health = await latestXyLiveSalesHealth();
  const maxAgeMs = Math.max(10 * 60 * 1000, options.maxAgeMs ?? 90 * 60 * 1000);
  const latestRunMs = Date.parse(String(health.latestRunAt ?? ""));
  const runFresh = Number.isFinite(latestRunMs)
    && Date.now() - latestRunMs <= maxAgeMs
    && ["completed", "completed_with_warnings"].includes(String(health.latestRunStatus ?? ""));

  if (runFresh) {
    return { outcome: "already_fresh" as const, refreshed: false, reason: null, health };
  }

  const result = await syncXyLiveSales(options);
  return {
    outcome: result.outcome,
    refreshed: result.outcome === "completed" && result.insertedRows > 0,
    reason: result.message,
    health: await latestXyLiveSalesHealth(),
    result,
  };
}
