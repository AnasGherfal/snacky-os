import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const dataDir = path.join("docs", "current-data");
const financeSourceFile = "docs/current-data/financial_transactions.csv";
const financeSourceSheet = "production_bootstrap_financial_transactions";
const storageSourceFile = "docs/current-data/storage_inventory.csv";
const purchasesSourceFile = "docs/current-data/purchases.csv";
const mainStorageName = "MAIN";
const batchSize = 100;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkFilesOnly = args.has("--check-files");
const allowLocal = args.has("--allow-local");
const confirmed = args.has("--confirm-production-bootstrap");

function usage() {
  return [
    "Usage:",
    "  node scripts/bootstrap-production-data.mjs --check-files",
    "  node scripts/bootstrap-production-data.mjs --dry-run",
    "  node scripts/bootstrap-production-data.mjs --confirm-production-bootstrap",
    "",
    "Options:",
    "  --check-files                    Parse docs/current-data without connecting to Supabase.",
    "  --dry-run                        Connect and report rows that would be inserted.",
    "  --confirm-production-bootstrap   Required before writing to Supabase.",
    "  --allow-local                    Allow local Supabase URLs for rehearsal only.",
  ].join("\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  const [headers, ...records] = rows;
  if (!headers) return [];
  return records.map((record, index) => ({
    __csvRow: index + 2,
    ...Object.fromEntries(headers.map((header, headerIndex) => [header, record[headerIndex] ?? ""])),
  }));
}

async function readCurrentDataCsv(name) {
  return parseCsv(await readFile(path.join(dataDir, `${name}.csv`), "utf8"));
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  if (!text || text.toUpperCase() === "TO_CONFIRM") return null;
  return text;
}

function normalizeVmsProductId(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^\d+\.0+$/.test(text)) return text.split(".")[0];
  return text;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(cleanText(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInteger(value, fallback = 0) {
  const numeric = Math.round(toNumber(value, fallback));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function roundUnitCost(value) {
  return Math.round(toNumber(value) * 10000) / 10000;
}

function chunks(values, size = batchSize) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function isLocalSupabaseUrl(url) {
  return /(^http:\/\/(127\.0\.0\.1|localhost)|^https:\/\/(127\.0\.0\.1|localhost))/i.test(url);
}

async function fetchByIn(supabase, table, select, column, values) {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  const rows = [];
  for (const group of chunks(uniqueValues)) {
    const { data, error } = await supabase.from(table).select(select).in(column, group);
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

async function insertRows(supabase, table, rows) {
  if (!rows.length) return 0;
  if (dryRun) return rows.length;

  let inserted = 0;
  for (const group of chunks(rows)) {
    const { error } = await supabase.from(table).insert(group);
    if (error) throw error;
    inserted += group.length;
  }
  return inserted;
}

function productPayload(row) {
  const sku = cleanText(row.sku || row.product_id);
  const sellingPrice = toNumber(row.selling_price);
  const costPrice = toNumber(row.purchase_price);
  const caseQuantity = Math.max(1, toInteger(row.units_per_box, 1));

  return {
    sku,
    barcode: nullableText(row.barcode),
    name: cleanText(row.name) || sku,
    category: nullableText(row.product_group) || "snack",
    brand: null,
    supplier_id: null,
    cost_price: costPrice,
    selling_price: sellingPrice,
    current_cost_price_lyd: costPrice,
    current_selling_price_lyd: sellingPrice,
    cost_price_source: "initial_import",
    selling_price_source: "initial_import",
    case_quantity: caseQuantity,
    expiry_sensitive: true,
    active: true,
    import_source: "initial_import",
  };
}

async function importProducts(supabase, productRows) {
  const payloads = productRows.map(productPayload).filter((row) => row.sku && row.name);
  const existing = await fetchByIn(supabase, "products", "id, sku", "sku", payloads.map((row) => row.sku));
  const existingSkus = new Set(existing.map((row) => row.sku));
  const missing = payloads.filter((row) => !existingSkus.has(row.sku));

  return {
    sourceRows: productRows.length,
    inserted: await insertRows(supabase, "products", missing),
    skippedExisting: payloads.length - missing.length,
    skippedInvalid: productRows.length - payloads.length,
  };
}

async function ensureLocations(supabase, machineRows) {
  const sourceNames = [
    ...new Set(machineRows.map((row) => nullableText(row.location)).filter(Boolean)),
  ];
  const existing = await fetchByIn(supabase, "locations", "id, name", "name", sourceNames);
  const existingNames = new Set(existing.map((row) => row.name));
  const missing = sourceNames
    .filter((name) => !existingNames.has(name))
    .map((name) => ({
      name,
      location_type: "other",
      address: name,
      status: "active",
      notes: "Production bootstrap from docs/current-data/machines.csv",
    }));

  const inserted = await insertRows(supabase, "locations", missing);
  const finalRows = dryRun
    ? existing
    : await fetchByIn(supabase, "locations", "id, name", "name", sourceNames);

  return {
    locationByName: new Map(finalRows.map((row) => [row.name, row.id])),
    stats: {
      sourceRows: sourceNames.length,
      inserted,
      skippedExisting: sourceNames.length - missing.length,
    },
  };
}

function machinePayload(row, locationByName) {
  const vmsMachineId = cleanText(row.machine_id);
  const locationName = nullableText(row.location);
  return {
    machine_code: `SNK-${vmsMachineId}`,
    vms_machine_id: vmsMachineId,
    name: cleanText(row.machine_name) || `Machine ${vmsMachineId}`,
    machine_type: "lift",
    location_id: locationName ? locationByName.get(locationName) ?? null : null,
    status: "active",
    notes: nullableText(row.notes) ?? "Production bootstrap from docs/current-data/machines.csv",
  };
}

async function importMachines(supabase, machineRows, locationByName) {
  const payloads = machineRows.map((row) => machinePayload(row, locationByName)).filter((row) => row.vms_machine_id);
  const existingByCode = await fetchByIn(supabase, "machines", "id, machine_code, vms_machine_id", "machine_code", payloads.map((row) => row.machine_code));
  const existingByVms = await fetchByIn(supabase, "machines", "id, machine_code, vms_machine_id", "vms_machine_id", payloads.map((row) => row.vms_machine_id));
  const existingCodes = new Set([...existingByCode, ...existingByVms].map((row) => row.machine_code));
  const existingVmsIds = new Set([...existingByCode, ...existingByVms].map((row) => row.vms_machine_id).filter(Boolean));
  const missing = payloads.filter((row) => !existingCodes.has(row.machine_code) && !existingVmsIds.has(row.vms_machine_id));

  return {
    sourceRows: machineRows.length,
    inserted: await insertRows(supabase, "machines", missing),
    skippedExisting: payloads.length - missing.length,
    skippedInvalid: machineRows.length - payloads.length,
  };
}

async function getMachineByVmsId(supabase, machineRows) {
  const payloads = machineRows.map((row) => machinePayload(row, new Map())).filter((row) => row.vms_machine_id);
  if (dryRun) {
    return new Map(payloads.map((machine) => [machine.vms_machine_id, { id: `dry-run-machine-${machine.vms_machine_id}`, vms_machine_id: machine.vms_machine_id }]));
  }

  const machines = await fetchByIn(supabase, "machines", "id, vms_machine_id", "vms_machine_id", payloads.map((row) => row.vms_machine_id));
  return new Map(machines.filter((machine) => machine.vms_machine_id).map((machine) => [machine.vms_machine_id, machine]));
}

async function ensureMainStorage(supabase) {
  const { data: existing, error } = await supabase
    .from("storage_locations")
    .select("id, name")
    .eq("name", mainStorageName)
    .limit(1);
  if (error) throw error;
  if (existing?.[0]) return { row: existing[0], inserted: 0 };

  if (dryRun) return { row: null, inserted: 1 };

  const { data, error: insertError } = await supabase
    .from("storage_locations")
    .insert({
      name: mainStorageName,
      address: "Production bootstrap default storage",
      active: true,
    })
    .select("id, name")
    .single();
  if (insertError) throw insertError;
  return { row: data, inserted: 1 };
}

function aggregateOpeningBalances(storageRows) {
  const balances = new Map();
  for (const row of storageRows) {
    const sku = cleanText(row.item_id);
    if (!sku) continue;
    balances.set(sku, (balances.get(sku) ?? 0) + toNumber(row.amount));
  }
  return [...balances.entries()].map(([sku, quantity]) => ({ sku, quantity: Math.round(quantity) }));
}

async function importStorageOpeningBalances(supabase, storageRows, productBySku) {
  const storage = await ensureMainStorage(supabase);
  const balances = aggregateOpeningBalances(storageRows);
  const positiveBalances = balances.filter((row) => row.quantity > 0);
  const knownBalances = positiveBalances.filter((row) => productBySku.has(row.sku));
  const markers = knownBalances.map((row) => `production_bootstrap:storage_opening_balance:sku=${row.sku}:source=${storageSourceFile}`);
  const existing = await fetchByIn(supabase, "inventory_movements", "id, notes", "notes", markers);
  const existingMarkers = new Set(existing.map((row) => row.notes));
  const missing = knownBalances
    .map((row) => ({
      product_id: productBySku.get(row.sku).id,
      quantity: row.quantity,
      from_entity_type: "adjustment",
      from_entity_id: null,
      to_entity_type: "storage",
      to_entity_id: storage.row?.id ?? null,
      reason: "stock_count_adjustment",
      notes: `production_bootstrap:storage_opening_balance:sku=${row.sku}:source=${storageSourceFile}`,
    }))
    .filter((row) => !existingMarkers.has(row.notes));

  return {
    sourceRows: storageRows.length,
    sourceProducts: balances.length,
    storageLocationsInserted: storage.inserted,
    inserted: await insertRows(supabase, "inventory_movements", missing),
    skippedExisting: knownBalances.length - missing.length,
    skippedUnknownProduct: positiveBalances.length - knownBalances.length,
    skippedNonPositiveBalance: balances.length - positiveBalances.length,
  };
}

async function importVmsMappings(supabase, mappingRows, productBySku) {
  const payloads = mappingRows
    .map((row) => {
      const vmsProductId = normalizeVmsProductId(row.vms_product_number);
      const vmsProductName = cleanText(row.vms_product_name);
      const product = productBySku.get(cleanText(row.appsheet_item_id));
      return {
        vms_product_id: vmsProductId || null,
        vms_product_name: vmsProductName,
        product_id: product?.id ?? null,
        match_status: product ? "confirmed" : "needs_review",
      };
    })
    .filter((row) => row.vms_product_name);

  const existing = await fetchByIn(supabase, "vms_product_mappings", "id, vms_product_id, vms_product_name", "vms_product_id", payloads.map((row) => row.vms_product_id));
  const existingKeys = new Set(existing.map((row) => `${row.vms_product_id ?? ""}::${row.vms_product_name}`));
  const missing = payloads.filter((row) => !existingKeys.has(`${row.vms_product_id ?? ""}::${row.vms_product_name}`));

  return {
    sourceRows: mappingRows.length,
    inserted: await insertRows(supabase, "vms_product_mappings", missing),
    skippedExisting: payloads.length - missing.length,
    skippedInvalid: mappingRows.length - payloads.length,
    skippedUnknownProduct: payloads.filter((row) => !row.product_id).length,
  };
}

function buildProductByVmsProductId(mappingRows, productBySku) {
  const result = new Map();
  for (const row of mappingRows) {
    const vmsProductId = normalizeVmsProductId(row.vms_product_number);
    const product = productBySku.get(cleanText(row.appsheet_item_id));
    if (vmsProductId && product) result.set(vmsProductId, product);
  }
  return result;
}

function planogramPayload(row, rowIndex, machineByVmsId, productByVmsProductId) {
  const vmsMachineId = cleanText(row.machine_id);
  const vmsProductId = normalizeVmsProductId(row.vms_product_number);
  const machine = machineByVmsId.get(vmsMachineId);
  const product = productByVmsProductId.get(vmsProductId);
  if (!machine || !product) return null;

  const capacitySource = toInteger(row.inventory_capacity, toInteger(row.inventory_quantity, 1));
  const capacity = Math.max(1, capacitySource);
  const parSource = nullableText(row.par_level) ? toInteger(row.par_level, capacity) : capacity;
  const parQty = Math.max(1, Math.min(capacity, parSource));
  const minSource = nullableText(row.min_level) ? toInteger(row.min_level, 0) : 0;
  const minQty = Math.max(0, Math.min(parQty, minSource));
  const slotCode = nullableText(row.slot_code) ?? `VMS-${vmsProductId || rowIndex + 1}`;

  return {
    machine_id: machine.id,
    slot_code: slotCode,
    product_id: product.id,
    capacity,
    min_qty: minQty,
    par_qty: parQty,
    active: true,
  };
}

async function importMachinePlanograms(supabase, planogramRows, machineByVmsId, productByVmsProductId) {
  const payloads = planogramRows
    .map((row, index) => planogramPayload(row, index, machineByVmsId, productByVmsProductId))
    .filter(Boolean);

  if (dryRun) {
    const uniqueKeys = new Set(payloads.map((row) => `${row.machine_id}::${row.slot_code}`));
    return {
      sourceRows: planogramRows.length,
      inserted: uniqueKeys.size,
      skippedExisting: 0,
      skippedDuplicateSourceRows: payloads.length - uniqueKeys.size,
      skippedInvalid: planogramRows.length - payloads.length,
      skippedUnknownMachineOrProduct: planogramRows.length - payloads.length,
    };
  }

  const existing = await fetchByIn(supabase, "machine_slots", "id, machine_id, slot_code", "machine_id", payloads.map((row) => row.machine_id));
  const existingKeys = new Set(existing.map((row) => `${row.machine_id}::${row.slot_code}`));
  const seenKeys = new Set();
  const missing = [];
  let skippedDuplicateSourceRows = 0;

  for (const payload of payloads) {
    const key = `${payload.machine_id}::${payload.slot_code}`;
    if (existingKeys.has(key)) continue;
    if (seenKeys.has(key)) {
      skippedDuplicateSourceRows += 1;
      continue;
    }
    seenKeys.add(key);
    missing.push(payload);
  }

  return {
    sourceRows: planogramRows.length,
    inserted: await insertRows(supabase, "machine_slots", missing),
    skippedExisting: payloads.length - missing.length - skippedDuplicateSourceRows,
    skippedDuplicateSourceRows,
    skippedInvalid: planogramRows.length - payloads.length,
    skippedUnknownMachineOrProduct: planogramRows.length - payloads.length,
  };
}

function financePayload(row) {
  const signedAmount = toNumber(row.signed_amount);
  const direction = signedAmount >= 0 ? "money_in" : "money_out";
  const transactionType = nullableText(row.transaction_type);
  const location = nullableText(row.location);
  const description = nullableText(row.transaction_description);
  const finalBucket = nullableText(row.final_bucket);
  const needsReview = !transactionType || !location || !description || !finalBucket;

  return {
    transaction_date: cleanText(row.date),
    direction,
    transaction_kind: "spreadsheet_import",
    transaction_type: transactionType,
    location,
    description,
    amount: Math.abs(signedAmount),
    signed_amount: signedAmount,
    bucket: nullableText(row.auto_bucket),
    bucket_override: nullableText(row.bucket_override),
    final_bucket: finalBucket,
    review_status: needsReview ? "needs_review" : "confirmed",
    needs_review: needsReview,
    source_sheet: financeSourceSheet,
    source_row: row.__csvRow,
    source_file: financeSourceFile,
    original_description: description,
    import_status: needsReview ? "needs_review" : "imported",
    metadata: {
      production_bootstrap: true,
      source_file: financeSourceFile,
      money_flow: nullableText(row.money_flow),
      raw_transaction: nullableText(row.transaction),
      raw_record: row,
    },
  };
}

async function importFinanceTransactions(supabase, financeRows) {
  const payloads = financeRows.map(financePayload).filter((row) => row.transaction_date && row.signed_amount !== 0);
  const existing = [];
  for (const group of chunks(payloads.map((row) => row.source_row))) {
    const { data, error } = await supabase
      .from("financial_transactions")
      .select("id, source_sheet, source_row")
      .eq("source_sheet", financeSourceSheet)
      .in("source_row", group);
    if (error) throw error;
    existing.push(...(data ?? []));
  }
  const existingRows = new Set(existing.map((row) => row.source_row));
  const missing = payloads.filter((row) => !existingRows.has(row.source_row));

  return {
    sourceRows: financeRows.length,
    inserted: await insertRows(supabase, "financial_transactions", missing),
    skippedExisting: payloads.length - missing.length,
    skippedInvalid: financeRows.length - payloads.length,
    needsReview: payloads.filter((row) => row.needs_review).length,
  };
}

async function ensureSuppliers(supabase, purchaseRows) {
  const supplierNames = [...new Set(purchaseRows.map((row) => nullableText(row.supplier)).filter(Boolean))];
  const existing = await fetchByIn(supabase, "suppliers", "id, name", "name", supplierNames);
  const existingNames = new Set(existing.map((row) => row.name));
  const missing = supplierNames
    .filter((name) => !existingNames.has(name))
    .map((name) => ({
      name,
      notes: "Production bootstrap from docs/current-data/purchases.csv",
    }));

  const inserted = await insertRows(supabase, "suppliers", missing);
  const finalRows = dryRun
    ? [...existing, ...missing.map((supplier) => ({ id: `dry-run-supplier-${supplier.name}`, name: supplier.name }))]
    : await fetchByIn(supabase, "suppliers", "id, name", "name", supplierNames);

  return {
    supplierByName: new Map(finalRows.map((supplier) => [supplier.name, supplier])),
    stats: {
      sourceRows: supplierNames.length,
      inserted,
      skippedExisting: supplierNames.length - missing.length,
    },
  };
}

async function getTeamMemberByEmail(supabase, purchaseRows) {
  const emails = [...new Set(purchaseRows.map((row) => cleanText(row.operator_email).toLowerCase()).filter(Boolean))];
  if (!emails.length) return new Map();
  const rows = await fetchByIn(supabase, "team_members", "id, email", "email", emails);
  return new Map(rows.filter((row) => row.email).map((row) => [String(row.email).toLowerCase(), row]));
}

function groupPurchaseRows(purchaseRows, productBySku) {
  const groups = new Map();
  let skippedInvalidRows = 0;
  let skippedUnknownProductRows = 0;

  for (const row of purchaseRows) {
    const purchaseId = cleanText(row.purchase_id);
    const product = productBySku.get(cleanText(row.item_id));
    const totalUnits = Math.max(0, toInteger(row.qty_pieces));
    const unitCost = roundUnitCost(row.unit_cost);

    if (!purchaseId || totalUnits <= 0) {
      skippedInvalidRows += 1;
      continue;
    }

    if (!product) {
      skippedUnknownProductRows += 1;
      continue;
    }

    if (!groups.has(purchaseId)) {
      groups.set(purchaseId, {
        sourceId: purchaseId,
        firstRow: row,
        lines: [],
      });
    }

    const group = groups.get(purchaseId);
    const lineTotal = roundMoney(totalUnits * unitCost);
    group.lines.push({
      product_id: product.id,
      boxes_qty: 0,
      units_per_box: 1,
      loose_units_qty: totalUnits,
      total_units: totalUnits,
      ordered_qty: totalUnits,
      received_qty: totalUnits,
      unit_cost: unitCost,
      unit_cost_lyd: unitCost,
      line_total: lineTotal,
      line_total_lyd: lineTotal,
    });
  }

  return {
    groups: [...groups.values()].filter((group) => group.lines.length),
    skippedInvalidRows,
    skippedUnknownProductRows,
  };
}

function purchaseOrderPayload(group, supplierByName, teamMemberByEmail) {
  const row = group.firstRow;
  const supplierName = nullableText(row.supplier);
  const supplier = supplierName ? supplierByName.get(supplierName) : null;
  const operatorEmail = cleanText(row.operator_email).toLowerCase();
  const teamMember = operatorEmail ? teamMemberByEmail.get(operatorEmail) : null;
  const orderDate = cleanText(row.datetime).slice(0, 10) || new Date().toISOString().slice(0, 10);
  const calculatedTotal = roundMoney(group.lines.reduce((sum, line) => sum + Number(line.line_total_lyd ?? 0), 0));
  const sourceCalculatedTotal = toNumber(row.calculated_total);
  const finalCalculatedTotal = sourceCalculatedTotal > 0 ? roundMoney(sourceCalculatedTotal) : calculatedTotal;
  const receiptTotal = toNumber(row.receipt_total);
  const manualTotal = receiptTotal > 0 ? roundMoney(receiptTotal) : null;
  const sourceReceiptPhoto = nullableText(row.receipt_photo);
  const sourceNotes = nullableText(row.notes);
  const notes = [
    `production_bootstrap:purchase:source_id=${group.sourceId}:source=${purchasesSourceFile}`,
    operatorEmail ? `operator_email=${operatorEmail}` : null,
    sourceReceiptPhoto ? `source_receipt_photo=${sourceReceiptPhoto}` : null,
    sourceNotes ? `source_notes=${sourceNotes}` : null,
    "Historical purchase import; current inventory is represented by storage opening balance movements.",
  ].filter(Boolean).join("\n");

  return {
    supplier_id: supplier?.id ?? null,
    status: "received",
    order_date: orderDate,
    received_date: orderDate,
    receipt_number: group.sourceId,
    payment_method: "cash",
    payment_status: "paid",
    receipt_url: null,
    total_amount: manualTotal ?? finalCalculatedTotal,
    manual_total_lyd: manualTotal,
    calculated_total_lyd: finalCalculatedTotal,
    total_adjustment_lyd: manualTotal === null ? null : roundMoney(manualTotal - finalCalculatedTotal),
    total_source: manualTotal === null ? "calculated" : "manual",
    created_by: teamMember?.id ?? null,
    received_by: teamMember?.id ?? null,
    received_at: `${orderDate}T00:00:00.000Z`,
    notes,
  };
}

async function importPurchases(supabase, purchaseRows, productBySku) {
  const suppliers = await ensureSuppliers(supabase, purchaseRows);
  const teamMemberByEmail = await getTeamMemberByEmail(supabase, purchaseRows);
  const grouped = groupPurchaseRows(purchaseRows, productBySku);
  const orderPayloads = grouped.groups.map((group) => ({
    group,
    payload: purchaseOrderPayload(group, suppliers.supplierByName, teamMemberByEmail),
  }));

  const existingOrders = await fetchByIn(
    supabase,
    "purchase_orders",
    "id, receipt_number",
    "receipt_number",
    orderPayloads.map((entry) => entry.payload.receipt_number),
  );
  const existingReceiptNumbers = new Set(existingOrders.map((order) => order.receipt_number));
  const missingOrders = orderPayloads
    .filter((entry) => !existingReceiptNumbers.has(entry.payload.receipt_number))
    .map((entry) => entry.payload);

  const insertedOrders = await insertRows(supabase, "purchase_orders", missingOrders);
  const allOrders = dryRun
    ? [
        ...existingOrders,
        ...missingOrders.map((order) => ({ id: `dry-run-purchase-${order.receipt_number}`, receipt_number: order.receipt_number })),
      ]
    : await fetchByIn(
        supabase,
        "purchase_orders",
        "id, receipt_number",
        "receipt_number",
        orderPayloads.map((entry) => entry.payload.receipt_number),
      );
  const orderByReceiptNumber = new Map(allOrders.map((order) => [order.receipt_number, order]));
  const lineLookupOrders = dryRun ? existingOrders : allOrders;
  const existingLines = await fetchByIn(
    supabase,
    "purchase_order_lines",
    "id, purchase_order_id, line_position",
    "purchase_order_id",
    lineLookupOrders.map((order) => order.id),
  );
  const existingLineKeys = new Set(existingLines.map((line) => `${line.purchase_order_id}::${line.line_position}`));
  const lineRows = [];

  for (const entry of orderPayloads) {
    const order = orderByReceiptNumber.get(entry.payload.receipt_number);
    if (!order) continue;

    entry.group.lines.forEach((line, index) => {
      const key = `${order.id}::${index}`;
      if (existingLineKeys.has(key)) return;
      lineRows.push({
        purchase_order_id: order.id,
        line_position: index,
        ...line,
      });
    });
  }

  return {
    sourceRows: purchaseRows.length,
    sourcePurchases: grouped.groups.length,
    suppliers: suppliers.stats,
    purchaseOrdersInserted: insertedOrders,
    purchaseOrdersSkippedExisting: orderPayloads.length - missingOrders.length,
    purchaseLinesInserted: await insertRows(supabase, "purchase_order_lines", lineRows),
    purchaseLinesSkippedExisting: orderPayloads.reduce((sum, entry) => sum + entry.group.lines.length, 0) - lineRows.length,
    skippedInvalidRows: grouped.skippedInvalidRows,
    skippedUnknownProductRows: grouped.skippedUnknownProductRows,
  };
}

async function getProductBySku(supabase, productRows) {
  const skus = productRows.map((row) => cleanText(row.sku || row.product_id)).filter(Boolean);
  const products = await fetchByIn(supabase, "products", "id, sku", "sku", skus);
  return new Map(products.map((product) => [product.sku, product]));
}

async function loadSourceFiles() {
  const [products, machines, machinePlanograms, storageInventory, financeTransactions, vmsMappings, purchases] = await Promise.all([
    readCurrentDataCsv("products"),
    readCurrentDataCsv("machines"),
    readCurrentDataCsv("machine_planograms"),
    readCurrentDataCsv("storage_inventory"),
    readCurrentDataCsv("financial_transactions"),
    readCurrentDataCsv("vms_product_mappings"),
    readCurrentDataCsv("purchases"),
  ]);

  return { products, machines, machinePlanograms, storageInventory, financeTransactions, vmsMappings, purchases };
}

function printCheckFilesSummary(files) {
  const openingBalances = aggregateOpeningBalances(files.storageInventory);
  console.log("Current data files parsed successfully.");
  console.table({
    products: files.products.length,
    machines: files.machines.length,
    machine_planograms: files.machinePlanograms.length,
    storage_inventory_rows: files.storageInventory.length,
    storage_positive_opening_products: openingBalances.filter((row) => row.quantity > 0).length,
    financial_transactions: files.financeTransactions.length,
    vms_product_mappings: files.vmsMappings.length,
    purchase_rows: files.purchases.length,
    purchases: new Set(files.purchases.map((row) => cleanText(row.purchase_id)).filter(Boolean)).size,
  });
}

async function main() {
  if (args.has("--help") || args.has("-h")) {
    console.log(usage());
    return;
  }

  const files = await loadSourceFiles();
  if (checkFilesOnly) {
    printCheckFilesSummary(files);
    return;
  }

  if (!dryRun && !confirmed) {
    throw new Error("Refusing to write. Re-run with --confirm-production-bootstrap after reviewing docs/PRODUCTION_BOOTSTRAP.md.");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running production bootstrap.");
  }
  if (isLocalSupabaseUrl(supabaseUrl) && !allowLocal) {
    throw new Error("This is a production bootstrap script. Refusing local Supabase URL unless --allow-local is provided.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const summary = {};

  const locations = await ensureLocations(supabase, files.machines);
  summary.locations = locations.stats;
  summary.products = await importProducts(supabase, files.products);

  const productBySku = dryRun
    ? new Map()
    : await getProductBySku(supabase, files.products);

  if (dryRun) {
    for (const row of files.products.map(productPayload)) {
      productBySku.set(row.sku, { id: "dry-run-product-id", sku: row.sku });
    }
  }

  summary.machines = await importMachines(supabase, files.machines, locations.locationByName);
  summary.vmsProductMappings = await importVmsMappings(supabase, files.vmsMappings, productBySku);
  const machineByVmsId = await getMachineByVmsId(supabase, files.machines);
  const productByVmsProductId = buildProductByVmsProductId(files.vmsMappings, productBySku);
  summary.machinePlanograms = await importMachinePlanograms(supabase, files.machinePlanograms, machineByVmsId, productByVmsProductId);
  summary.storageOpeningBalances = await importStorageOpeningBalances(supabase, files.storageInventory, productBySku);
  summary.purchases = await importPurchases(supabase, files.purchases, productBySku);
  summary.financialTransactions = await importFinanceTransactions(supabase, files.financeTransactions);

  console.log(dryRun ? "Production bootstrap dry run complete." : "Production bootstrap complete.");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error("");
  console.error(usage());
  process.exit(1);
});
