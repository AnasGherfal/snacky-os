import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const dataDir = path.join("docs", "current-data");
const financeSourceFile = "docs/current-data/financial_transactions.csv";
const financeSourceSheet = "production_bootstrap_financial_transactions";
const storageSourceFile = "docs/current-data/storage_inventory.csv";
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

function toNumber(value, fallback = 0) {
  const numeric = Number(cleanText(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInteger(value, fallback = 0) {
  const numeric = Math.round(toNumber(value, fallback));
  return Number.isFinite(numeric) ? numeric : fallback;
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
      const vmsProductId = cleanText(row.vms_product_number);
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

async function getProductBySku(supabase, productRows) {
  const skus = productRows.map((row) => cleanText(row.sku || row.product_id)).filter(Boolean);
  const products = await fetchByIn(supabase, "products", "id, sku", "sku", skus);
  return new Map(products.map((product) => [product.sku, product]));
}

async function loadSourceFiles() {
  const [products, machines, storageInventory, financeTransactions, vmsMappings] = await Promise.all([
    readCurrentDataCsv("products"),
    readCurrentDataCsv("machines"),
    readCurrentDataCsv("storage_inventory"),
    readCurrentDataCsv("financial_transactions"),
    readCurrentDataCsv("vms_product_mappings"),
  ]);

  return { products, machines, storageInventory, financeTransactions, vmsMappings };
}

function printCheckFilesSummary(files) {
  const openingBalances = aggregateOpeningBalances(files.storageInventory);
  console.log("Current data files parsed successfully.");
  console.table({
    products: files.products.length,
    machines: files.machines.length,
    storage_inventory_rows: files.storageInventory.length,
    storage_positive_opening_products: openingBalances.filter((row) => row.quantity > 0).length,
    financial_transactions: files.financeTransactions.length,
    vms_product_mappings: files.vmsMappings.length,
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
  summary.storageOpeningBalances = await importStorageOpeningBalances(supabase, files.storageInventory, productBySku);
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
