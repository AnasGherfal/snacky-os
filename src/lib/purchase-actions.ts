"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canManagePurchases, canRecordPurchasePayments } from "@/lib/authz";
import { financeAccountId } from "@/lib/finance-balance";
import { resolvePurchaseUnitCost, type ProductCostMemory } from "@/lib/purchase-cost-memory";
import { resolvePurchaseReceiptUrl } from "@/lib/purchase-receipts";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type PurchaseLineInput = {
  productId: string;
  boxesQty: number;
  unitsPerBox: number;
  looseUnitsQty: number;
  unitCost: number;
  unitCostBlank: boolean;
  unitCostZeroConfirmed: boolean;
  lineTotal: number;
  pricingMode: "unit" | "total";
  receiptLineName: string | null;
  matchAction: "accept" | "change" | "create" | "ignore";
  matchConfidence: number | null;
  newProduct: {
    name: string;
    sku: string;
    barcode: string | null;
    brand: string | null;
    category: string;
    caseQuantity: number;
  } | null;
};

type SupabaseServer = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

export type PurchaseSubmitResult = {
  ok: boolean;
  message: string;
  redirectTo?: string;
  debugMessage?: string;
};

type PurchaseReceiveResult = {
  financeWarning: boolean;
};

class PurchaseFormError extends Error {}

const PURCHASE_CREATE_RPC = "snacky_create_purchase_with_lines_v2";
const PURCHASE_SAVE_ADMIN_MESSAGE = "Could not save purchase. Please contact admin.";
const PURCHASE_SUBMISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function roundUnitCost(value: number) {
  return Math.round(value * 10000) / 10000;
}

function parseOptionalMoney(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? roundMoney(parsed) : null;
}

function parsePaymentStatus(value: FormDataEntryValue | null) {
  const status = String(value ?? "paid").trim();
  if (status === "partial") return "partially_paid";
  return ["paid", "unpaid", "partially_paid", "voided"].includes(status) ? status : "paid";
}

function parsePaymentAccountId(value: FormDataEntryValue | null, fallbackCurrency = "LYD") {
  return financeAccountId(String(value ?? "").trim(), fallbackCurrency);
}

function parseLineAction(value: unknown): PurchaseLineInput["matchAction"] {
  return value === "accept" || value === "change" || value === "create" || value === "ignore" ? value : "change";
}

function cleanOptionalString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseNewProduct(value: unknown): PurchaseLineInput["newProduct"] {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const name = String(row.name ?? "").trim();
  const sku = String(row.sku ?? "").trim();
  const category = String(row.category ?? "snack").trim() || "snack";
  const caseQuantity = Math.max(1, Math.floor(Number(row.caseQuantity ?? row.case_quantity ?? 1) || 1));
  if (!name && !sku) return null;
  return {
    name,
    sku,
    barcode: cleanOptionalString(row.barcode),
    brand: cleanOptionalString(row.brand),
    category,
    caseQuantity,
  };
}

function parseLines(raw: FormDataEntryValue | null): PurchaseLineInput[] {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((line): PurchaseLineInput => {
        const row = line && typeof line === "object" ? (line as Record<string, unknown>) : {};
        const matchAction = parseLineAction(row.matchAction);
        const unitCost = Math.max(0, Number(row.unitCost || row.unit_cost || row.unit_cost_lyd || 0));
        const unitCostZeroConfirmed = Boolean(row.unitCostZeroConfirmed ?? row.unit_cost_zero_confirmed ?? row.confirmedZeroCost);
        const hasBlankFlag = Object.prototype.hasOwnProperty.call(row, "unitCostBlank") || Object.prototype.hasOwnProperty.call(row, "unit_cost_blank");
        const pricingMode = row.pricingMode === "total" || row.pricing_mode === "total" ? "total" : "unit";
        return {
          productId: String(row.productId || row.product_id || ""),
          boxesQty: Math.max(0, Math.floor(Number(row.boxesQty || row.boxes_qty || 0))),
          unitsPerBox: Math.max(1, Math.floor(Number(row.unitsPerBox || row.units_per_box || 1))),
          looseUnitsQty: Math.max(0, Math.floor(Number(row.looseUnitsQty || row.loose_units_qty || 0))),
          unitCost,
          unitCostBlank: hasBlankFlag ? Boolean(row.unitCostBlank ?? row.unit_cost_blank) : unitCost === 0 && !unitCostZeroConfirmed,
          unitCostZeroConfirmed,
          lineTotal: Math.max(0, Number(row.lineTotal || row.line_total || row.line_total_lyd || 0)),
          pricingMode,
          receiptLineName: cleanOptionalString(row.receiptLineName ?? row.receipt_line_name),
          matchAction,
          matchConfidence: row.matchConfidence === null || row.matchConfidence === undefined ? null : Math.max(0, Math.min(1, Number(row.matchConfidence || 0))),
          newProduct: parseNewProduct(row.newProduct ?? row.new_product),
        };
      })
      .filter((line) => line.matchAction !== "ignore" && (line.productId || line.matchAction === "create") && line.boxesQty * line.unitsPerBox + line.looseUnitsQty > 0);
  } catch {
    return [];
  }
}

function buildLineRows(lines: PurchaseLineInput[]) {
  return lines.map((line, index) => {
    const totalUnits = line.boxesQty * line.unitsPerBox + line.looseUnitsQty;
    const lineTotal = line.pricingMode === "total" ? roundMoney(line.lineTotal) : roundMoney(totalUnits * line.unitCost);
    const unitCost = line.pricingMode === "total" && totalUnits > 0 ? roundUnitCost(lineTotal / totalUnits) : roundUnitCost(line.unitCost);
    return {
      product_id: line.productId,
      line_position: index,
      boxes_qty: line.boxesQty,
      units_per_box: line.unitsPerBox,
      loose_units_qty: line.looseUnitsQty,
      total_units: totalUnits,
      ordered_qty: totalUnits,
      received_qty: 0,
      unit_cost: unitCost,
      unit_cost_lyd: unitCost,
      line_total: lineTotal,
      line_total_lyd: lineTotal,
    };
  });
}

function totalUnitsForLine(line: PurchaseLineInput) {
  return Math.max(0, Math.floor(line.boxesQty)) * Math.max(1, Math.floor(line.unitsPerBox)) + Math.max(0, Math.floor(line.looseUnitsQty));
}

async function applySavedProductCostMemory(supabase: SupabaseServer, lines: PurchaseLineInput[]) {
  const productIds = Array.from(new Set(lines.map((line) => line.productId).filter(Boolean)));
  const productsById = new Map<string, ProductCostMemory>();
  if (productIds.length) {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, cost_price, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd")
      .in("id", productIds);
    if (error) throw error;
    for (const product of data ?? []) productsById.set(String((product as any).id), product as ProductCostMemory);
  }

  return lines.map((line) => {
    const product = productsById.get(line.productId);
    const decision = resolvePurchaseUnitCost({
      product,
      productName: product?.name ?? line.newProduct?.name ?? line.receiptLineName,
      unitCost: line.unitCost,
      unitCostBlank: line.unitCostBlank,
      unitCostZeroConfirmed: line.unitCostZeroConfirmed,
      pricingMode: line.pricingMode,
      lineTotal: line.lineTotal,
      totalUnits: totalUnitsForLine(line),
    });
    if ("message" in decision) formError(decision.message);
    return {
      ...line,
      unitCost: decision.unitCost,
      unitCostBlank: false,
      lineTotal: line.pricingMode === "total" && line.lineTotal > 0 ? roundMoney(line.lineTotal) : roundMoney(totalUnitsForLine(line) * decision.unitCost),
      pricingMode: decision.kind === "product_memory" ? "unit" : line.pricingMode,
    };
  });
}

function buildTotals(fd: FormData, calculatedTotal: number) {
  const calculatedTotalLyd = roundMoney(calculatedTotal);
  const manualTotalLyd = parseOptionalMoney(fd.get("manual_total_lyd"));
  const totalSource = manualTotalLyd === null ? "calculated" : "manual";
  const totalAdjustmentLyd = manualTotalLyd === null ? null : roundMoney(manualTotalLyd - calculatedTotalLyd);
  return {
    calculated_total_lyd: calculatedTotalLyd,
    manual_total_lyd: manualTotalLyd,
    total_adjustment_lyd: totalAdjustmentLyd,
    total_source: totalSource,
    total_amount: manualTotalLyd ?? calculatedTotalLyd,
  };
}

function resolvePurchaseLines(lines: PurchaseLineInput[]) {
  if (lines.some((line) => line.matchAction === "create")) {
    formError(
      "Create every new product from Products first, then return and select it on the receipt line. No product or purchase was changed.",
    );
  }
  return lines.filter((line) => line.productId);
}

async function saveApprovedReceiptAliases(supabase: SupabaseServer, profile: Awaited<ReturnType<typeof getCurrentProfile>>, lines: PurchaseLineInput[]) {
  const seen = new Set<string>();
  const rows = lines
    .filter((line) => line.productId && line.receiptLineName && line.matchAction !== "ignore")
    .map((line) => ({
      alias_name: line.receiptLineName as string,
      product_id: line.productId,
      source: "receipt",
      confidence: line.matchConfidence,
      approved_by: profile?.team_member_id ?? null,
    }))
    .filter((row) => {
      const key = `${row.alias_name.trim().toLowerCase()}::${row.product_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return row.alias_name.trim().length > 0;
    });

  if (!rows.length) return;
  const { error } = await supabase.from("product_aliases").upsert(rows, { onConflict: "alias_name,product_id" });
  if (error) console.warn("[purchases] Could not save receipt product aliases", error);
}

async function linkReceiptScanResult(supabase: SupabaseServer, scanResultId: string, purchaseId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanResultId)) return;
  const { error } = await supabase.from("receipt_scan_results").update({ purchase_id: purchaseId }).eq("id", scanResultId);
  if (error) console.warn("[purchases] Could not link receipt scan result to purchase", error);
}

function fail(path: string, message: string): never {
  const params = new URLSearchParams({ error: message });
  redirect(`${path}?${params.toString()}`);
}

function formError(message: string): never {
  throw new PurchaseFormError(message);
}

function purchaseSubmitError(error: unknown, fallback: string): PurchaseSubmitResult {
  if (typeof error === "object" && error && "digest" in error && String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")) {
    throw error;
  }
  if (error instanceof PurchaseFormError) return { ok: false, message: error.message };
  console.error("[purchases] Purchase submit failed", error);
  return {
    ok: false,
    message: fallback,
    debugMessage: process.env.NODE_ENV !== "production" && error instanceof Error ? error.message : undefined,
  };
}

function supabaseErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return { code: null, message: error instanceof Error ? error.message : String(error ?? "Unknown error"), details: null, hint: null };
  }
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return {
    code: row.code ?? null,
    message: row.message ?? (error instanceof Error ? error.message : "Unknown database error"),
    details: row.details ?? null,
    hint: row.hint ?? null,
  };
}

function logPurchaseSaveFailure({
  step,
  error,
  profile,
  purchaseDate,
  supplierId,
  lines,
  receiptStatus,
  rpcName,
  payloadKeys,
}: {
  step: string;
  error: unknown;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  purchaseDate: string;
  supplierId: string | null;
  lines: PurchaseLineInput[];
  receiptStatus?: Record<string, unknown>;
  rpcName?: string;
  payloadKeys?: string[];
}) {
  console.error("[purchases] Purchase save failed", {
    failed_step: step,
    rpc_name: rpcName ?? null,
    payload_keys: payloadKeys ?? null,
    user_id: profile?.id ?? null,
    user_roles: profile?.roles ?? [],
    purchase_date: purchaseDate,
    supplier_id: supplierId,
    line_count: lines.length,
    product_ids: lines.map((line) => line.productId).filter(Boolean),
    quantities: lines.map((line) => ({
      product_id: line.productId || null,
      boxes_qty: line.boxesQty,
      units_per_box: line.unitsPerBox,
      loose_units_qty: line.looseUnitsQty,
      total_units: line.boxesQty * line.unitsPerBox + line.looseUnitsQty,
    })),
    costs: lines.map((line) => ({
      product_id: line.productId || null,
      unit_cost: line.unitCost,
      unit_cost_blank: line.unitCostBlank,
      unit_cost_zero_confirmed: line.unitCostZeroConfirmed,
      line_total: line.lineTotal,
      pricing_mode: line.pricingMode,
    })),
    receipt_image_status: receiptStatus ?? null,
    supabase_error: supabaseErrorDetails(error),
    original_error: error,
  });
}

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function requireConfirmedReason(formData: FormData, path: string) {
  if (clean(formData.get("confirm_action")) !== "yes") fail(path, "Confirmation is required.");
  const reason = clean(formData.get("reason"));
  if (!reason) fail(path, "Reason is required.");
  return reason;
}

async function requirePurchaseAccess() {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePurchases(profile)) redirect("/unauthorized");
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  if (!supabase) redirect("/purchases?error=Supabase%20is%20not%20configured.");
  return { profile, supabase };
}

async function requirePurchasePaymentAccess() {
  const profile = await getCurrentProfile();
  if (!profile || !canRecordPurchasePayments(profile)) redirect("/unauthorized");
  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  if (!supabase) redirect("/purchases?error=Supabase%20is%20not%20configured.");
  return { profile, supabase };
}

function parseSupplierPaymentTimestamp(value: FormDataEntryValue | null) {
  const raw = clean(value);
  if (!raw) return new Date().toISOString();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00+02:00` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function purchaseFinanceLinkFilter(purchaseId: string) {
  return `linked_purchase_id.eq.${purchaseId},and(source_type.eq.purchase,source_id.eq.${purchaseId})`;
}

type LinkedFinanceRow = {
  id: string;
  [key: string]: unknown;
};

function financeWarningParam(financeWarning: boolean) {
  return financeWarning ? "manual-review" : "";
}

export async function createPurchase(fd: FormData): Promise<PurchaseSubmitResult> {
  let profileForLog: Awaited<ReturnType<typeof getCurrentProfile>> = null;
  let linesForLog: PurchaseLineInput[] = [];
  let supplierIdForLog: string | null = null;
  let purchaseDateForLog = "";
  let receiptStatusForLog: Record<string, unknown> | undefined;
  try {
    const { profile, supabase } = await requirePurchaseAccess();
    profileForLog = profile;
    const clientSubmissionId = clean(fd.get("client_submission_id"));
    if (!PURCHASE_SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
      formError("Could not prepare a safe purchase submission. Reload this page and try again.");
    }
    let lines = parseLines(fd.get("lines_json"));
    linesForLog = lines;
    if (!lines.length) formError("Add at least one purchased item.");

    const supplierId = String(fd.get("supplier_id") || "") || null;
    supplierIdForLog = supplierId;
    purchaseDateForLog = String(fd.get("purchase_date") || new Date().toISOString().slice(0, 10));
    const submitAction = String(fd.get("submit_action") || "draft");
    const receivingStorageLocationId = clean(fd.get("receiving_storage_location_id"));
    if (submitAction === "received" && !supplierId) {
      formError("Choose a supplier before receiving stock.");
    }
    if (submitAction === "received" && !receivingStorageLocationId) {
      formError("Choose the storage location that will receive this purchase.");
    }
    if (receivingStorageLocationId && !PURCHASE_SUBMISSION_ID_PATTERN.test(receivingStorageLocationId)) {
      formError("The selected receiving storage location is invalid. Reload this page and choose it again.");
    }
    const paymentAccountId = parsePaymentAccountId(fd.get("payment_account_id"));
    const paymentStatus = parsePaymentStatus(fd.get("payment_status") ?? "unpaid");
    if (paymentStatus !== "unpaid") {
      formError("Save the purchase as unpaid, then record the actual supplier payment from its purchase page.");
    }
    lines = resolvePurchaseLines(lines);
    lines = await applySavedProductCostMemory(supabase, lines);
    linesForLog = lines;
    if (!lines.length) formError("Add at least one purchased item.");

    const { receiptUrl, receiptFileName, receiptContentType, receiptStoragePath, uploadUnavailable, uploadError } = await resolvePurchaseReceiptUrl(supabase, fd);
    receiptStatusForLog = {
      has_receipt_file: fd.get("receipt_file") instanceof File && (fd.get("receipt_file") as File).size > 0,
      receipt_url_saved: Boolean(receiptUrl),
      receipt_file_name: receiptFileName,
      receipt_content_type: receiptContentType,
      receipt_storage_path: receiptStoragePath,
      upload_unavailable: uploadUnavailable,
      upload_error: uploadError ?? null,
    };
    const lineRows = buildLineRows(lines);
    const totals = buildTotals(fd, lineRows.reduce((sum, line) => sum + Number(line.line_total), 0));

    const rpcPayload = {
      p_client_submission_id: clientSubmissionId,
      p_supplier_id: supplierId,
      p_order_date: purchaseDateForLog,
      p_receipt_number: String(fd.get("receipt_number") || "").trim() || null,
      p_payment_method: String(fd.get("payment_method") || "cash"),
      p_payment_status: paymentStatus,
      p_receipt_url: receiptUrl,
      p_receipt_file_name: receiptFileName,
      p_receipt_content_type: receiptContentType,
      p_receipt_storage_path: receiptStoragePath,
      p_notes: String(fd.get("notes") || "").trim() || null,
      p_calculated_total_lyd: totals.calculated_total_lyd,
      p_manual_total_lyd: totals.manual_total_lyd,
      p_total_adjustment_lyd: totals.total_adjustment_lyd,
      p_total_source: totals.total_source,
      p_total_amount: totals.total_amount,
      p_payment_account_id: paymentAccountId,
      p_receiving_storage_location_id: receivingStorageLocationId || null,
      p_submit_action: submitAction === "received" ? "received" : "draft",
      p_lines: lineRows,
    };

    const { data: purchaseRows, error: purchaseError } = await supabase.rpc(PURCHASE_CREATE_RPC, rpcPayload);

    const purchase = Array.isArray(purchaseRows) ? purchaseRows[0] : purchaseRows;
    if (purchaseError || !purchase) {
      logPurchaseSaveFailure({
        step: "purchase_rpc_transaction",
        error: purchaseError ?? new Error("Purchase RPC returned no purchase row."),
        profile,
        purchaseDate: purchaseDateForLog,
        supplierId,
        lines,
        receiptStatus: receiptStatusForLog,
        rpcName: PURCHASE_CREATE_RPC,
        payloadKeys: Object.keys(rpcPayload),
      });
      formError(PURCHASE_SAVE_ADMIN_MESSAGE);
    }

    await saveApprovedReceiptAliases(supabase, profile, lines);
    await linkReceiptScanResult(supabase, String(fd.get("receipt_scan_result_id") || ""), purchase.id);

    await logActivity({
      profile,
      action: "create",
      entityType: "purchase",
      entityId: purchase.id,
      entityLabel: String(fd.get("receipt_number") || purchase.id.slice(0, 8)),
      afterData: {
        ...purchase,
        receipt_url: receiptUrl,
        receipt_file_name: receiptFileName,
        line_count: lineRows.length,
        total_amount: Number(purchase.total_amount ?? totals.total_amount),
      },
      summary: `Created purchase with ${lineRows.length} line items`,
    });

    revalidatePath("/purchases");
    revalidatePath("/inventory");
    const receiptUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
    const params = new URLSearchParams({ purchaseSaved: submitAction === "received" ? "received" : "draft" });
    if (receiptUpload) params.set("receiptUpload", receiptUpload);
    return {
      ok: true,
      message: submitAction === "received" ? "Purchase received and inventory updated." : "Purchase saved as draft.",
      redirectTo: `/purchases/${purchase.id}?${params.toString()}`,
    };
  } catch (error) {
    if (!(error instanceof PurchaseFormError)) {
      logPurchaseSaveFailure({
        step: "unexpected_create_purchase",
        error,
        profile: profileForLog,
        purchaseDate: purchaseDateForLog,
        supplierId: supplierIdForLog,
        lines: linesForLog,
        receiptStatus: receiptStatusForLog,
      });
    }
    return purchaseSubmitError(error, PURCHASE_SAVE_ADMIN_MESSAGE);
  }
}

export async function updatePurchase(fd: FormData): Promise<PurchaseSubmitResult> {
  try {
    const { profile, supabase } = await requirePurchaseAccess();
    const id = String(fd.get("id") || "");
    if (!id) formError("Purchase id is missing.");
    const clientSubmissionId = clean(fd.get("client_submission_id"));
    if (!PURCHASE_SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
      formError("Could not prepare a safe draft update. Reload this page and try again.");
    }
    const expectedUpdatedAt = clean(fd.get("expected_updated_at"));
    if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      formError("The draft revision is missing. Reload this page before saving.");
    }

    const { data: current, error: currentError } = await supabase
      .from("purchase_orders")
      .select("*")
      .eq("id", id)
      .single();
    if (currentError || !current) formError("Purchase not found.");
    if (current.status !== "draft") formError("Only draft purchases can be edited.");

    let lines = parseLines(fd.get("lines_json"));
    if (!lines.length) formError("Add at least one purchased item.");

    const supplierId = String(fd.get("supplier_id") || "") || null;
    const submitAction = String(fd.get("submit_action") || "draft");
    const receivingStorageLocationId = clean(fd.get("receiving_storage_location_id"));
    if (submitAction === "received" && !supplierId) {
      formError("Choose a supplier before receiving stock.");
    }
    if (submitAction === "received" && !receivingStorageLocationId) {
      formError("Choose the storage location that will receive this purchase.");
    }
    if (receivingStorageLocationId && !PURCHASE_SUBMISSION_ID_PATTERN.test(receivingStorageLocationId)) {
      formError("The selected receiving storage location is invalid. Reload this page and choose it again.");
    }
    lines = resolvePurchaseLines(lines);
    lines = await applySavedProductCostMemory(supabase, lines);
    if (!lines.length) formError("Add at least one purchased item.");

    const { receiptUrl, receiptFileName, receiptContentType, receiptStoragePath, uploadUnavailable, uploadError } = await resolvePurchaseReceiptUrl(supabase, fd);
    const existingReceiptUrl = String(fd.get("current_receipt_url") || current.receipt_url || "").trim();
    const existingReceiptFileName = String(fd.get("current_receipt_file_name") || current.receipt_file_name || "").trim() || null;
    const existingReceiptContentType = String(fd.get("current_receipt_content_type") || current.receipt_content_type || "").trim() || null;
    const existingReceiptStoragePath = String(fd.get("current_receipt_storage_path") || current.receipt_storage_path || "").trim() || null;
    const removeReceipt = String(fd.get("remove_receipt") || "") === "yes";
    const hasNewStoredReceipt = Boolean(receiptStoragePath);
    const hasNewManualReceiptUrl = Boolean(receiptUrl && !hasNewStoredReceipt && receiptUrl !== existingReceiptUrl);
    const nextReceiptUrl = removeReceipt
      ? null
      : hasNewStoredReceipt || hasNewManualReceiptUrl
        ? receiptUrl
        : existingReceiptUrl || current.receipt_url || null;
    const nextReceiptFileName = removeReceipt ? null : hasNewStoredReceipt ? receiptFileName : hasNewManualReceiptUrl ? null : existingReceiptFileName;
    const nextReceiptContentType = removeReceipt ? null : hasNewStoredReceipt ? receiptContentType : hasNewManualReceiptUrl ? null : existingReceiptContentType;
    const nextReceiptStoragePath = removeReceipt ? null : hasNewStoredReceipt ? receiptStoragePath : hasNewManualReceiptUrl ? null : existingReceiptStoragePath;
    const lineRows = buildLineRows(lines);
    const totals = buildTotals(fd, lineRows.reduce((sum, line) => sum + Number(line.line_total), 0));
    const nextOrderDate = String(fd.get("purchase_date") || new Date().toISOString().slice(0, 10));
    const nextReceiptNumber = String(fd.get("receipt_number") || "").trim() || null;
    const nextPaymentMethod = String(fd.get("payment_method") || "cash");
    const nextNotes = String(fd.get("notes") || "").trim() || null;

    const { data: updateData, error: updateError } = await supabase.rpc("snacky_update_draft_purchase_v1", {
      p_purchase_id: id,
      p_client_submission_id: clientSubmissionId,
      p_expected_updated_at: expectedUpdatedAt,
      p_supplier_id: supplierId,
      p_order_date: nextOrderDate,
      p_receiving_storage_location_id: receivingStorageLocationId || null,
      p_receipt_number: nextReceiptNumber,
      p_payment_method: nextPaymentMethod,
      p_receipt_url: nextReceiptUrl,
      p_receipt_file_name: nextReceiptFileName,
      p_receipt_content_type: nextReceiptContentType,
      p_receipt_storage_path: nextReceiptStoragePath,
      p_notes: nextNotes,
      p_manual_total_lyd: totals.manual_total_lyd,
      p_lines: lineRows,
    });
    if (updateError || !updateData) {
      console.error("[purchases] Atomic draft update failed; no purchase line was changed", updateError);
      const code = String(updateError?.code ?? "");
      if (code === "PGRST202" || code === "42883") {
        formError("The atomic draft update is not active yet. No purchase item was changed.");
      }
      formError(updateError?.message || "Could not update purchase. No purchase item was changed.");
    }

    const updateResult = updateData && typeof updateData === "object" && !Array.isArray(updateData)
      ? (updateData as Record<string, unknown>)
      : {};
    const updatedPurchase = updateResult.purchase && typeof updateResult.purchase === "object" && !Array.isArray(updateResult.purchase)
      ? (updateResult.purchase as Record<string, unknown>)
      : { id, status: "draft" };

    await saveApprovedReceiptAliases(supabase, profile, lines);
    await linkReceiptScanResult(supabase, String(fd.get("receipt_scan_result_id") || ""), id);

    await logActivity({
      profile,
      idempotencyKey: `purchase-draft-update:v1:${clientSubmissionId}`,
      action: current.receipt_url !== nextReceiptUrl ? "update_receipt" : "update",
      entityType: "purchase",
      entityId: id,
      entityLabel: String(fd.get("receipt_number") || id.slice(0, 8)),
      beforeData: current,
      afterData: { ...updatedPurchase, line_count: Number(updateResult.line_count ?? lineRows.length) },
      summary: current.receipt_url !== nextReceiptUrl ? "Updated purchase receipt attachment" : "Updated draft purchase",
    });

    let financeWarning = "";
    let financeManualReview = false;

    if (submitAction === "received") {
      try {
        const receiveResult = await receivePurchaseById(
          id,
          receivingStorageLocationId,
          `${clientSubmissionId}:receive`,
        );
        financeManualReview = receiveResult.financeWarning;
        if (receiveResult.financeWarning) financeWarning = " Finance records need review.";
      } catch (receiveError) {
        const receiveMessage = receiveError instanceof Error ? receiveError.message : "Could not receive stock.";
        formError(`Draft changes were saved, but inventory was not received: ${receiveMessage}`);
      }
    }

    revalidatePath("/purchases");
    revalidatePath(`/purchases/${id}`);
    revalidatePath(`/purchases/${id}/edit`);
    revalidatePath("/inventory");
    const receiptUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
    const params = new URLSearchParams({ purchaseSaved: submitAction === "received" ? "received" : "draft" });
    if (receiptUpload) params.set("receiptUpload", receiptUpload);
    if (financeManualReview) params.set("financeWarning", financeWarningParam(financeManualReview));
    return {
      ok: true,
      message: submitAction === "received" ? `Purchase received and inventory updated.${financeWarning}` : `Purchase saved as draft.${financeWarning}`,
      redirectTo: `/purchases/${id}?${params.toString()}`,
    };
  } catch (error) {
    return purchaseSubmitError(error, "Could not update purchase.");
  }
}

async function receivePurchaseById(
  id: string,
  receivingStorageLocationId: string,
  clientSubmissionId: string,
): Promise<PurchaseReceiveResult> {
  const { profile, supabase } = await requirePurchaseAccess();
  if (!PURCHASE_SUBMISSION_ID_PATTERN.test(receivingStorageLocationId)) {
    throw new Error("Choose a valid storage location before receiving stock.");
  }
  if (!clientSubmissionId || clientSubmissionId.length > 200) {
    throw new Error("The purchase receipt submission id is invalid. Reload and try again.");
  }
  const { data, error } = await supabase.rpc("snacky_receive_purchase_v1", {
    p_purchase_id: id,
    p_client_submission_id: clientSubmissionId,
    p_receiving_storage_location_id: receivingStorageLocationId,
  });
  if (error) {
    const code = String(error.code ?? "");
    if (code === "PGRST202" || code === "42883") {
      throw new Error("The atomic purchase receipt database update is not active yet. No inventory was changed.");
    }
    throw new Error(error.message || "Could not receive purchase. No inventory was changed.");
  }

  const result = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const purchase = result.purchase && typeof result.purchase === "object" && !Array.isArray(result.purchase)
    ? (result.purchase as Record<string, unknown>)
    : { id, status: result.status ?? "received" };
  const inventory = result.inventory && typeof result.inventory === "object" && !Array.isArray(result.inventory)
    ? (result.inventory as Record<string, unknown>)
    : {};
  const movementCount = Math.max(0, Number(inventory.receipt_movement_count ?? 0) || 0);
  const invalidReceipt = purchase.id !== id || purchase.status !== "received" || movementCount <= 0;

  if (invalidReceipt) {
    console.error("[purchases] Atomic purchase receipt returned an incomplete result; inventory may already be committed and needs review", {
      purchase_id: id,
      result,
    });
  }

  await logActivity({
    profile,
    idempotencyKey: `purchase-receive:v1:${clientSubmissionId}`,
    action: invalidReceipt ? "purchase_inventory_result_needs_review" : "receive_purchase",
    entityType: "purchase",
    entityId: id,
    entityLabel: id.slice(0, 8),
    afterData: {
      movement_count: movementCount,
      status: "received",
      payment_status: purchase.payment_status,
      already_applied: Boolean(result.already_applied),
      legacy_verified: Boolean(result.legacy_verified),
      result_review_required: invalidReceipt,
    },
    summary: invalidReceipt
      ? "Purchase inventory was received atomically; the returned result needs review"
      : `Received purchase into storage (${movementCount} inventory movements)`,
  });

  // Supplier payments own the finance ledger. Receiving stock must never invent
  // an aggregate cash-out before an actual purchase payment is recorded.
  return { financeWarning: false };
}

export async function receivePurchase(fd: FormData) {
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  try {
    const receivingStorageLocationId = clean(fd.get("receiving_storage_location_id"));
    const clientSubmissionId = clean(fd.get("client_submission_id"));
    const result = await receivePurchaseById(id, receivingStorageLocationId, clientSubmissionId);
    const params = new URLSearchParams({ purchaseReceived: clientSubmissionId });
    if (result.financeWarning) params.set("financeWarning", financeWarningParam(result.financeWarning));
    const suffix = params.toString();
    revalidatePath("/purchases");
    revalidatePath(`/purchases/${id}`);
    revalidatePath("/inventory");
    redirect(`/purchases/${id}${suffix ? `?${suffix}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not receive purchase.";
    redirect(`/purchases/${id}?error=${encodeURIComponent(message)}`);
  }
}

export async function recordPurchasePayment(fd: FormData) {
  const { profile, supabase } = await requirePurchasePaymentAccess();
  const id = clean(fd.get("purchase_order_id") ?? fd.get("id"));
  if (!id) redirect("/purchases");

  const moduleName = clean(fd.get("module"));
  const path = `/purchases/${id}`;
  const amount = roundMoney(Number(clean(fd.get("amount"))));
  const paidAt = parseSupplierPaymentTimestamp(fd.get("paid_at"));
  const paymentMethod = clean(fd.get("payment_method")) || "cash";
  const requestedAccountId = clean(fd.get("account_id"));
  if (requestedAccountId && !["snacky_lyd", "owner_lyd"].includes(requestedAccountId)) {
    fail(path, "Supplier payments are recorded in LYD. Choose Snacky LYD or Owner LYD.");
  }
  const accountId = requestedAccountId || "snacky_lyd";
  const reference = clean(fd.get("reference")) || null;
  const note = clean(fd.get("note")) || null;
  const clientSubmissionId = clean(fd.get("client_submission_id"));

  if (!Number.isFinite(amount) || amount <= 0) fail(path, "Payment amount must be greater than zero.");
  if (!paidAt) fail(path, "Payment date is invalid.");
  if (!PURCHASE_SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
    fail(path, "Could not prepare a safe supplier payment. Reload this page and try again.");
  }

  const { data: payment, error } = await supabase.rpc("record_purchase_payment", {
    p_purchase_order_id: id,
    p_amount: amount,
    p_paid_at: paidAt,
    p_payment_method: paymentMethod,
    p_account_id: accountId,
    p_reference: reference,
    p_note: note,
    p_client_submission_id: clientSubmissionId,
  });

  if (error || !payment) {
    console.error("[purchases] Failed to record supplier payment", error);
    const message = error?.message?.includes("remaining supplier balance")
      ? "Payment is greater than the remaining supplier balance."
      : error?.message?.includes("received")
        ? "Only a received, non-void purchase can be paid."
        : "Could not record the supplier payment. No payment was saved.";
    fail(path, message);
  }

  await logActivity({
    profile,
    idempotencyKey: `purchase-payment-record:v2:${clientSubmissionId}`,
    action: "record_purchase_payment",
    entityType: "purchase",
    entityId: id,
    entityLabel: id.slice(0, 8),
    afterData: payment,
    metadata: { amount, payment_method: paymentMethod, account_id: accountId },
    summary: `Recorded supplier payment of ${amount.toFixed(2)} LYD`,
  });

  revalidatePath("/purchases");
  revalidatePath(path);
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  const query = new URLSearchParams({ paymentRecorded: clientSubmissionId });
  if (moduleName === "finance") query.set("module", "finance");
  redirect(`${path}?${query.toString()}`);
}

export async function voidPurchasePayment(fd: FormData) {
  const { profile, supabase } = await requirePurchasePaymentAccess();
  const purchaseId = clean(fd.get("purchase_order_id") ?? fd.get("id"));
  if (!purchaseId) redirect("/purchases");
  const path = `/purchases/${purchaseId}`;
  const paymentId = clean(fd.get("purchase_payment_id"));
  if (!PURCHASE_SUBMISSION_ID_PATTERN.test(paymentId)) {
    fail(path, "The supplier payment is invalid. Reload this purchase and try again.");
  }
  const reason = requireConfirmedReason(fd, path);
  const clientSubmissionId = clean(fd.get("client_submission_id"));
  if (!PURCHASE_SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
    fail(path, "Could not prepare a safe payment correction. Reload this page and try again.");
  }

  const { data, error } = await supabase.rpc("snacky_void_purchase_payment_v1", {
    p_purchase_payment_id: paymentId,
    p_reason: reason,
    p_client_submission_id: clientSubmissionId,
  });
  if (error || !data) {
    console.error("[purchases] Atomic supplier payment void failed; payment and finance remain unchanged", error);
    const code = String(error?.code ?? "");
    if (code === "PGRST202" || code === "42883") {
      fail(path, "The atomic supplier payment correction is not active yet. Nothing was changed.");
    }
    fail(path, error?.message || "Could not void the supplier payment. Nothing was changed.");
  }

  const result = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  const resultPurchaseId = String(result.purchase_order_id ?? "");
  const resultPaymentId = String(result.payment_id ?? "");
  if (resultPurchaseId !== purchaseId || resultPaymentId !== paymentId) {
    console.error("[purchases] Atomic supplier payment void returned a mismatched result", {
      expected_purchase_id: purchaseId,
      expected_payment_id: paymentId,
      result,
    });
    fail(path, "The payment correction completed with an unexpected result. Reload before taking another action.");
  }

  await logActivity({
    profile,
    idempotencyKey: `purchase-payment-void:v1:${clientSubmissionId}`,
    action: "void_purchase_payment",
    entityType: "purchase",
    entityId: purchaseId,
    entityLabel: purchaseId.slice(0, 8),
    afterData: result,
    metadata: {
      purchase_payment_id: paymentId,
      reason,
      client_submission_id: clientSubmissionId,
      already_applied: Boolean(result.already_applied),
    },
    summary: "Voided supplier payment and its finance entry atomically",
  });

  revalidatePath("/purchases");
  revalidatePath(path);
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  const query = new URLSearchParams({ paymentVoided: clientSubmissionId });
  if (clean(fd.get("module")) === "finance") query.set("module", "finance");
  redirect(`${path}?${query.toString()}`);
}

export async function cancelPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const path = `/purchases/${id}`;
  const reason = requireConfirmedReason(fd, path);
  const clientSubmissionId = clean(fd.get("client_submission_id"));
  if (!PURCHASE_SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
    fail(path, "Could not prepare a safe cancellation. Reload this page and try again.");
  }

  const { data, error } = await supabase.rpc("snacky_cancel_draft_purchase_v1", {
    p_purchase_id: id,
    p_reason: reason,
    p_client_submission_id: clientSubmissionId,
  });
  if (error || !data) {
    console.error("[purchases] Atomic draft cancellation failed; purchase remains unchanged", error);
    const code = String(error?.code ?? "");
    if (code === "PGRST202" || code === "42883") {
      fail(path, "The atomic purchase cancellation is not active yet. Nothing was changed.");
    }
    fail(path, error?.message || "Could not cancel purchase. Nothing was changed.");
  }

  const result = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const after = result.purchase && typeof result.purchase === "object" && !Array.isArray(result.purchase)
    ? (result.purchase as Record<string, unknown>)
    : { id, status: "cancelled", void_reason: reason };
  await logActivity({
    profile,
    idempotencyKey: `purchase-draft-cancel:v1:${clientSubmissionId}`,
    action: "cancel",
    entityType: "purchase",
    entityId: id,
    entityLabel: id.slice(0, 8),
    afterData: after,
    metadata: { reason, client_submission_id: clientSubmissionId },
    summary: "Cancelled purchase",
  });
  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  redirect(`/purchases/${id}?purchaseCancelled=${encodeURIComponent(clientSubmissionId)}`);
}

export async function voidReceivedPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const path = `/purchases/${id}`;
  const reason = requireConfirmedReason(fd, path);
  const clientSubmissionId = clean(fd.get("client_submission_id"));
  if (!PURCHASE_SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
    fail(path, "Could not prepare a safe void. Reload this page and try again.");
  }

  const { data, error } = await supabase.rpc("snacky_void_received_purchase_v1", {
    p_purchase_id: id,
    p_reason: reason,
    p_client_submission_id: clientSubmissionId,
  });
  if (error) {
    const code = String(error.code ?? "");
    if (code === "PGRST202" || code === "42883") {
      fail(path, "The atomic purchase void database update is not active yet. No inventory was changed.");
    }
    fail(path, error.message || "Could not void purchase. No inventory was changed.");
  }

  const result = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const purchase = result.purchase && typeof result.purchase === "object" && !Array.isArray(result.purchase)
    ? (result.purchase as Record<string, unknown>)
    : { id, status: result.status ?? "voided", void_reason: reason };
  const inventory = result.inventory && typeof result.inventory === "object" && !Array.isArray(result.inventory)
    ? (result.inventory as Record<string, unknown>)
    : {};
  const reversalCount = Math.max(0, Number(inventory.reversal_movement_count ?? 0) || 0);
  const purchaseTotal = Number(purchase.manual_total_lyd ?? purchase.total_amount ?? purchase.calculated_total_lyd ?? 0);
  let financeWarning = purchase.id !== id || purchase.status !== "voided" || reversalCount <= 0;
  let financeBefore: LinkedFinanceRow[] = [];

  if (financeWarning) {
    console.error("[purchases] Atomic purchase void returned an incomplete result; inventory may already be committed and needs review", {
      purchase_id: id,
      result,
    });
  }

  try {
    const { data: linkedFinance, error: financeReadError } = await supabase
      .from("financial_transactions")
      .select("*")
      .eq("transaction_kind", "product_purchase")
      .eq("transaction_status", "active")
      .or(purchaseFinanceLinkFilter(id));
    if (financeReadError) throw financeReadError;
    financeBefore = (linkedFinance ?? []) as LinkedFinanceRow[];

    if (financeBefore.length) {
      throw new Error(`${financeBefore.length} active linked finance transaction(s) remained after the atomic purchase void.`);
    }
  } catch (financeError) {
    financeWarning = true;
    console.error("[purchases] Purchase inventory void succeeded, but linked finance state needs repair", {
      purchase_id: id,
      amount_lyd: purchaseTotal,
      error: financeError,
    });
  }

  await logActivity({
    profile,
    idempotencyKey: `purchase-inventory-void:v1:${clientSubmissionId}`,
    action: financeWarning ? "finance_sync_needs_repair" : "void",
    entityType: "purchase",
    entityId: id,
    entityLabel: String(purchase.receipt_number ?? id.slice(0, 8)),
    afterData: purchase,
    metadata: {
      reason,
      reversal_movement_count: reversalCount,
      financial_transaction_count: financeBefore.length,
      already_applied: Boolean(result.already_applied),
      legacy_verified: Boolean(result.legacy_verified),
      finance_repair_required: financeWarning,
    },
    summary: financeWarning
      ? "Purchase inventory was voided atomically; finance/result follow-up needs review"
      : `Voided received purchase and verified ${reversalCount} reversal movements`,
  });

  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  revalidatePath("/inventory");
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  const params = new URLSearchParams();
  params.set("purchaseVoided", clientSubmissionId);
  if (financeWarning) params.set("financeWarning", financeWarningParam(financeWarning));
  const suffix = params.toString();
  redirect(`/purchases/${id}${suffix ? `?${suffix}` : ""}`);
}
