"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAddProducts, canManagePurchases } from "@/lib/authz";
import { createPurchaseFinancialTransaction } from "@/lib/finance-actions";
import { resolveProductSku } from "@/lib/product-sku";
import { resolvePurchaseReceiptUrl } from "@/lib/purchase-receipts";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type PurchaseLineInput = {
  productId: string;
  boxesQty: number;
  unitsPerBox: number;
  looseUnitsQty: number;
  unitCost: number;
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

class PurchaseFormError extends Error {}

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
        const matchAction = parseLineAction(line.matchAction);
        return {
          productId: String(line.productId || ""),
          boxesQty: Math.max(0, Math.floor(Number(line.boxesQty || 0))),
          unitsPerBox: Math.max(1, Math.floor(Number(line.unitsPerBox || 1))),
          looseUnitsQty: Math.max(0, Math.floor(Number(line.looseUnitsQty || 0))),
          unitCost: Math.max(0, Number(line.unitCost || 0)),
          lineTotal: Math.max(0, Number(line.lineTotal || 0)),
          pricingMode: line.pricingMode === "total" ? "total" : "unit",
          receiptLineName: cleanOptionalString(line.receiptLineName),
          matchAction,
          matchConfidence: line.matchConfidence === null || line.matchConfidence === undefined ? null : Math.max(0, Math.min(1, Number(line.matchConfidence || 0))),
          newProduct: parseNewProduct(line.newProduct),
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

function sanitizeSku(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function receiptSkuFallback(index: number) {
  return `RCPT-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
}

async function uniqueSku(supabase: SupabaseServer, preferredSku: string, fallbackName: string, index: number) {
  const base = sanitizeSku(preferredSku) || sanitizeSku(fallbackName).slice(0, 32) || receiptSkuFallback(index);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } = await supabase.from("products").select("id").eq("sku", candidate).maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

async function resolvePurchaseLines({
  supabase,
  profile,
  lines,
  supplierId,
}: {
  supabase: SupabaseServer;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  lines: PurchaseLineInput[];
  supplierId: string | null;
}) {
  const resolvedLines: PurchaseLineInput[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.matchAction !== "create") {
      resolvedLines.push(line);
      continue;
    }

    const productName = line.newProduct?.name || line.receiptLineName || "";
    if (!productName.trim()) formError("Product name is required for receipt-created products.");
    if (!canAddProducts(profile)) formError("You do not have permission to create products from receipt lines.");

    let sku = "";
    try {
      sku = await resolveProductSku({ supabase, manualSku: line.newProduct?.sku });
    } catch (error) {
      console.error("[purchases] Failed to generate product SKU for receipt line", error);
      formError(error instanceof Error ? error.message : "Could not create product from receipt line.");
    }

    const unitCost = roundUnitCost(line.unitCost || (line.lineTotal > 0 && line.looseUnitsQty > 0 ? line.lineTotal / line.looseUnitsQty : 0));
    const { data: product, error } = await supabase
      .from("products")
      .insert({
        sku,
        barcode: line.newProduct?.barcode ?? null,
        name: productName.trim(),
        category: line.newProduct?.category || "snack",
        brand: line.newProduct?.brand ?? null,
        supplier_id: supplierId,
        cost_price: unitCost,
        selling_price: 0,
        current_cost_price_lyd: unitCost,
        last_purchase_cost_lyd: unitCost,
        cost_price_source: unitCost > 0 ? "latest_purchase" : "manual",
        import_source: "receipt_scan",
        price_updated_at: new Date().toISOString(),
        case_quantity: line.newProduct?.caseQuantity ?? Math.max(1, line.unitsPerBox),
        active: true,
      })
      .select("id, sku, name, category, brand, active")
      .single();

    if (error || !product) {
      console.error("[purchases] Failed to create receipt product", error);
      formError("Could not create product from receipt line.");
    }

    if (profile) {
      await logActivity({
        profile,
        action: "create",
        entityType: "product",
        entityId: product.id,
        entityLabel: product.name,
        afterData: product,
        summary: `Created product ${product.name} from receipt review`,
      });
    }

    resolvedLines.push({ ...line, productId: product.id });
  }

  return resolvedLines.filter((line) => line.productId);
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
}: {
  step: string;
  error: unknown;
  profile: Awaited<ReturnType<typeof getCurrentProfile>>;
  purchaseDate: string;
  supplierId: string | null;
  lines: PurchaseLineInput[];
  receiptStatus?: Record<string, unknown>;
}) {
  console.error("[purchases] Purchase save failed", {
    failed_step: step,
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

async function getDefaultStorageId(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const { data: mainStorage, error: mainStorageError } = await supabase
    .from("storage_locations")
    .select("id")
    .eq("active", true)
    .eq("location_type", "main_storage")
    .order("name")
    .limit(1)
    .maybeSingle();
  if (mainStorageError) throw mainStorageError;
  if (mainStorage?.id) return mainStorage.id;

  const { data: storage, error } = await supabase
    .from("storage_locations")
    .select("id")
    .eq("active", true)
    .in("location_type", ["vehicle", "temporary", "other"])
    .order("name")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return storage?.id ?? null;
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
    let lines = parseLines(fd.get("lines_json"));
    linesForLog = lines;
    if (!lines.length) formError("Add at least one purchased item.");

    const supplierId = String(fd.get("supplier_id") || "") || null;
    supplierIdForLog = supplierId;
    purchaseDateForLog = String(fd.get("purchase_date") || new Date().toISOString().slice(0, 10));
    lines = await resolvePurchaseLines({ supabase, profile, lines, supplierId });
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
    const submitAction = String(fd.get("submit_action") || "draft");

    const { data: purchaseRows, error: purchaseError } = await supabase.rpc("snacky_create_purchase_with_lines", {
      p_supplier_id: supplierId,
      p_order_date: purchaseDateForLog,
      p_receipt_number: String(fd.get("receipt_number") || "").trim() || null,
      p_payment_method: String(fd.get("payment_method") || "cash"),
      p_payment_status: parsePaymentStatus(fd.get("payment_status")),
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
      p_created_by: profile.team_member_id,
      p_submit_action: submitAction === "received" ? "received" : "draft",
      p_lines: lineRows,
    });

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
      });
      formError(
        purchaseError?.code === "42501"
          ? "Permission denied while saving this purchase."
          : purchaseError?.message || "Could not save purchase transaction.",
      );
    }

    await saveApprovedReceiptAliases(supabase, profile, lines);
    await linkReceiptScanResult(supabase, String(fd.get("receipt_scan_result_id") || ""), purchase.id);

    await logActivity({
      profile,
      action: "create",
      entityType: "purchase",
      entityId: purchase.id,
      entityLabel: String(fd.get("receipt_number") || purchase.id.slice(0, 8)),
      afterData: { ...purchase, receipt_url: receiptUrl, receipt_file_name: receiptFileName, line_count: lineRows.length, total_amount: totals.total_amount },
      summary: `Created purchase with ${lineRows.length} line items`,
    });

    let financeWarning = "";
    if (submitAction === "received" && purchase.payment_status === "paid") {
      try {
        await createPurchaseFinancialTransaction(supabase, profile, {
          ...purchase,
          supplier_id: supplierId,
          order_date: purchaseDateForLog,
          received_date: new Date().toISOString().slice(0, 10),
          receipt_url: receiptUrl,
          payment_method: String(fd.get("payment_method") || "cash"),
        }, Number(purchase.total_amount ?? totals.total_amount ?? 0));
      } catch (financeError) {
        financeWarning = " Finance transaction was not created; review finance manually.";
        logPurchaseSaveFailure({
          step: "finance_transaction",
          error: financeError,
          profile,
          purchaseDate: purchaseDateForLog,
          supplierId,
          lines,
          receiptStatus: receiptStatusForLog,
        });
      }
    }

    revalidatePath("/purchases");
    revalidatePath("/inventory");
    revalidatePath("/finance");
    const receiptUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
    const params = new URLSearchParams({ purchaseSaved: submitAction === "received" ? "received" : "draft" });
    if (receiptUpload) params.set("receiptUpload", receiptUpload);
    return {
      ok: true,
      message: submitAction === "received" ? `Purchase received and inventory updated.${financeWarning}` : "Purchase saved as draft.",
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
    return purchaseSubmitError(error, "Could not save purchase.");
  }
}

export async function updatePurchase(fd: FormData): Promise<PurchaseSubmitResult> {
  try {
    const { profile, supabase } = await requirePurchaseAccess();
    const id = String(fd.get("id") || "");
    if (!id) formError("Purchase id is missing.");

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
    lines = await resolvePurchaseLines({ supabase, profile, lines, supplierId });
    if (!lines.length) formError("Add at least one purchased item.");

    const { receiptUrl, receiptFileName, receiptContentType, receiptStoragePath, uploadUnavailable, uploadError } = await resolvePurchaseReceiptUrl(supabase, fd);
    const existingReceiptUrl = String(fd.get("current_receipt_url") || current.receipt_url || "").trim();
    const removeReceipt = String(fd.get("remove_receipt") || "") === "yes";
    const nextReceiptUrl = removeReceipt ? null : (receiptUrl ?? existingReceiptUrl) || null;
    const receiptUrlChanged = Boolean(receiptUrl && receiptUrl !== existingReceiptUrl);
    const nextReceiptFileName = removeReceipt ? null : receiptFileName ?? (receiptUrlChanged ? null : current.receipt_file_name ?? null);
    const nextReceiptContentType = removeReceipt ? null : receiptContentType ?? (receiptUrlChanged ? null : current.receipt_content_type ?? null);
    const nextReceiptStoragePath = removeReceipt ? null : receiptStoragePath ?? (receiptUrlChanged ? null : current.receipt_storage_path ?? null);
    const lineRows = buildLineRows(lines);
    const totals = buildTotals(fd, lineRows.reduce((sum, line) => sum + Number(line.line_total), 0));
    const submitAction = String(fd.get("submit_action") || "draft");

    const { error: updateError } = await supabase
      .from("purchase_orders")
      .update({
        supplier_id: supplierId,
        order_date: String(fd.get("purchase_date") || new Date().toISOString().slice(0, 10)),
        receipt_number: String(fd.get("receipt_number") || "").trim() || null,
        payment_method: String(fd.get("payment_method") || "cash"),
        payment_status: parsePaymentStatus(fd.get("payment_status")),
        receipt_url: nextReceiptUrl,
        receipt_file_name: nextReceiptFileName,
        receipt_content_type: nextReceiptContentType,
        receipt_storage_path: nextReceiptStoragePath,
        notes: String(fd.get("notes") || "").trim() || null,
        ...totals,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "draft");
    if (updateError) {
      console.error("[purchases] Failed to update purchase", updateError);
      formError("Could not update purchase.");
    }

    const { error: deleteError } = await supabase.from("purchase_order_lines").delete().eq("purchase_order_id", id);
    if (deleteError) {
      console.error("[purchases] Failed to replace purchase lines", deleteError);
      formError("Could not update purchase items.");
    }

    const { error: linesError } = await supabase.from("purchase_order_lines").insert(lineRows.map((line) => ({ ...line, purchase_order_id: id })));
    if (linesError) {
      console.error("[purchases] Failed to save purchase lines", linesError);
      formError("Could not save purchase items.");
    }

    await saveApprovedReceiptAliases(supabase, profile, lines);
    await linkReceiptScanResult(supabase, String(fd.get("receipt_scan_result_id") || ""), id);

    await logActivity({
      profile,
      action: current.receipt_url !== nextReceiptUrl ? "update_receipt" : "update",
      entityType: "purchase",
      entityId: id,
      entityLabel: String(fd.get("receipt_number") || id.slice(0, 8)),
      beforeData: current,
      afterData: { receipt_url: nextReceiptUrl, receipt_file_name: nextReceiptFileName, line_count: lineRows.length, ...totals },
      summary: current.receipt_url !== nextReceiptUrl ? "Updated purchase receipt attachment" : "Updated draft purchase",
    });

    if (submitAction === "received") {
      await receivePurchaseById(id);
    }

    revalidatePath("/purchases");
    revalidatePath(`/purchases/${id}`);
    revalidatePath(`/purchases/${id}/edit`);
    revalidatePath("/inventory");
    const receiptUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
    const params = new URLSearchParams({ purchaseSaved: submitAction === "received" ? "received" : "draft" });
    if (receiptUpload) params.set("receiptUpload", receiptUpload);
    return {
      ok: true,
      message: submitAction === "received" ? "Purchase received and inventory updated." : "Purchase saved as draft.",
      redirectTo: `/purchases/${id}?${params.toString()}`,
    };
  } catch (error) {
    return purchaseSubmitError(error, "Could not update purchase.");
  }
}

async function receivePurchaseById(id: string) {
  const { profile, supabase } = await requirePurchaseAccess();
  const { data: purchase, error: purchaseError } = await supabase.from("purchase_orders").select("*").eq("id", id).single();
  if (purchaseError || !purchase) throw new Error("Purchase not found.");
  const purchaseTotal = Number(purchase.manual_total_lyd ?? purchase.total_amount ?? purchase.calculated_total_lyd ?? 0);
  const receivedDate = new Date().toISOString().slice(0, 10);
  if (purchase.status === "received") {
    if (purchase.payment_status === "paid") {
      await createPurchaseFinancialTransaction(supabase, profile, { ...purchase, received_date: receivedDate }, purchaseTotal);
    }
    return;
  }
  if (purchase.status === "cancelled" || purchase.status === "voided") throw new Error("Cancelled or voided purchases cannot be received.");

  const { count: existingMovementCount, error: existingError } = await supabase
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("related_purchase_id", id)
    .eq("reason", "purchase_received");
  if (existingError) throw existingError;
  const hasExistingReceiptMovements = Number(existingMovementCount ?? 0) > 0;

  const { data: lines, error: linesError } = await supabase
    .from("purchase_order_lines")
    .select("id, line_position, product_id, total_units, unit_cost, line_total, unit_cost_lyd, line_total_lyd, created_at")
    .eq("purchase_order_id", id);
  if (!linesError && lines) {
    lines.sort((a: any, b: any) => Number(a.line_position ?? 0) - Number(b.line_position ?? 0) || String(a.id).localeCompare(String(b.id)));
  }
  if (linesError) throw linesError;
  const validLines = (lines ?? []).filter((line: any) => Number(line.total_units ?? 0) > 0);
  if (!validLines.length) throw new Error("Purchase has no receivable items.");

  let movementCount = Number(existingMovementCount ?? 0);
  if (!hasExistingReceiptMovements) {
    const storageId = await getDefaultStorageId(supabase);
    if (!storageId) throw new Error("No active storage location found.");

    const movements = validLines.map((line: any) => ({
      product_id: line.product_id,
      quantity: Number(line.total_units),
      from_entity_type: "supplier",
      from_entity_id: purchase.supplier_id,
      to_entity_type: "storage",
      to_entity_id: storageId,
      reason: "purchase_received",
      related_purchase_id: id,
      related_purchase_line_id: line.id,
      unit_cost_lyd: Number(line.unit_cost_lyd ?? line.unit_cost ?? 0),
      line_total_lyd: Number(line.line_total_lyd ?? line.line_total ?? 0),
      created_by: profile.team_member_id,
      notes: "Purchase received",
    }));

    const { error: movementError } = await supabase.from("inventory_movements").insert(movements);
    if (movementError) {
      if (movementError.code !== "23505") throw movementError;
    }
    movementCount = movements.length;
  }

  await supabase.from("purchase_order_lines").update({ received_qty: 0 }).eq("purchase_order_id", id);
  for (const line of validLines as any[]) {
    await supabase.from("purchase_order_lines").update({ received_qty: Number(line.total_units) }).eq("id", line.id);
    const latestCost = Number(line.unit_cost_lyd ?? line.unit_cost ?? 0);
    await supabase
      .from("products")
      .update({
        cost_price: latestCost,
        current_cost_price_lyd: latestCost,
        last_purchase_cost_lyd: latestCost,
        cost_price_source: "latest_purchase",
        price_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", line.product_id);
  }

  const { error: updateError } = await supabase
    .from("purchase_orders")
    .update({ status: "received", received_at: new Date().toISOString(), received_date: receivedDate, received_by: profile.team_member_id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "received");
  if (updateError) throw updateError;

  if (purchase.payment_status === "paid") {
    await createPurchaseFinancialTransaction(supabase, profile, { ...purchase, received_date: receivedDate }, purchaseTotal);
  }

  await logActivity({
    profile,
    action: "receive_purchase",
    entityType: "purchase",
    entityId: id,
    entityLabel: id.slice(0, 8),
    afterData: { movement_count: movementCount, status: "received", payment_status: purchase.payment_status },
    summary: `Received purchase into storage (${movementCount} inventory movements)`,
  });
}

export async function receivePurchase(fd: FormData) {
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  try {
    await receivePurchaseById(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not receive purchase.";
    redirect(`/purchases/${id}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  revalidatePath("/inventory");
  redirect(`/purchases/${id}`);
}

export async function markPurchasePaid(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const path = `/purchases/${id}`;
  const reason = requireConfirmedReason(fd, path);

  const { data: purchase, error: purchaseError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (purchaseError || !purchase) fail("/purchases", "Purchase not found.");
  if (purchase.status !== "received") fail(path, "Only received purchases can be marked paid.");
  if (purchase.payment_status === "voided" || purchase.status === "voided") fail(path, "Voided purchases cannot be paid.");

  const paidPurchase = {
    ...purchase,
    payment_status: "paid",
  };
  const purchaseTotal = Number(purchase.manual_total_lyd ?? purchase.total_amount ?? purchase.calculated_total_lyd ?? 0);

  const { data: after, error: updateError } = await supabase
    .from("purchase_orders")
    .update({ payment_status: "paid", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "received")
    .select("*")
    .single();
  if (updateError) {
    console.error("[purchases] Failed to mark purchase paid", updateError);
    fail(path, "Could not mark purchase as paid.");
  }

  try {
    await createPurchaseFinancialTransaction(supabase, profile, { ...paidPurchase, ...after }, purchaseTotal);
  } catch (error) {
    console.error("[purchases] Failed to create payment transaction", error);
    fail(path, "Purchase was marked paid, but the money-out finance transaction could not be created.");
  }

  await logActivity({
    profile,
    action: "pay_purchase",
    entityType: "purchase",
    entityId: id,
    entityLabel: purchase.receipt_number ?? id.slice(0, 8),
    beforeData: purchase,
    afterData: after,
    metadata: { reason, amount: purchaseTotal },
    summary: "Marked purchase paid and ensured money-out finance transaction",
  });

  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  redirect(`/purchases/${id}`);
}

export async function cancelPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const path = `/purchases/${id}`;
  const reason = requireConfirmedReason(fd, path);
  const { data: purchase } = await supabase.from("purchase_orders").select("*").eq("id", id).single();
  if (purchase?.status === "received") redirect(`/purchases/${id}?error=Received%20purchases%20cannot%20be%20cancelled.`);
  if (purchase?.status === "voided") redirect(`/purchases/${id}?error=Voided%20purchases%20cannot%20be%20cancelled.`);
  const { data: after } = await supabase.from("purchase_orders").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", id).neq("status", "received").select("*").single();
  await logActivity({
    profile,
    action: "cancel",
    entityType: "purchase",
    entityId: id,
    entityLabel: id.slice(0, 8),
    beforeData: purchase,
    afterData: after ?? { status: "cancelled" },
    metadata: { reason },
    summary: "Cancelled purchase",
  });
  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  redirect(`/purchases/${id}`);
}

export async function deleteDraftPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const path = `/purchases/${id}`;
  const reason = requireConfirmedReason(fd, path);

  const { data: purchase, error: purchaseError } = await supabase.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (purchaseError || !purchase) fail("/purchases", "Purchase not found.");
  if (purchase.status !== "draft") fail(path, "Only draft purchases can be hard-deleted.");

  const [{ count: movementCount, error: movementError }, { count: financeCount, error: financeError }] = await Promise.all([
    supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("related_purchase_id", id),
    supabase.from("financial_transactions").select("id", { count: "exact", head: true }).eq("related_purchase_id", id),
  ]);
  if (movementError || financeError) {
    console.error("[purchases] Failed to verify draft delete safety", movementError ?? financeError);
    fail(path, "Could not verify purchase history.");
  }
  if (Number(movementCount ?? 0) > 0 || Number(financeCount ?? 0) > 0) {
    fail(path, "This purchase already has inventory or finance history. Void or cancel it instead.");
  }

  const { data: lines } = await supabase.from("purchase_order_lines").select("*").eq("purchase_order_id", id);
  const { error: lineDeleteError } = await supabase.from("purchase_order_lines").delete().eq("purchase_order_id", id);
  if (lineDeleteError) {
    console.error("[purchases] Failed to delete draft purchase lines", lineDeleteError);
    fail(path, "Could not delete purchase lines.");
  }

  const { error } = await supabase.from("purchase_orders").delete().eq("id", id).eq("status", "draft");
  if (error) {
    console.error("[purchases] Failed to delete draft purchase", error);
    fail(path, "Could not delete draft purchase.");
  }

  await logActivity({
    profile,
    action: "delete",
    entityType: "purchase",
    entityId: id,
    entityLabel: purchase.receipt_number ?? id.slice(0, 8),
    beforeData: { purchase, lines },
    metadata: { reason },
    summary: "Hard-deleted draft purchase",
  });

  revalidatePath("/purchases");
  revalidatePath("/inventory");
  redirect("/purchases");
}

export async function voidReceivedPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const path = `/purchases/${id}`;
  const reason = requireConfirmedReason(fd, path);

  const { data: purchase, error: purchaseError } = await supabase.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (purchaseError || !purchase) fail("/purchases", "Purchase not found.");
  if (purchase.status !== "received") fail(path, "Only received purchases can be voided.");

  const { data: receiptMovements, error: movementsError } = await supabase
    .from("inventory_movements")
    .select("*")
    .eq("related_purchase_id", id)
    .eq("reason", "purchase_received")
    .order("created_at");
  if (movementsError) {
    console.error("[purchases] Failed to load receipt movements for void", movementsError);
    fail(path, "Could not load purchase receipt movements.");
  }

  const movementIds = (receiptMovements ?? []).map((movement: any) => movement.id);
  let existingReversalCount = 0;
  if (movementIds.length) {
    const { count, error } = await supabase.from("inventory_movements").select("id", { count: "exact", head: true }).in("reversed_movement_id", movementIds);
    if (error) {
      console.error("[purchases] Failed to verify purchase reversal status", error);
      fail(path, "Could not verify purchase reversal status.");
    }
    existingReversalCount = count ?? 0;
  }
  if (existingReversalCount > 0) fail(path, "This purchase already has reversal movements.");

  const now = new Date().toISOString();
  const reversalRows = (receiptMovements ?? []).map((movement: any) => ({
    product_id: movement.product_id,
    quantity: Number(movement.quantity ?? 0),
    from_entity_type: movement.to_entity_type,
    from_entity_id: movement.to_entity_id,
    to_entity_type: movement.from_entity_type,
    to_entity_id: movement.from_entity_id,
    reason: "manual_correction",
    related_purchase_id: id,
    related_purchase_line_id: movement.related_purchase_line_id ?? null,
    related_route_id: movement.related_route_id ?? null,
    related_route_stop_id: movement.related_route_stop_id ?? null,
    related_machine_id: movement.related_machine_id ?? null,
    unit_cost_lyd: movement.unit_cost_lyd ?? null,
    line_total_lyd: movement.line_total_lyd === null || movement.line_total_lyd === undefined ? null : -Math.abs(Number(movement.line_total_lyd)),
    reversed_movement_id: movement.id,
    correction_reason: reason,
    created_by: profile.team_member_id,
    notes: `Voided purchase ${purchase.receipt_number ?? id.slice(0, 8)}: ${reason}`,
  }));

  if (reversalRows.length) {
    const { error } = await supabase.from("inventory_movements").insert(reversalRows);
    if (error) {
      console.error("[purchases] Failed to create purchase reversal movements", error);
      fail(path, "Could not create reversal inventory movements.");
    }
  }

  await supabase.from("purchase_order_lines").update({ received_qty: 0 }).eq("purchase_order_id", id);

  const { data: voidedPurchase, error: voidError } = await supabase
    .from("purchase_orders")
    .update({
      status: "voided",
      payment_status: "voided",
      voided_at: now,
      voided_by: profile.team_member_id,
      void_reason: reason,
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "received")
    .select("*")
    .single();
  if (voidError) {
    console.error("[purchases] Failed to void purchase", voidError);
    fail(path, "Could not void purchase.");
  }

  const { data: financeBefore } = await supabase
    .from("financial_transactions")
    .select("*")
    .eq("related_purchase_id", id)
    .eq("transaction_kind", "product_purchase")
    .eq("transaction_status", "active");

  if (financeBefore?.length) {
    const financeIds = financeBefore.map((row: any) => row.id);
    const { data: financeAfter, error: financeError } = await supabase
      .from("financial_transactions")
      .update({
        transaction_status: "voided",
        voided_at: now,
        voided_by: profile.team_member_id,
        status_reason: reason,
        updated_at: now,
      })
      .in("id", financeIds)
      .select("*");
    if (financeError) {
      console.error("[purchases] Failed to void purchase financial transaction", financeError);
      fail(path, "Purchase was reversed, but the financial transaction could not be voided.");
    }

    for (const financeRow of financeAfter ?? []) {
      await logActivity({
        profile,
        action: "void",
        entityType: "financial_transaction",
        entityId: financeRow.id,
        entityLabel: "Purchase financial transaction",
        beforeData: financeBefore.find((row: any) => row.id === financeRow.id),
        afterData: financeRow,
        metadata: { reason, related_purchase_id: id },
        summary: "Voided financial transaction linked to a voided purchase",
      });
    }
  }

  await logActivity({
    profile,
    action: "void",
    entityType: "purchase",
    entityId: id,
    entityLabel: purchase.receipt_number ?? id.slice(0, 8),
    beforeData: purchase,
    afterData: voidedPurchase,
    metadata: {
      reason,
      reversal_movement_count: reversalRows.length,
      financial_transaction_count: financeBefore?.length ?? 0,
    },
    summary: `Voided received purchase and created ${reversalRows.length} reversal movements`,
  });

  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  revalidatePath("/inventory");
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
  redirect(`/purchases/${id}`);
}
