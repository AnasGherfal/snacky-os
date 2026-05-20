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
  if (status === "partial") return "partially_paid";
  return ["paid", "unpaid", "partially_paid", "voided"].includes(status) ? status : "paid";
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
  if (!profile || !canManagePurchases(profile.role)) redirect("/unauthorized");
  const supabase = getSupabaseServerClient();
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

export async function createPurchase(fd: FormData) {
  const { profile, supabase } = await requirePurchaseAccess();
  const lines = parseLines(fd.get("lines_json"));
  if (!lines.length) fail("/purchases/new", "Add at least one purchased item.");

  const { receiptUrl, uploadUnavailable, uploadError } = await resolvePurchaseReceiptUrl(supabase, fd);
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
  const receiptUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
  redirect(receiptUpload ? `/purchases/${purchase.id}?receiptUpload=${receiptUpload}` : `/purchases/${purchase.id}`);
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

  const { receiptUrl, uploadUnavailable, uploadError } = await resolvePurchaseReceiptUrl(supabase, fd);
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
  const receiptUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
  redirect(receiptUpload ? `/purchases/${id}?receiptUpload=${receiptUpload}` : `/purchases/${id}`);
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
    .select("id, status, supplier_id, receipt_number, payment_method, payment_status, receipt_url, total_amount, manual_total_lyd, calculated_total_lyd, received_date, received_at")
    .eq("id", id)
    .maybeSingle();
  if (purchaseError || !purchase) fail("/purchases", "Purchase not found.");
  if (purchase.status !== "received") fail(path, "Only received purchases can be marked paid.");
  if (purchase.payment_status === "voided" || purchase.status === "voided") fail(path, "Voided purchases cannot be paid.");

  const paidPurchase = {
    ...purchase,
    payment_status: "paid",
    received_date: purchase.received_date ?? String(purchase.received_at ?? new Date().toISOString()).slice(0, 10),
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
    await createPurchaseFinancialTransaction(supabase, profile, paidPurchase, purchaseTotal);
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
