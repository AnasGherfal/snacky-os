"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { AppRole, isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";
import { createPurchaseFinancialTransaction } from "@/lib/finance-actions";
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
};

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
  return ["paid", "unpaid", "partial"].includes(status) ? status : "paid";
}

function canManagePurchases(role: AppRole | null | undefined) {
  return isOwnerAdminRole(role) || isSupervisorRole(role) || role === "warehouse";
}

function parseLines(raw: FormDataEntryValue | null): PurchaseLineInput[] {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((line): PurchaseLineInput => ({
        productId: String(line.productId || ""),
        boxesQty: Math.max(0, Math.floor(Number(line.boxesQty || 0))),
        unitsPerBox: Math.max(1, Math.floor(Number(line.unitsPerBox || 1))),
        looseUnitsQty: Math.max(0, Math.floor(Number(line.looseUnitsQty || 0))),
        unitCost: Math.max(0, Number(line.unitCost || 0)),
        lineTotal: Math.max(0, Number(line.lineTotal || 0)),
        pricingMode: line.pricingMode === "total" ? "total" : "unit",
      }))
      .filter((line) => line.productId && line.boxesQty * line.unitsPerBox + line.looseUnitsQty > 0);
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

function fail(path: string, message: string): never {
  const params = new URLSearchParams({ error: message });
  redirect(`${path}?${params.toString()}`);
}

async function requirePurchaseAccess() {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePurchases(profile.role)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/purchases?error=Supabase%20is%20not%20configured.");
  return { profile, supabase };
}

async function getDefaultStorageId(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const { data: storage, error } = await supabase.from("storage_locations").select("id").eq("active", true).order("name").limit(1).maybeSingle();
  if (error) throw error;
  return storage?.id ?? null;
}

export async function createPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const lines = parseLines(fd.get("lines_json"));
  if (!lines.length) fail("/purchases/new", "Add at least one purchased item.");

  const { receiptUrl, uploadUnavailable } = await resolvePurchaseReceiptUrl(supabase, fd);
  const lineRows = buildLineRows(lines);
  const totals = buildTotals(fd, lineRows.reduce((sum, line) => sum + Number(line.line_total), 0));
  const submitAction = String(fd.get("submit_action") || "draft");

  const { data: purchase, error: purchaseError } = await supabase
    .from("purchase_orders")
    .insert({
      supplier_id: String(fd.get("supplier_id") || "") || null,
      status: "draft",
      order_date: String(fd.get("purchase_date") || new Date().toISOString().slice(0, 10)),
      receipt_number: String(fd.get("receipt_number") || "").trim() || null,
      payment_method: String(fd.get("payment_method") || "cash"),
      payment_status: parsePaymentStatus(fd.get("payment_status")),
      receipt_url: receiptUrl,
      notes: String(fd.get("notes") || "").trim() || null,
      ...totals,
      created_by: profile.team_member_id,
    })
    .select("id, receipt_number, status, total_amount, payment_status")
    .single();

  if (purchaseError || !purchase) {
    console.error("[purchases] Failed to create purchase", purchaseError);
    fail("/purchases/new", "Could not create purchase.");
  }

  const { error: linesError } = await supabase.from("purchase_order_lines").insert(lineRows.map((line) => ({ ...line, purchase_order_id: purchase.id })));
  if (linesError) {
    console.error("[purchases] Failed to create purchase lines", linesError);
    fail("/purchases/new", "Could not create purchase items.");
  }

  await logActivity({
    profile,
    action: "create",
    entityType: "purchase",
    entityId: purchase.id,
    entityLabel: String(fd.get("receipt_number") || purchase.id.slice(0, 8)),
    afterData: { ...purchase, line_count: lineRows.length, total_amount: totals.total_amount },
    summary: `Created purchase with ${lineRows.length} line items`,
  });

  if (submitAction === "received") {
    try {
      await receivePurchaseById(purchase.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Purchase was saved but could not be received.";
      redirect(`/purchases/${purchase.id}?error=${encodeURIComponent(message)}`);
    }
  }

  revalidatePath("/purchases");
  revalidatePath("/inventory");
  redirect(uploadUnavailable ? `/purchases/${purchase.id}?receiptUpload=storage-unavailable` : `/purchases/${purchase.id}`);
}

export async function updatePurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");

  const { data: current, error: currentError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .single();
  if (currentError || !current) fail(`/purchases/${id}/edit`, "Purchase not found.");
  if (current.status !== "draft") fail(`/purchases/${id}`, "Only draft purchases can be edited.");

  const lines = parseLines(fd.get("lines_json"));
  if (!lines.length) fail(`/purchases/${id}/edit`, "Add at least one purchased item.");

  const { receiptUrl, uploadUnavailable } = await resolvePurchaseReceiptUrl(supabase, fd);
  const existingReceiptUrl = String(fd.get("current_receipt_url") || current.receipt_url || "").trim();
  const lineRows = buildLineRows(lines);
  const totals = buildTotals(fd, lineRows.reduce((sum, line) => sum + Number(line.line_total), 0));

  const { error: updateError } = await supabase
    .from("purchase_orders")
    .update({
      supplier_id: String(fd.get("supplier_id") || "") || null,
      order_date: String(fd.get("purchase_date") || new Date().toISOString().slice(0, 10)),
      receipt_number: String(fd.get("receipt_number") || "").trim() || null,
      payment_method: String(fd.get("payment_method") || "cash"),
      payment_status: parsePaymentStatus(fd.get("payment_status")),
      receipt_url: (receiptUrl ?? existingReceiptUrl) || null,
      notes: String(fd.get("notes") || "").trim() || null,
      ...totals,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "draft");
  if (updateError) {
    console.error("[purchases] Failed to update purchase", updateError);
    fail(`/purchases/${id}/edit`, "Could not update purchase.");
  }

  const { error: deleteError } = await supabase.from("purchase_order_lines").delete().eq("purchase_order_id", id);
  if (deleteError) {
    console.error("[purchases] Failed to replace purchase lines", deleteError);
    fail(`/purchases/${id}/edit`, "Could not update purchase items.");
  }

  const { error: linesError } = await supabase.from("purchase_order_lines").insert(lineRows.map((line) => ({ ...line, purchase_order_id: id })));
  if (linesError) {
    console.error("[purchases] Failed to save purchase lines", linesError);
    fail(`/purchases/${id}/edit`, "Could not save purchase items.");
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "purchase",
    entityId: id,
    entityLabel: String(fd.get("receipt_number") || id.slice(0, 8)),
    beforeData: current,
    afterData: { line_count: lineRows.length, ...totals },
    summary: "Updated draft purchase",
  });

  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  revalidatePath(`/purchases/${id}/edit`);
  redirect(uploadUnavailable ? `/purchases/${id}?receiptUpload=storage-unavailable` : `/purchases/${id}`);
}

async function receivePurchaseById(id: string) {
  const { profile, supabase } = await requirePurchaseAccess();
  const { data: purchase, error: purchaseError } = await supabase.from("purchase_orders").select("id, status, supplier_id, receipt_number, payment_method, payment_status, receipt_url, total_amount, manual_total_lyd, calculated_total_lyd").eq("id", id).single();
  if (purchaseError || !purchase) throw new Error("Purchase not found.");
  const purchaseTotal = Number(purchase.manual_total_lyd ?? purchase.total_amount ?? purchase.calculated_total_lyd ?? 0);
  const receivedDate = new Date().toISOString().slice(0, 10);
  if (purchase.status === "received") {
    if (purchase.payment_status === "paid") {
      await createPurchaseFinancialTransaction(supabase, profile, { ...purchase, received_date: receivedDate }, purchaseTotal);
    }
    return;
  }
  if (purchase.status === "cancelled") throw new Error("Cancelled purchases cannot be received.");

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

export async function cancelPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const id = String(fd.get("id") || "");
  if (!id) redirect("/purchases");
  const { data: purchase } = await supabase.from("purchase_orders").select("status").eq("id", id).single();
  if (purchase?.status === "received") redirect(`/purchases/${id}?error=Received%20purchases%20cannot%20be%20cancelled.`);
  await supabase.from("purchase_orders").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", id).neq("status", "received");
  await logActivity({
    profile,
    action: "archive",
    entityType: "purchase",
    entityId: id,
    entityLabel: id.slice(0, 8),
    beforeData: purchase,
    afterData: { status: "cancelled" },
    summary: "Cancelled purchase",
  });
  revalidatePath("/purchases");
  revalidatePath(`/purchases/${id}`);
  redirect(`/purchases/${id}`);
}
