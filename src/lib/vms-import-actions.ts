"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type ImportKind = "stock" | "sales";

type ImportSummary = {
  importType: ImportKind;
  fileName: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  unknownMachines: string[];
  unmappedProducts: string[];
  errors: string[];
};

function parseCsv(text: string) {
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
  if (!rows.length) return [];

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });
    return record;
  });
}

function value(row: Record<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const found = row[alias.toLowerCase()];
    if (found !== undefined && found !== "") return found;
  }
  return "";
}

function numberValue(input: string) {
  const value = Number(String(input).replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function dateValue(input: string) {
  const date = input ? new Date(input) : new Date();
  return Number.isNaN(date.getTime()) ? null : date;
}

function explicitSellingPrice(row: Record<string, string>) {
  return numberValue(value(row, ["vms_selling_price_lyd", "vms_selling_price", "selling_price_lyd", "selling_price", "unit_price_lyd", "unit_price", "price_lyd", "price"]));
}

function explicitCostPrice(row: Record<string, string>) {
  return numberValue(value(row, ["vms_cost_price_lyd", "vms_cost_price", "cost_price_lyd", "cost_price", "unit_cost_lyd", "unit_cost"]));
}

function productKey(vmsProductId: string, vmsProductName: string) {
  return `${vmsProductId}::${vmsProductName}`.toLowerCase();
}

function uniquePush(list: string[], item: string) {
  if (item && !list.includes(item)) list.push(item);
}

async function ensureNeedsReviewMapping(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  mappingsByKey: Map<string, any>,
  profile: Awaited<ReturnType<typeof getCurrentProfile>>,
  vmsProductId: string,
  vmsProductName: string,
) {
  const key = productKey(vmsProductId, vmsProductName);
  if (mappingsByKey.has(key)) return;

  const { data } = await supabase
    .from("vms_product_mappings")
    .insert({
      vms_product_id: vmsProductId || null,
      vms_product_name: vmsProductName,
      match_status: "needs_review",
    })
    .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd")
    .maybeSingle();

  if (data) mappingsByKey.set(key, data);
  if (data) {
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
}

export async function importVmsCsv(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile.role)) redirect("/unauthorized");

  const supabase = getSupabaseServerClient();
  if (!supabase) redirect("/vms-import?error=Supabase%20is%20not%20configured.");

  const importType = String(formData.get("import_type") || "") as ImportKind;
  const file = formData.get("file");
  if (importType !== "stock" && importType !== "sales") redirect("/vms-import?error=Choose%20stock%20or%20sales%20import.");
  if (!(file instanceof File) || file.size === 0) redirect("/vms-import?error=Upload%20a%20CSV%20file.");

  const text = await file.text();
  const rows = parseCsv(text);
  const summary: ImportSummary = {
    importType,
    fileName: file.name,
    totalRows: rows.length,
    importedRows: 0,
    skippedRows: 0,
    unknownMachines: [],
    unmappedProducts: [],
    errors: [],
  };

  const { data: batch, error: batchError } = await supabase
    .from("vms_import_batches")
    .insert({
      source_type: `${importType}_csv`,
      file_name: file.name,
      imported_by: profile.team_member_id,
      status: "processing",
      row_count: rows.length,
    })
    .select("id")
    .single();

  if (batchError || !batch?.id) {
    console.error("[vms-import] Failed to create batch", batchError);
    redirect("/vms-import?error=Could%20not%20create%20import%20batch.");
  }

  const [{ data: machines }, { data: mappings }] = await Promise.all([
    supabase.from("machines").select("id, machine_code, vms_machine_id, name"),
    supabase.from("vms_product_mappings").select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd"),
  ]);

  const machineByVmsId = new Map<string, any>();
  (machines ?? []).forEach((machine: any) => {
    if (machine.vms_machine_id) machineByVmsId.set(String(machine.vms_machine_id).toLowerCase(), machine);
    if (machine.machine_code) machineByVmsId.set(String(machine.machine_code).toLowerCase(), machine);
  });

  const mappingsByKey = new Map<string, any>();
  (mappings ?? []).forEach((mapping: any) => {
    mappingsByKey.set(productKey(mapping.vms_product_id ?? "", mapping.vms_product_name ?? ""), mapping);
  });

  const stockSnapshots: any[] = [];
  const salesSnapshots: any[] = [];
  const vmsSellingPriceByProductId = new Map<string, number>();
  const latestMappingRowsById = new Map<string, any>();

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const vmsMachineId = value(row, ["vms_machine_id", "machine_id"]);
    const machineName = value(row, ["machine_name"]);
    const vmsProductId = value(row, ["vms_product_id", "product_id", "product_code"]);
    const vmsProductName = value(row, ["vms_product_name", "product_name"]);
    const machine = machineByVmsId.get(vmsMachineId.toLowerCase());

    if (!vmsProductName) {
      summary.skippedRows += 1;
      summary.errors.push(`Row ${rowNumber}: missing VMS product name.`);
      continue;
    }

    const key = productKey(vmsProductId, vmsProductName);
    let mapping = mappingsByKey.get(key);
    if (!mapping) {
      await ensureNeedsReviewMapping(supabase, mappingsByKey, profile, vmsProductId, vmsProductName);
      mapping = mappingsByKey.get(key);
    }

    const importedSellingPrice = explicitSellingPrice(row);
    const importedCostPrice = explicitCostPrice(row);
    const lastSeenAt = dateValue(value(row, ["last_updated", "captured_at", "date", "period_end", "sales_date"])) ?? new Date();

    if (mapping?.id) {
      latestMappingRowsById.set(String(mapping.id), {
        id: mapping.id,
        vms_product_id: vmsProductId || null,
        vms_product_name: vmsProductName,
        vms_selling_price_lyd: importedSellingPrice !== null && importedSellingPrice >= 0 ? importedSellingPrice : mapping.vms_selling_price_lyd ?? null,
        vms_cost_price_lyd: importedCostPrice !== null && importedCostPrice >= 0 ? importedCostPrice : mapping.vms_cost_price_lyd ?? null,
        latest_machine_id: machine?.id ?? null,
        latest_vms_machine_id: vmsMachineId || null,
        latest_machine_name: machineName || machine?.name || null,
        last_seen_at: lastSeenAt.toISOString(),
        last_import_batch_id: batch.id,
        updated_at: new Date().toISOString(),
      });
    }

    if (!machine) {
      summary.skippedRows += 1;
      uniquePush(summary.unknownMachines, vmsMachineId || machineName || `Row ${rowNumber}`);
      summary.errors.push(`Row ${rowNumber}: unknown machine ${vmsMachineId || machineName || "blank"}.`);
      continue;
    }

    if (!mapping?.product_id || mapping.match_status !== "confirmed") {
      summary.skippedRows += 1;
      uniquePush(summary.unmappedProducts, vmsProductId ? `${vmsProductId} - ${vmsProductName}` : vmsProductName);
      continue;
    }

    if (importedSellingPrice !== null && importedSellingPrice >= 0) {
      vmsSellingPriceByProductId.set(String(mapping.product_id), importedSellingPrice);
    }

    if (importType === "stock") {
      const currentQty = numberValue(value(row, ["current_qty", "stock_qty", "quantity"]));
      if (currentQty === null || currentQty < 0) {
        summary.skippedRows += 1;
        summary.errors.push(`Row ${rowNumber}: invalid current quantity.`);
        continue;
      }

      const capturedAt = dateValue(value(row, ["last_updated", "captured_at", "date"]));
      if (!capturedAt) {
        summary.skippedRows += 1;
        summary.errors.push(`Row ${rowNumber}: invalid stock snapshot date.`);
        continue;
      }
      stockSnapshots.push({
        import_batch_id: batch.id,
        machine_id: machine.id,
        vms_machine_id: vmsMachineId,
        slot_code: value(row, ["slot_code", "slot"]),
        vms_product_id: vmsProductId || null,
        vms_product_name: vmsProductName,
        product_id: mapping.product_id,
        current_qty: currentQty,
        capacity: numberValue(value(row, ["capacity"])) ?? null,
        captured_at: capturedAt.toISOString(),
      });
      summary.importedRows += 1;
    } else {
      const soldQty = numberValue(value(row, ["sold_qty", "quantity_sold", "units"]));
      const salesAmount = numberValue(value(row, ["total_sales_lyd", "total_sales", "sales_amount"]));
      if (soldQty === null || soldQty < 0 || salesAmount === null || salesAmount < 0) {
        summary.skippedRows += 1;
        summary.errors.push(`Row ${rowNumber}: invalid sales quantity or amount.`);
        continue;
      }

      const periodDate = dateValue(value(row, ["date", "period_end", "sales_date"]));
      if (!periodDate) {
        summary.skippedRows += 1;
        summary.errors.push(`Row ${rowNumber}: invalid sales date.`);
        continue;
      }
      const periodStart = new Date(periodDate);
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(periodDate);
      periodEnd.setHours(23, 59, 59, 999);

      salesSnapshots.push({
        import_batch_id: batch.id,
        machine_id: machine.id,
        product_id: mapping.product_id,
        sold_qty: soldQty,
        sales_amount: salesAmount,
        cash_sales_amount: numberValue(value(row, ["cash_sales_lyd", "cash_sales", "cash_sales_amount"])) ?? 0,
        card_sales_amount: numberValue(value(row, ["card_sales_lyd", "card_sales", "card_sales_amount"])) ?? 0,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
      });
      summary.importedRows += 1;
    }
  }

  if (stockSnapshots.length) {
    const { error } = await supabase.from("vms_stock_snapshots").insert(stockSnapshots);
    if (error) {
      console.error("[vms-import] Stock snapshot insert failed", error);
      summary.errors.push("Stock snapshot insert failed.");
      summary.skippedRows += stockSnapshots.length;
      summary.importedRows -= stockSnapshots.length;
    }
  }

  if (salesSnapshots.length) {
    const { error } = await supabase.from("vms_sales_snapshots").insert(salesSnapshots);
    if (error) {
      console.error("[vms-import] Sales snapshot insert failed", error);
      summary.errors.push("Sales snapshot insert failed.");
      summary.skippedRows += salesSnapshots.length;
      summary.importedRows -= salesSnapshots.length;
    }
  }

  if (latestMappingRowsById.size) {
    const { error } = await supabase
      .from("vms_product_mappings")
      .upsert([...latestMappingRowsById.values()], { onConflict: "id" });
    if (error) {
      console.error("[vms-import] VMS product mapping metadata update failed", error);
      summary.errors.push("VMS product mapping metadata update failed.");
    }
  }

  for (const [productId, sellingPrice] of vmsSellingPriceByProductId.entries()) {
    const { error } = await supabase
      .from("products")
      .update({
        vms_selling_price_lyd: sellingPrice,
        current_selling_price_lyd: sellingPrice,
        selling_price: sellingPrice,
        selling_price_source: "vms",
        price_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", productId);
    if (error) {
      console.error("[vms-import] Product selling price update failed", { productId, error });
      summary.errors.push("Product selling price update failed.");
    }
  }

  const status = summary.errors.length || summary.skippedRows ? "completed_with_warnings" : "completed";
  await supabase
    .from("vms_import_batches")
    .update({
      status,
      row_count: summary.totalRows,
      error_count: summary.errors.length,
      notes: JSON.stringify(summary),
    })
    .eq("id", batch.id);

  await logActivity({
    profile,
    action: "import_vms",
    entityType: "vms_mapping",
    entityId: batch.id,
    entityLabel: `${importType} CSV ${file.name}`,
    afterData: summary,
    metadata: { import_type: importType, file_name: file.name },
    summary: `Imported ${summary.importedRows} ${importType} rows from VMS CSV`,
  });

  revalidatePath("/vms-import");
  revalidatePath("/vms-mappings");
  revalidatePath("/refills");
  revalidatePath("/dashboard");
  revalidatePath("/sales");
  revalidatePath("/products-dashboard");
  revalidatePath("/machines-dashboard");
  redirect(`/vms-import?batchId=${batch.id}`);
}
