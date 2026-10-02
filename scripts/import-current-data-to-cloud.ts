import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SourceRow = {
  sourceFile: string;
  sourceRow: number;
  values: Record<string, string>;
};

type DbPayload = Record<string, unknown>;
type DbRow = Record<string, unknown>;
type WriteEntry = {
  payload: DbPayload;
  sourceRow?: SourceRow;
  syntheticId?: string;
};

type TableStats = {
  rowsRead: number;
  rowsImported: number;
  rowsSkipped: number;
  skippedExisting: number;
  errors: string[];
};

type ProductRef = {
  id: string;
  sku: string;
  name?: string | null;
  case_quantity?: number | null;
};

type MachineRef = {
  id: string;
  machine_code: string;
  vms_machine_id?: string | null;
  name?: string | null;
};

type PurchaseOrderRef = {
  id: string;
  sourceId: string;
  supplier_id?: string | null;
};

type PurchaseLineRef = {
  id: string;
  sourcePurchaseId: string;
  productSku: string;
  product_id: string;
  total_units: number;
  unit_cost_lyd: number;
  line_total_lyd: number;
};

type PurchaseGroup = {
  sourceId: string;
  orderRow: SourceRow;
  lineRows: SourceRow[];
};

type CurrentDataFiles = {
  locations: SourceRow[];
  suppliers: SourceRow[];
  products: SourceRow[];
  machines: SourceRow[];
  storageInventory: SourceRow[];
  storageLocations: SourceRow[];
  vmsMappings: SourceRow[];
  machineSlots: SourceRow[];
  purchaseOrders: SourceRow[];
  purchaseLines: SourceRow[];
  purchasesAreCombined: boolean;
  financialTransactions: SourceRow[];
  loadedFiles: string[];
};

const DEFAULT_DATA_DIR = path.join("docs", "current-data");
const BATCH_SIZE = 200;
const TRIPOLI_OFFSET = "+02:00";
const FINANCE_SOURCE_SHEET = "production_bootstrap_financial_transactions";
const FINANCE_SOURCE_FILE = "docs/current-data/financial_transactions.csv";
const INVENTORY_IMPORT_PREFIX = "current_data_import:inventory:";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowLocal = args.includes("--allow-local");
const dataDir = optionValue("--data-dir") ?? DEFAULT_DATA_DIR;
const skippedRows: Array<{ table: string; file?: string; row?: number; reason: string }> = [];
const summary: Record<string, TableStats> = {};

function optionValue(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  return [
    "Usage:",
    "  npx tsx scripts/import-current-data-to-cloud.ts --dry-run",
    "  npx tsx scripts/import-current-data-to-cloud.ts",
    "",
    "Environment:",
    "  CLOUD_SUPABASE_URL",
    "  CLOUD_SUPABASE_SERVICE_ROLE_KEY",
    "",
    "Options:",
    "  --dry-run       Parse and validate, but do not write.",
    "  --data-dir DIR  Defaults to docs/current-data.",
    "  --allow-local   Allow localhost Supabase URLs for rehearsal.",
  ].join("\n");
}

function statsFor(table: string): TableStats {
  if (!summary[table]) {
    summary[table] = {
      rowsRead: 0,
      rowsImported: 0,
      rowsSkipped: 0,
      skippedExisting: 0,
      errors: [],
    };
  }
  return summary[table];
}

function addRowsRead(table: string, count: number) {
  statsFor(table).rowsRead += count;
}

function skipRow(table: string, row: SourceRow | undefined, reason: string) {
  const stats = statsFor(table);
  stats.rowsSkipped += 1;
  skippedRows.push({
    table,
    file: row?.sourceFile,
    row: row?.sourceRow,
    reason,
  });
}

function recordError(table: string, message: string) {
  statsFor(table).errors.push(message);
}

function parseEnvValue(value: string) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadEnvFile(filename: string) {
  try {
    const text = await readFile(path.join(process.cwd(), filename), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = parseEnvValue(trimmed.slice(separatorIndex + 1));
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function normalizeHeader(header: string) {
  return header
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsv(text: string, sourceFile: string): SourceRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      value += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cells, index) => ({
    sourceFile,
    sourceRow: index + 2,
    values: Object.fromEntries(headers.map((header, headerIndex) => [header, cells[headerIndex] ?? ""])),
  }));
}

function normalizeFileKey(filename: string) {
  return filename.toLowerCase();
}

async function readCsvCandidates(fileByKey: Map<string, string>, candidates: string[]) {
  for (const candidate of candidates) {
    const filename = fileByKey.get(normalizeFileKey(candidate));
    if (!filename) continue;
    const filePath = path.join(dataDir, filename);
    return parseCsv(await readFile(filePath, "utf8"), filename);
  }
  return [];
}

async function loadCurrentDataFiles(): Promise<CurrentDataFiles> {
  const filenames = (await readdir(dataDir)).filter((filename) => filename.toLowerCase().endsWith(".csv"));
  const fileByKey = new Map(filenames.map((filename) => [normalizeFileKey(filename), filename]));
  const [
    locations,
    suppliers,
    products,
    machines,
    storageLocations,
    normalizedVmsMappings,
    rawVmsMappings,
    machineSlots,
    combinedPurchases,
    splitPurchaseOrders,
    splitPurchaseLines,
    storageInventory,
    inventory,
    inventoryOld,
    financialTransactions,
  ] = await Promise.all([
    readCsvCandidates(fileByKey, ["locations.csv"]),
    readCsvCandidates(fileByKey, ["suppliers.csv"]),
    readCsvCandidates(fileByKey, ["products.csv", "Items - Items.csv"]),
    readCsvCandidates(fileByKey, ["machines.csv", "Items - Machines.csv"]),
    readCsvCandidates(fileByKey, ["storage_locations.csv"]),
    readCsvCandidates(fileByKey, ["vms_product_mappings.csv"]),
    readCsvCandidates(fileByKey, ["Items - Item_Mapping.csv"]),
    readCsvCandidates(fileByKey, ["machine_slots.csv", "machine_planograms.csv"]),
    readCsvCandidates(fileByKey, ["purchases.csv"]),
    readCsvCandidates(fileByKey, ["Items - Purchases.csv"]),
    readCsvCandidates(fileByKey, ["Items - PurchaseLines.csv"]),
    readCsvCandidates(fileByKey, ["storage_inventory.csv"]),
    readCsvCandidates(fileByKey, ["Items - Inventory.csv"]),
    readCsvCandidates(fileByKey, ["Items - Inventory_Old.csv"]),
    readCsvCandidates(fileByKey, ["financial_transactions.csv"]),
  ]);

  const allStorageInventory = [...storageInventory, ...inventoryOld, ...inventory];
  const hasSplitPurchases = splitPurchaseOrders.length > 0 || splitPurchaseLines.length > 0;
  const allPurchaseOrders = hasSplitPurchases ? splitPurchaseOrders : combinedPurchases;
  const allPurchaseLines = splitPurchaseLines.length > 0 ? splitPurchaseLines : combinedPurchases;
  const purchasesAreCombined = !hasSplitPurchases && combinedPurchases.length > 0;
  const allVmsMappings = [...normalizedVmsMappings, ...rawVmsMappings];
  return {
    locations,
    suppliers,
    products,
    machines,
    storageLocations,
    storageInventory: allStorageInventory,
    vmsMappings: allVmsMappings,
    machineSlots,
    purchaseOrders: allPurchaseOrders,
    purchaseLines: allPurchaseLines,
    purchasesAreCombined,
    financialTransactions,
    loadedFiles: filenames,
  };
}

function maybeFixMojibake(value: string | null) {
  if (!value || !/[ÃØÙ]/.test(value)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return decoded.includes("�") ? value : decoded;
}

function cleanValue(value: unknown, options: { fixEncoding?: boolean } = {}) {
  const text = String(value ?? "").trim();
  if (!text || text.toUpperCase() === "TO_CONFIRM" || text.toLowerCase() === "nan") return null;
  return options.fixEncoding === false ? text : maybeFixMojibake(text);
}

function cell(row: SourceRow, ...names: string[]) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (row.values[key] !== undefined) return row.values[key];
  }
  return "";
}

function text(row: SourceRow, ...names: string[]) {
  return cleanValue(cell(row, ...names));
}

function normalizeExternalId(value: unknown) {
  const cleaned = cleanValue(value, { fixEncoding: false });
  if (!cleaned) return null;
  if (/^\d+\.0+$/.test(cleaned)) return cleaned.split(".")[0];
  return cleaned;
}

function normalizeKey(value: unknown) {
  return cleanValue(value)?.toLowerCase().replace(/\s+/g, " ") ?? null;
}

function isUrl(value: string | null) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function numberValue(value: unknown, fallback = 0) {
  const cleaned = cleanValue(value, { fixEncoding: false });
  if (!cleaned) return fallback;
  const parsed = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerValue(value: unknown, fallback = 0) {
  const parsed = Math.round(numberValue(value, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function roundUnitCost(value: number) {
  return Math.round(value * 10000) / 10000;
}

function parseDateTime(value: unknown) {
  const raw = cleanValue(value, { fixEncoding: false });
  if (!raw) return null;

  const mdyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (mdyMatch) {
    const [, month, day, year, hour = "0", minute = "0", second = "0"] = mdyMatch;
    const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}${TRIPOLI_OFFSET}`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const normalized = dateOnlyMatch ? `${raw}T00:00:00${TRIPOLI_OFFSET}` : raw.replace(" ", "T");
  const withOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}${TRIPOLI_OFFSET}`;
  const date = new Date(withOffset);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDateOnly(value: unknown) {
  const raw = cleanValue(value, { fixEncoding: false });
  if (!raw) return null;

  const mdyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (mdyMatch) {
    const [, month, day, year] = mdyMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const ymdMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/);
  if (ymdMatch) {
    const [, year, month, day] = ymdMatch;
    return `${year}-${month}-${day}`;
  }

  const parsed = parseDateTime(value);
  return parsed ? parsed.slice(0, 10) : null;
}

function purchaseDate(row: SourceRow) {
  return parseDateOnly(cell(row, "datetime", "date_time", "date", "order_date", "received_date"));
}

function completenessScore(row: SourceRow) {
  return Object.values(row.values).filter((value) => cleanValue(value) !== null).length;
}

function dedupeRows(table: string, rows: SourceRow[], keyName: string, keyFn: (row: SourceRow) => string | null) {
  const winners = new Map<string, SourceRow>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) {
      skipRow(table, row, `missing ${keyName}`);
      continue;
    }

    const current = winners.get(key);
    if (!current) {
      winners.set(key, row);
      continue;
    }

    if (completenessScore(row) > completenessScore(current)) {
      skipRow(table, current, `duplicate ${keyName} "${key}"; kept row ${row.sourceRow} because it is more complete`);
      winners.set(key, row);
    } else {
      skipRow(table, row, `duplicate ${keyName} "${key}"; kept row ${current.sourceRow}`);
    }
  }
  return [...winners.values()];
}

function chunks<T>(values: T[], size = BATCH_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function fetchByIn(supabase: SupabaseClient, table: string, select: string, column: string, values: string[]) {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  const rows: DbRow[] = [];
  for (const group of chunks(uniqueValues)) {
    const { data, error } = await supabase.from(table).select(select).in(column, group);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as unknown as DbRow[]));
  }
  return rows;
}

function dbString(row: DbRow, column: string) {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
}

async function writeEntries(
  supabase: SupabaseClient,
  table: string,
  entries: WriteEntry[],
  options: { mode: "insert" | "upsert"; onConflict?: string; select?: string },
) {
  const stats = statsFor(table);
  if (!entries.length) return [] as DbRow[];
  if (dryRun) {
    stats.rowsImported += entries.length;
    return entries.map((entry, index) => ({
      ...entry.payload,
      id: entry.syntheticId ?? `dry-run-${table}-${index + 1}`,
    }));
  }

  const written: DbRow[] = [];
  for (const group of chunks(entries)) {
    const payloads = group.map((entry) => entry.payload);
    const query = options.mode === "upsert"
      ? supabase.from(table).upsert(payloads, { onConflict: options.onConflict }).select(options.select ?? "*")
      : supabase.from(table).insert(payloads).select(options.select ?? "*");
    const { data, error } = await query;

    if (!error) {
      stats.rowsImported += group.length;
      written.push(...((data ?? []) as unknown as DbRow[]));
      continue;
    }

    recordError(table, `batch ${options.mode} failed; retrying rows individually: ${error.message}`);
    for (const entry of group) {
      const singleQuery = options.mode === "upsert"
        ? supabase.from(table).upsert(entry.payload, { onConflict: options.onConflict }).select(options.select ?? "*")
        : supabase.from(table).insert(entry.payload).select(options.select ?? "*");
      const { data: singleData, error: singleError } = await singleQuery;
      if (singleError) {
        recordError(table, singleError.message);
        skipRow(table, entry.sourceRow, `database error: ${singleError.message}`);
        continue;
      }
      stats.rowsImported += 1;
      written.push(...((singleData ?? []) as unknown as DbRow[]));
    }
  }
  return written;
}

async function updateRowById(
  supabase: SupabaseClient,
  table: string,
  id: string,
  payload: DbPayload,
  sourceRow?: SourceRow,
) {
  if (dryRun) {
    statsFor(table).rowsImported += 1;
    return true;
  }
  const { error } = await supabase.from(table).update(payload).eq("id", id);
  if (error) {
    recordError(table, error.message);
    skipRow(table, sourceRow, `database error: ${error.message}`);
    return false;
  }
  statsFor(table).rowsImported += 1;
  return true;
}

function productPayload(row: SourceRow): DbPayload | null {
  const sku = normalizeExternalId(cell(row, "sku", "product_id", "item_id"));
  if (!sku) return null;
  const name = text(row, "name", "product_name", "item_name", "appsheet_item_name", "app_sheet_item_name") ?? sku;
  const sellingPrice = Math.max(0, numberValue(cell(row, "selling_price", "sale_price", "price"), 0));
  const costPrice = Math.max(0, numberValue(cell(row, "purchase_price", "cost_price", "unit_cost"), 0));
  const caseQuantity = Math.max(1, integerValue(cell(row, "units_per_box", "case_quantity", "pack_size"), 1));
  const image = text(row, "image", "image_url");

  return {
    sku,
    barcode: text(row, "barcode"),
    name,
    category: text(row, "product_group", "category") ?? "snack",
    brand: text(row, "brand"),
    supplier_id: null,
    cost_price: costPrice,
    selling_price: sellingPrice,
    current_cost_price_lyd: costPrice,
    current_selling_price_lyd: sellingPrice,
    cost_price_source: "initial_import",
    selling_price_source: "initial_import",
    case_quantity: caseQuantity,
    image_url: isUrl(image) ? image : null,
    expiry_sensitive: true,
    active: true,
    import_source: "current_data_import",
    updated_at: new Date().toISOString(),
  };
}

function buildProductImportRows(files: CurrentDataFiles) {
  const rows = [...files.products];
  const existingSkus = new Set(rows.map((row) => normalizeExternalId(cell(row, "sku", "product_id", "item_id"))).filter(Boolean));
  const placeholders = new Map<string, SourceRow>();

  const addPlaceholder = (sourceRow: SourceRow, sku: string | null, name?: string | null) => {
    if (!sku || existingSkus.has(sku) || placeholders.has(sku)) return;
    placeholders.set(sku, {
      sourceFile: sourceRow.sourceFile,
      sourceRow: sourceRow.sourceRow,
      values: {
        sku,
        product_id: sku,
        name: name ?? `Imported item ${sku}`,
        product_group: "needs_review",
        purchase_price: "0",
        selling_price: "0",
        units_per_box: "1",
      },
    });
  };

  for (const row of files.storageInventory) {
    addPlaceholder(row, normalizeExternalId(cell(row, "item_id", "product_id", "sku")));
  }
  for (const row of files.purchaseLines) {
    addPlaceholder(row, normalizeExternalId(cell(row, "item_id", "product_id", "sku")));
  }
  for (const row of files.vmsMappings) {
    addPlaceholder(
      row,
      normalizeExternalId(cell(row, "appsheet_item_id", "app_sheet_item_id", "item_id", "sku", "product_id")),
      text(row, "appsheet_item_name", "app_sheet_item_name"),
    );
  }

  rows.push(...placeholders.values());
  return rows;
}

async function importProducts(supabase: SupabaseClient, rows: SourceRow[]) {
  const table = "products";
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "sku", (row) => normalizeExternalId(cell(row, "sku", "product_id", "item_id")));
  const entries = deduped.flatMap((row) => {
    const payload = productPayload(row);
    if (!payload) {
      skipRow(table, row, "missing sku or product id");
      return [];
    }
    return [{ payload, sourceRow: row, syntheticId: `dry-run-product-${String(payload.sku)}` }];
  });

  await writeEntries(supabase, table, entries, { mode: "upsert", onConflict: "sku", select: "id, sku, name, case_quantity" });
  const skus = entries.map((entry) => String(entry.payload.sku));
  const existing = dryRun ? await fetchByIn(supabase, table, "id, sku, name, case_quantity", "sku", skus) : await fetchByIn(supabase, table, "id, sku, name, case_quantity", "sku", skus);
  const productBySku = new Map<string, ProductRef>();

  for (const row of existing) {
    const sku = dbString(row, "sku");
    const id = dbString(row, "id");
    if (sku && id) {
      productBySku.set(sku, {
        id,
        sku,
        name: dbString(row, "name"),
        case_quantity: Number(row.case_quantity ?? 1),
      });
    }
  }

  if (dryRun) {
    for (const entry of entries) {
      const sku = String(entry.payload.sku);
      if (!productBySku.has(sku)) {
        productBySku.set(sku, {
          id: `dry-run-product-${sku}`,
          sku,
          name: String(entry.payload.name ?? sku),
          case_quantity: Number(entry.payload.case_quantity ?? 1),
        });
      }
    }
  }

  return productBySku;
}

function locationPayload(row: SourceRow, derivedName?: string): DbPayload | null {
  const name = derivedName ?? text(row, "name", "location", "location_name");
  if (!name) return null;
  return {
    name,
    location_type: text(row, "location_type", "type") ?? "other",
    address: text(row, "address") ?? name,
    contact_name: text(row, "contact_name", "contact"),
    contact_phone: text(row, "contact_phone", "phone"),
    rent_amount: Math.max(0, numberValue(cell(row, "rent_amount"), 0)),
    rent_type: text(row, "rent_type") ?? "monthly_fixed",
    contract_start: parseDateOnly(cell(row, "contract_start")),
    contract_end: parseDateOnly(cell(row, "contract_end")),
    status: text(row, "status") ?? "active",
    notes: text(row, "notes") ?? "Imported from docs/current-data.",
    updated_at: new Date().toISOString(),
  };
}

function deriveLocationRows(files: CurrentDataFiles) {
  if (files.locations.length) return files.locations;
  const seen = new Set<string>();
  const derived: SourceRow[] = [];
  for (const row of files.machines) {
    const name = text(row, "location", "location_name");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    derived.push({
      sourceFile: row.sourceFile,
      sourceRow: row.sourceRow,
      values: { name, address: name, notes: "Derived from machines.csv location column." },
    });
  }
  return derived;
}

async function importLocations(supabase: SupabaseClient, files: CurrentDataFiles) {
  const table = "locations";
  const rows = deriveLocationRows(files);
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "name", (row) => text(row, "name", "location", "location_name"));
  const payloadRows = deduped.flatMap((row) => {
    const payload = locationPayload(row);
    if (!payload) {
      skipRow(table, row, "missing location name");
      return [];
    }
    return [{ row, payload }];
  });
  const names = payloadRows.map((entry) => String(entry.payload.name));
  const existing = await fetchByIn(supabase, table, "id, name", "name", names);
  const existingByName = new Map(existing.map((row) => [dbString(row, "name"), row]));
  const missing = payloadRows.filter((entry) => !existingByName.has(String(entry.payload.name)));

  const inserted = await writeEntries(
    supabase,
    table,
    missing.map((entry) => ({ payload: entry.payload, sourceRow: entry.row, syntheticId: `dry-run-location-${entry.payload.name}` })),
    { mode: "insert", select: "id, name" },
  );
  statsFor(table).skippedExisting += payloadRows.length - missing.length;

  const locationByName = new Map<string, string>();
  for (const row of [...existing, ...inserted]) {
    const name = dbString(row, "name");
    const id = dbString(row, "id");
    if (name && id) locationByName.set(name, id);
  }
  if (dryRun) {
    for (const entry of missing) {
      locationByName.set(String(entry.payload.name), `dry-run-location-${entry.payload.name}`);
    }
  }
  return locationByName;
}

function deriveSupplierRows(files: CurrentDataFiles) {
  if (files.suppliers.length) return files.suppliers;
  const seen = new Set<string>();
  const derived: SourceRow[] = [];
  for (const row of files.purchaseOrders) {
    const name = text(row, "supplier");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    derived.push({
      sourceFile: row.sourceFile,
      sourceRow: row.sourceRow,
      values: { name, notes: "Derived from purchases CSV supplier column." },
    });
  }
  return derived;
}

function supplierPayload(row: SourceRow): DbPayload | null {
  const name = text(row, "name", "supplier");
  if (!name) return null;
  return {
    name,
    contact_name: text(row, "contact_name", "contact"),
    phone: text(row, "phone", "contact_phone"),
    payment_terms: text(row, "payment_terms"),
    usual_delivery_days: Math.max(1, integerValue(cell(row, "usual_delivery_days"), 1)),
    notes: text(row, "notes") ?? "Imported from docs/current-data.",
  };
}

async function importSuppliers(supabase: SupabaseClient, files: CurrentDataFiles) {
  const table = "suppliers";
  const rows = deriveSupplierRows(files);
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "name", (row) => text(row, "name", "supplier"));
  const payloadRows = deduped.flatMap((row) => {
    const payload = supplierPayload(row);
    if (!payload) {
      skipRow(table, row, "missing supplier name");
      return [];
    }
    return [{ row, payload }];
  });
  const names = payloadRows.map((entry) => String(entry.payload.name));
  const existing = await fetchByIn(supabase, table, "id, name", "name", names);
  const existingByName = new Map(existing.map((row) => [dbString(row, "name"), row]));
  const missing = payloadRows.filter((entry) => !existingByName.has(String(entry.payload.name)));

  const inserted = await writeEntries(
    supabase,
    table,
    missing.map((entry) => ({ payload: entry.payload, sourceRow: entry.row, syntheticId: `dry-run-supplier-${entry.payload.name}` })),
    { mode: "insert", select: "id, name" },
  );
  statsFor(table).skippedExisting += payloadRows.length - missing.length;

  const supplierByName = new Map<string, DbRow>();
  for (const row of [...existing, ...inserted]) {
    const name = dbString(row, "name");
    if (name) supplierByName.set(name, row);
  }
  if (dryRun) {
    for (const entry of missing) {
      supplierByName.set(String(entry.payload.name), { id: `dry-run-supplier-${entry.payload.name}`, name: entry.payload.name });
    }
  }
  return supplierByName;
}

function machinePayload(row: SourceRow, locationByName: Map<string, string>): DbPayload | null {
  const vmsMachineId = normalizeExternalId(cell(row, "machine_id", "vms_machine_id"));
  const machineCode = text(row, "machine_code") ?? (vmsMachineId ? `SNK-${vmsMachineId}` : null);
  if (!machineCode) return null;
  const locationName = text(row, "location", "location_name");
  return {
    machine_code: machineCode,
    vms_machine_id: vmsMachineId,
    name: text(row, "machine_name", "name") ?? `Machine ${vmsMachineId ?? machineCode}`,
    machine_type: text(row, "machine_type") ?? "lift",
    location_id: locationName ? locationByName.get(locationName) ?? null : null,
    status: text(row, "status") ?? "active",
    serial_number: text(row, "serial_number"),
    installed_date: parseDateOnly(cell(row, "installed_date")),
    notes: text(row, "notes") ?? "Imported from docs/current-data/machines.csv.",
    vms_provider: text(row, "vms_provider"),
    vms_location_name: locationName,
    updated_at: new Date().toISOString(),
  };
}

async function importMachines(supabase: SupabaseClient, rows: SourceRow[], locationByName: Map<string, string>) {
  const table = "machines";
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "machine id", (row) => normalizeExternalId(cell(row, "machine_id", "vms_machine_id", "machine_code")));
  const entries = deduped.flatMap((row) => {
    const payload = machinePayload(row, locationByName);
    if (!payload) {
      skipRow(table, row, "missing machine id or machine code");
      return [];
    }
    return [{ payload, sourceRow: row, syntheticId: `dry-run-machine-${String(payload.machine_code)}` }];
  });
  await writeEntries(supabase, table, entries, { mode: "upsert", onConflict: "machine_code", select: "id, machine_code, vms_machine_id, name" });

  const machineCodes = entries.map((entry) => String(entry.payload.machine_code));
  const machines = await fetchByIn(supabase, table, "id, machine_code, vms_machine_id, name", "machine_code", machineCodes);
  const machineByCode = new Map<string, MachineRef>();
  const machineByVmsId = new Map<string, MachineRef>();

  for (const row of machines) {
    const id = dbString(row, "id");
    const code = dbString(row, "machine_code");
    if (!id || !code) continue;
    const machine = {
      id,
      machine_code: code,
      vms_machine_id: dbString(row, "vms_machine_id"),
      name: dbString(row, "name"),
    };
    machineByCode.set(code, machine);
    if (machine.vms_machine_id) machineByVmsId.set(machine.vms_machine_id, machine);
  }

  if (dryRun) {
    for (const entry of entries) {
      const code = String(entry.payload.machine_code);
      if (machineByCode.has(code)) continue;
      const machine = {
        id: `dry-run-machine-${code}`,
        machine_code: code,
        vms_machine_id: entry.payload.vms_machine_id === null ? null : String(entry.payload.vms_machine_id),
        name: String(entry.payload.name ?? code),
      };
      machineByCode.set(code, machine);
      if (machine.vms_machine_id) machineByVmsId.set(machine.vms_machine_id, machine);
    }
  }

  return { machineByCode, machineByVmsId };
}

function storageLocationNames(files: CurrentDataFiles) {
  if (files.storageLocations.length) {
    return files.storageLocations;
  }

  const seen = new Set<string>();
  const derived: SourceRow[] = [];
  const addName = (row: SourceRow, name: string | null) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    derived.push({
      sourceFile: row.sourceFile,
      sourceRow: row.sourceRow,
      values: {
        name,
        location_type: name.toUpperCase() === "MAIN" ? "main_storage" : "other",
        address: name,
        notes: "Derived from inventory CSV location columns.",
      },
    });
  };

  for (const row of files.storageInventory) {
    addName(row, text(row, "location_id"));
    addName(row, text(row, "from_location_id"));
    addName(row, text(row, "to_location_id"));
  }

  if (!seen.has("MAIN")) {
    derived.push({
      sourceFile: "derived",
      sourceRow: 0,
      values: {
        name: "MAIN",
        location_type: "main_storage",
        address: "Main storage",
        notes: "Default storage location for current data import.",
      },
    });
  }

  return derived;
}

function storageLocationPayload(row: SourceRow): DbPayload | null {
  const name = text(row, "name", "location_id", "storage_location");
  if (!name) return null;
  const type = text(row, "location_type", "type") ?? (name.toUpperCase() === "MAIN" ? "main_storage" : "other");
  return {
    name,
    address: text(row, "address") ?? name,
    active: cleanValue(cell(row, "active"), { fixEncoding: false })?.toLowerCase() !== "false",
    location_type: ["main_storage", "operator_bag", "vehicle", "damaged", "expired", "temporary", "other"].includes(type) ? type : "other",
    related_operator_id: null,
    updated_at: new Date().toISOString(),
  };
}

async function importStorageLocations(supabase: SupabaseClient, files: CurrentDataFiles) {
  const table = "storage_locations";
  const rows = storageLocationNames(files);
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "name", (row) => text(row, "name", "location_id", "storage_location"));
  const payloadRows = deduped.flatMap((row) => {
    const payload = storageLocationPayload(row);
    if (!payload) {
      skipRow(table, row, "missing storage location name");
      return [];
    }
    return [{ row, payload }];
  });
  const names = payloadRows.map((entry) => String(entry.payload.name));
  const existing = await fetchByIn(supabase, table, "id, name", "name", names);
  const existingByName = new Map(existing.map((row) => [dbString(row, "name"), row]));
  const missing = payloadRows.filter((entry) => !existingByName.has(String(entry.payload.name)));
  const inserted = await writeEntries(
    supabase,
    table,
    missing.map((entry) => ({ payload: entry.payload, sourceRow: entry.row, syntheticId: `dry-run-storage-${entry.payload.name}` })),
    { mode: "insert", select: "id, name" },
  );
  statsFor(table).skippedExisting += payloadRows.length - missing.length;

  const storageByName = new Map<string, string>();
  for (const row of [...existing, ...inserted]) {
    const name = dbString(row, "name");
    const id = dbString(row, "id");
    if (name && id) storageByName.set(name, id);
  }
  if (dryRun) {
    for (const entry of missing) {
      storageByName.set(String(entry.payload.name), `dry-run-storage-${entry.payload.name}`);
    }
  }
  return storageByName;
}

function vmsMappingPayload(row: SourceRow, productBySku: Map<string, ProductRef>): DbPayload | null {
  const vmsProductId = normalizeExternalId(cell(row, "vms_product_number", "vms_product_id"));
  const vmsProductName = text(row, "vms_product_name", "product_name");
  if (!vmsProductName) return null;
  const productSku = normalizeExternalId(cell(row, "appsheet_item_id", "app_sheet_item_id", "item_id", "sku", "product_id"));
  const product = productSku ? productBySku.get(productSku) : undefined;

  return {
    vms_product_id: vmsProductId,
    vms_product_name: vmsProductName,
    product_id: product?.id ?? null,
    match_status: product ? "confirmed" : "needs_review",
    vms_selling_price_lyd: numberValue(cell(row, "vms_selling_price_lyd", "selling_price"), 0) || null,
    vms_cost_price_lyd: numberValue(cell(row, "vms_cost_price_lyd", "cost_price"), 0) || null,
    vms_barcode: text(row, "vms_barcode", "barcode"),
    updated_at: new Date().toISOString(),
  };
}

async function importVmsMappings(supabase: SupabaseClient, rows: SourceRow[], productBySku: Map<string, ProductRef>) {
  const table = "vms_product_mappings";
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "vms product", (row) => {
    const id = normalizeExternalId(cell(row, "vms_product_number", "vms_product_id")) ?? "";
    const name = text(row, "vms_product_name", "product_name") ?? "";
    return id || name ? `${id}::${normalizeKey(name) ?? name}` : null;
  });
  const entries = deduped.flatMap((row) => {
    const payload = vmsMappingPayload(row, productBySku);
    if (!payload) {
      skipRow(table, row, "missing VMS product name");
      return [];
    }
    return [{ payload, sourceRow: row, syntheticId: `dry-run-vms-map-${payload.vms_product_id ?? payload.vms_product_name}` }];
  });

  await writeEntries(supabase, table, entries, {
    mode: "upsert",
    onConflict: "vms_product_id,vms_product_name",
    select: "id, vms_product_id, vms_product_name, product_id",
  });

  const productByVmsId = new Map<string, ProductRef>();
  for (const entry of entries) {
    const vmsId = entry.payload.vms_product_id === null || entry.payload.vms_product_id === undefined ? null : String(entry.payload.vms_product_id);
    const productId = entry.payload.product_id === null || entry.payload.product_id === undefined ? null : String(entry.payload.product_id);
    if (!vmsId || !productId) continue;
    const product = [...productBySku.values()].find((candidate) => candidate.id === productId);
    if (product) productByVmsId.set(vmsId, product);
  }
  return productByVmsId;
}

function machineSlotPayload(
  row: SourceRow,
  rowIndex: number,
  machines: { machineByCode: Map<string, MachineRef>; machineByVmsId: Map<string, MachineRef> },
  productBySku: Map<string, ProductRef>,
  productByVmsId: Map<string, ProductRef>,
): DbPayload | null {
  const machineKey = normalizeExternalId(cell(row, "machine_id", "vms_machine_id")) ?? text(row, "machine_code");
  const machine = machineKey ? machines.machineByVmsId.get(machineKey) ?? machines.machineByCode.get(machineKey) ?? machines.machineByCode.get(`SNK-${machineKey}`) : null;
  const productSku = normalizeExternalId(cell(row, "sku", "product_id", "item_id", "appsheet_item_id", "app_sheet_item_id"));
  const vmsProductId = normalizeExternalId(cell(row, "vms_product_number", "vms_product_id"));
  const product = (productSku ? productBySku.get(productSku) : undefined) ?? (vmsProductId ? productByVmsId.get(vmsProductId) : undefined);
  if (!machine || !product) return null;

  const capacity = Math.max(1, integerValue(cell(row, "capacity", "inventory_capacity", "par_qty", "inventory_quantity"), 1));
  const parSource = integerValue(cell(row, "par_level", "par_qty"), capacity);
  const parQty = Math.max(1, Math.min(capacity, parSource || capacity));
  const minSource = integerValue(cell(row, "min_level", "min_qty"), Math.floor(parQty * 0.25));
  const minQty = Math.max(0, Math.min(parQty, minSource));
  const slotCode = text(row, "slot_code") ?? `VMS-${vmsProductId ?? product.sku ?? rowIndex + 1}`;

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

async function importMachineSlots(
  supabase: SupabaseClient,
  rows: SourceRow[],
  machines: { machineByCode: Map<string, MachineRef>; machineByVmsId: Map<string, MachineRef> },
  productBySku: Map<string, ProductRef>,
  productByVmsId: Map<string, ProductRef>,
) {
  const table = "machine_slots";
  addRowsRead(table, rows.length);
  const payloadRows = rows.flatMap((row, index) => {
    const payload = machineSlotPayload(row, index, machines, productBySku, productByVmsId);
    if (!payload) {
      skipRow(table, row, "machine or product could not be matched");
      return [];
    }
    return [{ row, payload }];
  });

  const seen = new Map<string, { row: SourceRow; payload: DbPayload }>();
  for (const entry of payloadRows) {
    const key = `${entry.payload.machine_id}::${entry.payload.slot_code}`;
    const current = seen.get(key);
    if (!current) {
      seen.set(key, entry);
    } else if (completenessScore(entry.row) > completenessScore(current.row)) {
      skipRow(table, current.row, `duplicate machine slot "${key}"; kept row ${entry.row.sourceRow} because it is more complete`);
      seen.set(key, entry);
    } else {
      skipRow(table, entry.row, `duplicate machine slot "${key}"; kept row ${current.row.sourceRow}`);
    }
  }

  await writeEntries(
    supabase,
    table,
    [...seen.values()].map((entry) => ({
      payload: entry.payload,
      sourceRow: entry.row,
      syntheticId: `dry-run-slot-${entry.payload.machine_id}-${entry.payload.slot_code}`,
    })),
    { mode: "upsert", onConflict: "machine_id,slot_code", select: "id, machine_id, slot_code" },
  );
}

async function getTeamMemberByEmail(supabase: SupabaseClient, rows: SourceRow[]) {
  const emails = [...new Set(rows.map((row) => normalizeKey(cell(row, "operator_email", "email"))).filter((value): value is string => Boolean(value)))];
  const members = await fetchByIn(supabase, "team_members", "id, email", "email", emails);
  return new Map(members.flatMap((row) => {
    const email = normalizeKey(row.email);
    return email ? [[email, row] as const] : [];
  }));
}

function buildPurchaseGroups(files: CurrentDataFiles) {
  const groups = new Map<string, PurchaseGroup>();
  const orderRowsById = new Map<string, SourceRow>();

  for (const row of files.purchaseOrders) {
    const id = normalizeExternalId(cell(row, "purchase_id"));
    if (!id) continue;
    const current = orderRowsById.get(id);
    if (!current || completenessScore(row) > completenessScore(current)) orderRowsById.set(id, row);
  }

  for (const [id, row] of orderRowsById.entries()) {
    groups.set(id, { sourceId: id, orderRow: row, lineRows: [] });
  }

  for (const row of files.purchaseLines) {
    const id = normalizeExternalId(cell(row, "purchase_id"));
    if (!id) continue;
    if (!groups.has(id)) {
      groups.set(id, { sourceId: id, orderRow: row, lineRows: [] });
    }
    groups.get(id)?.lineRows.push(row);
  }

  return [...groups.values()];
}

function purchaseOrderPayload(
  group: PurchaseGroup,
  supplierByName: Map<string, DbRow>,
  teamMemberByEmail: Map<string, DbRow>,
) {
  const row = group.orderRow;
  const supplierName = text(row, "supplier");
  const supplier = supplierName ? supplierByName.get(supplierName) : null;
  const operatorEmail = normalizeKey(cell(row, "operator_email"));
  const teamMember = operatorEmail ? teamMemberByEmail.get(operatorEmail) : null;
  const orderDate = purchaseDate(row);
  if (!orderDate) return null;
  const sourceCalculatedTotal = roundMoney(numberValue(cell(row, "calculated_total"), 0));
  const sourceReceiptTotal = roundMoney(numberValue(cell(row, "receipt_total"), 0));
  const lineCalculatedTotal = roundMoney(group.lineRows.reduce((sum, line) => {
    const qty = Math.max(0, numberValue(cell(line, "qty_pieces", "received_units"), 0));
    const unitCost = Math.max(0, numberValue(cell(line, "unit_cost"), 0));
    return sum + qty * unitCost;
  }, 0));
  const calculatedTotal = sourceCalculatedTotal > 0 ? sourceCalculatedTotal : lineCalculatedTotal;
  const manualTotal = sourceReceiptTotal > 0 ? sourceReceiptTotal : null;
  const receiptPhoto = text(row, "receipt_photo");
  const sourceNotes = text(row, "notes");
  const notes = [
    `current_data_import:purchase:${group.sourceId}`,
    `source_file=${row.sourceFile}`,
    `source_row=${row.sourceRow}`,
    operatorEmail ? `operator_email=${operatorEmail}` : null,
    receiptPhoto ? `source_receipt_photo=${receiptPhoto}` : null,
    sourceNotes ? `source_notes=${sourceNotes}` : null,
  ].filter(Boolean).join("\n");

  return {
    supplier_id: dbString(supplier ?? {}, "id"),
    status: "received",
    order_date: orderDate,
    received_date: orderDate,
    receipt_number: group.sourceId,
    payment_method: "cash",
    payment_status: "paid",
    receipt_url: isUrl(receiptPhoto) ? receiptPhoto : null,
    total_amount: manualTotal ?? calculatedTotal,
    manual_total_lyd: manualTotal,
    calculated_total_lyd: calculatedTotal,
    total_adjustment_lyd: manualTotal === null ? null : roundMoney(manualTotal - calculatedTotal),
    total_source: manualTotal === null ? "calculated" : "manual",
    created_by: dbString(teamMember ?? {}, "id"),
    received_by: dbString(teamMember ?? {}, "id"),
    received_at: `${orderDate}T00:00:00.000Z`,
    notes,
    updated_at: new Date().toISOString(),
  };
}

async function importPurchaseOrders(
  supabase: SupabaseClient,
  groups: PurchaseGroup[],
  supplierByName: Map<string, DbRow>,
) {
  const table = "purchase_orders";
  addRowsRead(table, groups.length);
  const validGroups = groups.filter((group) => {
    if (!group.sourceId) {
      skipRow(table, group.orderRow, "missing purchase id");
      return false;
    }
    return true;
  });
  const teamMemberByEmail = await getTeamMemberByEmail(supabase, validGroups.map((group) => group.orderRow));
  const existingRows = await fetchByIn(supabase, table, "id, receipt_number, supplier_id", "receipt_number", validGroups.map((group) => group.sourceId));
  const existingByReceipt = new Map(existingRows.flatMap((row) => {
    const receipt = dbString(row, "receipt_number");
    return receipt ? [[receipt, row] as const] : [];
  }));
  const purchaseOrderBySourceId = new Map<string, PurchaseOrderRef>();

  for (const group of validGroups) {
    const payload = purchaseOrderPayload(group, supplierByName, teamMemberByEmail);
    if (!payload) {
      skipRow(table, group.orderRow, "missing/invalid purchase date");
      continue;
    }
    const existing = existingByReceipt.get(group.sourceId);
    if (existing) {
      const id = dbString(existing, "id");
      if (!id) {
        skipRow(table, group.orderRow, "existing purchase row has no id");
        continue;
      }
      const updated = await updateRowById(supabase, table, id, payload, group.orderRow);
      if (updated) {
        purchaseOrderBySourceId.set(group.sourceId, {
          id,
          sourceId: group.sourceId,
          supplier_id: dbString(existing, "supplier_id"),
        });
      }
      continue;
    }

    const inserted = await writeEntries(
      supabase,
      table,
      [{ payload, sourceRow: group.orderRow, syntheticId: `dry-run-purchase-${group.sourceId}` }],
      { mode: "insert", select: "id, receipt_number, supplier_id" },
    );
    const insertedRow = inserted[0];
    const id = dbString(insertedRow, "id") ?? `dry-run-purchase-${group.sourceId}`;
    purchaseOrderBySourceId.set(group.sourceId, {
      id,
      sourceId: group.sourceId,
      supplier_id: dbString(insertedRow, "supplier_id") ?? dbString(payload, "supplier_id"),
    });
  }

  return purchaseOrderBySourceId;
}

function lineSourceId(row: SourceRow) {
  return normalizeExternalId(cell(row, "line_id")) ?? `${normalizeExternalId(cell(row, "purchase_id")) ?? "purchase"}:${row.sourceFile}:${row.sourceRow}`;
}

function purchaseLinePayload(
  row: SourceRow,
  linePosition: number,
  order: PurchaseOrderRef,
  productBySku: Map<string, ProductRef>,
) {
  const productSku = normalizeExternalId(cell(row, "item_id", "product_id", "sku"));
  const product = productSku ? productBySku.get(productSku) : null;
  if (!productSku || !product) return null;
  const boxesQty = Math.max(0, integerValue(cell(row, "boxes_qty"), 0));
  const unitsPerBox = Math.max(1, integerValue(cell(row, "pack_size_used", "units_per_box"), product.case_quantity ?? 1));
  const sourceQty = numberValue(cell(row, "received_units"), 0) || numberValue(cell(row, "qty_pieces"), 0);
  const totalUnits = Math.max(0, integerValue(sourceQty, boxesQty * unitsPerBox));
  const looseUnitsQty = Math.max(0, totalUnits - boxesQty * unitsPerBox);
  const unitCost = roundUnitCost(Math.max(0, numberValue(cell(row, "unit_cost"), 0)));
  const lineTotal = roundMoney(totalUnits * unitCost);
  if (totalUnits <= 0) return null;

  return {
    productSku,
    payload: {
      purchase_order_id: order.id,
      product_id: product.id,
      line_position: linePosition,
      boxes_qty: boxesQty,
      units_per_box: unitsPerBox,
      loose_units_qty: looseUnitsQty,
      total_units: totalUnits,
      ordered_qty: totalUnits,
      received_qty: totalUnits,
      unit_cost: unitCost,
      unit_cost_lyd: unitCost,
      line_total: lineTotal,
      line_total_lyd: lineTotal,
    },
  };
}

async function importPurchaseLines(
  supabase: SupabaseClient,
  groups: PurchaseGroup[],
  purchaseOrderBySourceId: Map<string, PurchaseOrderRef>,
  productBySku: Map<string, ProductRef>,
) {
  const table = "purchase_order_lines";
  addRowsRead(table, groups.reduce((sum, group) => sum + group.lineRows.length, 0));
  const purchaseLineRefs: PurchaseLineRef[] = [];
  const orderIds = [...purchaseOrderBySourceId.values()].map((order) => order.id).filter((id) => !id.startsWith("dry-run-"));
  const existingLines = await fetchByIn(supabase, table, "id, purchase_order_id, line_position", "purchase_order_id", orderIds);
  const existingByOrderPosition = new Map(existingLines.flatMap((row) => {
    const orderId = dbString(row, "purchase_order_id");
    const position = row.line_position === null || row.line_position === undefined ? null : String(row.line_position);
    return orderId && position !== null ? [[`${orderId}::${position}`, row] as const] : [];
  }));

  for (const group of groups) {
    const order = purchaseOrderBySourceId.get(group.sourceId);
    if (!order) {
      for (const row of group.lineRows) skipRow(table, row, "purchase order was not imported");
      continue;
    }

    const dedupedLines = dedupeRows(table, group.lineRows, "line id", lineSourceId);
    for (const [index, row] of dedupedLines.entries()) {
      const built = purchaseLinePayload(row, index, order, productBySku);
      if (!built) {
        skipRow(table, row, "missing product, unknown product, or non-positive quantity");
        continue;
      }

      const existing = existingByOrderPosition.get(`${order.id}::${index}`);
      let lineId: string | null = null;
      if (existing) {
        lineId = dbString(existing, "id");
        if (lineId) await updateRowById(supabase, table, lineId, built.payload, row);
      } else {
        const inserted = await writeEntries(
          supabase,
          table,
          [{ payload: built.payload, sourceRow: row, syntheticId: `dry-run-purchase-line-${group.sourceId}-${index}` }],
          { mode: "insert", select: "id, purchase_order_id, product_id, total_units, unit_cost_lyd, line_total_lyd" },
        );
        lineId = dbString(inserted[0] ?? {}, "id") ?? `dry-run-purchase-line-${group.sourceId}-${index}`;
      }

      if (lineId) {
        purchaseLineRefs.push({
          id: lineId,
          sourcePurchaseId: group.sourceId,
          productSku: built.productSku,
          product_id: String(built.payload.product_id),
          total_units: Number(built.payload.total_units ?? 0),
          unit_cost_lyd: Number(built.payload.unit_cost_lyd ?? 0),
          line_total_lyd: Number(built.payload.line_total_lyd ?? 0),
        });
      }
    }
  }

  const purchaseLineByPurchaseAndProduct = new Map<string, PurchaseLineRef>();
  for (const line of purchaseLineRefs) {
    const key = `${line.sourcePurchaseId}::${line.productSku}`;
    if (!purchaseLineByPurchaseAndProduct.has(key)) purchaseLineByPurchaseAndProduct.set(key, line);
  }
  return purchaseLineByPurchaseAndProduct;
}

function inventoryLocationId(row: SourceRow, storageByName: Map<string, string>) {
  const locationName = text(row, "location_id") ?? "MAIN";
  return storageByName.get(locationName) ?? storageByName.get("MAIN") ?? null;
}

function inventoryPayload(
  row: SourceRow,
  productBySku: Map<string, ProductRef>,
  storageByName: Map<string, string>,
  purchaseOrderBySourceId: Map<string, PurchaseOrderRef>,
  purchaseLineByPurchaseAndProduct: Map<string, PurchaseLineRef>,
) {
  const inventoryId = normalizeExternalId(cell(row, "inventory_id"));
  const productSku = normalizeExternalId(cell(row, "item_id", "product_id", "sku"));
  const product = productSku ? productBySku.get(productSku) : null;
  if (!inventoryId || !productSku || !product) return null;

  const amount = numberValue(cell(row, "amount", "quantity"), 0);
  const quantity = Math.abs(integerValue(amount, 0));
  if (quantity <= 0) return null;

  const storageId = inventoryLocationId(row, storageByName);
  const sourcePurchaseId = normalizeExternalId(cell(row, "source_purchase_id"));
  const relatedPurchase = sourcePurchaseId ? purchaseOrderBySourceId.get(sourcePurchaseId) : null;
  const relatedLine = sourcePurchaseId ? purchaseLineByPurchaseAndProduct.get(`${sourcePurchaseId}::${productSku}`) : null;
  const isPurchaseReceipt = amount > 0 && Boolean(relatedPurchase);
  const marker = `${INVENTORY_IMPORT_PREFIX}${inventoryId}`;
  const createdAt = parseDateTime(cell(row, "datetime", "date_time", "created_at"));

  return {
    marker,
    payload: {
      product_id: product.id,
      quantity,
      from_entity_type: amount >= 0 ? (isPurchaseReceipt ? "supplier" : "adjustment") : "storage",
      from_entity_id: amount >= 0 ? (isPurchaseReceipt ? relatedPurchase?.supplier_id ?? null : null) : storageId,
      to_entity_type: amount >= 0 ? "storage" : "adjustment",
      to_entity_id: amount >= 0 ? storageId : null,
      reason: isPurchaseReceipt ? "purchase_received" : "stock_count_adjustment",
      related_purchase_id: relatedPurchase?.id ?? null,
      related_purchase_line_id: relatedLine?.id ?? null,
      unit_cost_lyd: relatedLine?.unit_cost_lyd ?? null,
      line_total_lyd: relatedLine ? roundMoney(quantity * relatedLine.unit_cost_lyd) : null,
      notes: marker,
      created_at: createdAt ?? new Date().toISOString(),
    },
  };
}

async function importInventoryMovements(
  supabase: SupabaseClient,
  rows: SourceRow[],
  productBySku: Map<string, ProductRef>,
  storageByName: Map<string, string>,
  purchaseOrderBySourceId: Map<string, PurchaseOrderRef>,
  purchaseLineByPurchaseAndProduct: Map<string, PurchaseLineRef>,
) {
  const table = "inventory_movements";
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "inventory id", (row) => normalizeExternalId(cell(row, "inventory_id")));
  const payloadRows = deduped.flatMap((row) => {
    const built = inventoryPayload(row, productBySku, storageByName, purchaseOrderBySourceId, purchaseLineByPurchaseAndProduct);
    if (!built) {
      skipRow(table, row, "missing inventory id, unknown product, or non-positive amount");
      return [];
    }
    return [{ row, marker: built.marker, payload: built.payload }];
  });

  const existing = await fetchByIn(supabase, table, "id, notes", "notes", payloadRows.map((entry) => entry.marker));
  const existingMarkers = new Set(existing.map((row) => dbString(row, "notes")).filter(Boolean));
  const missing = payloadRows.filter((entry) => !existingMarkers.has(entry.marker));
  statsFor(table).skippedExisting += payloadRows.length - missing.length;

  await writeEntries(
    supabase,
    table,
    missing.map((entry) => ({ payload: entry.payload, sourceRow: entry.row, syntheticId: `dry-run-inventory-${entry.marker}` })),
    { mode: "insert", select: "id, notes" },
  );
}

function purchaseFinancePayload(group: PurchaseGroup, order: PurchaseOrderRef, lineRefs: PurchaseLineRef[]) {
  const orderDate = purchaseDate(group.orderRow);
  if (!orderDate) return null;
  const supplierName = text(group.orderRow, "supplier");
  const receiptTotal = roundMoney(numberValue(cell(group.orderRow, "receipt_total"), 0));
  const calculatedTotal = roundMoney(numberValue(cell(group.orderRow, "calculated_total"), 0));
  const lineTotal = roundMoney(lineRefs.reduce((sum, line) => sum + Number(line.line_total_lyd ?? 0), 0));
  const amount = receiptTotal > 0 ? receiptTotal : calculatedTotal > 0 ? calculatedTotal : lineTotal;
  if (amount <= 0) return null;

  const description = `Product purchase ${group.sourceId}${supplierName ? ` - ${supplierName}` : ""}`;
  return {
    transaction_date: orderDate,
    direction: "money_out",
    transaction_kind: "product_purchase",
    transaction_type: "Product Purchase",
    location: supplierName ?? "Purchases",
    description,
    amount,
    signed_amount: -Math.abs(amount),
    bucket: "Outflow",
    bucket_override: null,
    final_bucket: "Product Purchases",
    review_status: "confirmed",
    needs_review: false,
    source_sheet: `current_data_purchases:${group.orderRow.sourceFile}`,
    source_row: group.orderRow.sourceRow,
    source_file: `docs/current-data/${group.orderRow.sourceFile}`,
    original_description: description,
    import_status: "imported",
    transaction_status: "active",
    payment_method: "cash",
    related_purchase_id: order.id,
    metadata: {
      current_data_import: true,
      generated_from_purchase_import: true,
      source_purchase_id: group.sourceId,
      source_file: group.orderRow.sourceFile,
      source_row: group.orderRow.sourceRow,
    },
    updated_at: new Date().toISOString(),
  };
}

async function importPurchaseFinancialTransactions(
  supabase: SupabaseClient,
  groups: PurchaseGroup[],
  purchaseOrderBySourceId: Map<string, PurchaseOrderRef>,
  purchaseLineByPurchaseAndProduct: Map<string, PurchaseLineRef>,
) {
  const table = "financial_transactions";
  addRowsRead(table, groups.length);
  const purchaseIds = [...purchaseOrderBySourceId.values()].map((order) => order.id).filter((id) => !id.startsWith("dry-run-"));
  const existing = await fetchByIn(supabase, table, "id, related_purchase_id", "related_purchase_id", purchaseIds);
  const existingByPurchaseId = new Map(existing.flatMap((row) => {
    const purchaseId = dbString(row, "related_purchase_id");
    return purchaseId ? [[purchaseId, row] as const] : [];
  }));

  for (const group of groups) {
    const order = purchaseOrderBySourceId.get(group.sourceId);
    if (!order) {
      skipRow(table, group.orderRow, "purchase finance transaction skipped because purchase order was not imported");
      continue;
    }

    const lineRefs = [...purchaseLineByPurchaseAndProduct.values()].filter((line) => line.sourcePurchaseId === group.sourceId);
    const payload = purchaseFinancePayload(group, order, lineRefs);
    if (!payload) {
      skipRow(table, group.orderRow, "purchase finance transaction skipped because purchase total is zero");
      continue;
    }

    const existingRow = existingByPurchaseId.get(order.id);
    const existingId = existingRow ? dbString(existingRow, "id") : null;
    if (existingId) {
      await updateRowById(supabase, table, existingId, payload, group.orderRow);
    } else {
      await writeEntries(
        supabase,
        table,
        [{ payload, sourceRow: group.orderRow, syntheticId: `dry-run-purchase-finance-${group.sourceId}` }],
        { mode: "insert", select: "id, related_purchase_id" },
      );
    }
  }
}

function financePayload(row: SourceRow): DbPayload | null {
  const transactionDate = parseDateOnly(cell(row, "date", "transaction_date"));
  const signedAmount = roundMoney(numberValue(cell(row, "signed_amount", "amount"), Number.NaN));
  if (!transactionDate || !Number.isFinite(signedAmount) || signedAmount === 0) return null;
  const direction = signedAmount >= 0 ? "money_in" : "money_out";
  const transactionType = text(row, "transaction_type");
  const location = text(row, "location");
  const description = text(row, "transaction_description", "description");
  const finalBucket = text(row, "final_bucket");
  const needsReview = !transactionType || !location || !description || !finalBucket;

  return {
    transaction_date: transactionDate,
    direction,
    transaction_kind: "spreadsheet_import",
    transaction_type: transactionType,
    location,
    description,
    amount: Math.abs(signedAmount),
    signed_amount: signedAmount,
    bucket: text(row, "auto_bucket", "bucket"),
    bucket_override: text(row, "bucket_override"),
    final_bucket: finalBucket,
    review_status: needsReview ? "needs_review" : "confirmed",
    needs_review: needsReview,
    source_sheet: FINANCE_SOURCE_SHEET,
    source_row: row.sourceRow,
    source_file: FINANCE_SOURCE_FILE,
    original_description: description,
    import_status: needsReview ? "needs_review" : "imported",
    transaction_status: "active",
    metadata: {
      current_data_import: true,
      source_file: row.sourceFile,
      source_row: row.sourceRow,
      money_flow: text(row, "money_flow"),
      raw_transaction: text(row, "transaction"),
      raw_record: row.values,
    },
    updated_at: new Date().toISOString(),
  };
}

async function importFinancialTransactions(supabase: SupabaseClient, rows: SourceRow[]) {
  const table = "financial_transactions";
  addRowsRead(table, rows.length);
  const deduped = dedupeRows(table, rows, "transaction row", (row) => {
    const date = cleanValue(cell(row, "date", "transaction_date"), { fixEncoding: false }) ?? "";
    const amount = cleanValue(cell(row, "signed_amount", "amount"), { fixEncoding: false }) ?? "";
    const description = normalizeKey(cell(row, "transaction_description", "description")) ?? "";
    const transaction = normalizeKey(cell(row, "transaction")) ?? "";
    return `${date}::${amount}::${transaction}::${description}`;
  });
  const entries = deduped.flatMap((row) => {
    const payload = financePayload(row);
    if (!payload) {
      skipRow(table, row, "missing/invalid transaction date or non-zero signed amount");
      return [];
    }
    return [{ payload, sourceRow: row, syntheticId: `dry-run-finance-${row.sourceRow}` }];
  });

  const existingRows: DbRow[] = [];
  for (const group of chunks(entries.map((entry) => Number(entry.payload.source_row)).filter((value) => Number.isFinite(value)))) {
    const { data, error } = await supabase
      .from(table)
      .select("id, source_sheet, source_row")
      .eq("source_sheet", FINANCE_SOURCE_SHEET)
      .in("source_row", group);
    if (error) throw new Error(`${table}: ${error.message}`);
    existingRows.push(...((data ?? []) as unknown as DbRow[]));
  }

  const existingBySourceRow = new Map<string, DbRow>();
  for (const row of existingRows) {
    const sourceRow = row.source_row === null || row.source_row === undefined ? null : String(row.source_row);
    if (sourceRow && !existingBySourceRow.has(sourceRow)) existingBySourceRow.set(sourceRow, row);
  }

  const insertEntries: WriteEntry[] = [];
  for (const entry of entries) {
    const sourceRow = String(entry.payload.source_row);
    const existing = existingBySourceRow.get(sourceRow);
    const id = existing ? dbString(existing, "id") : null;
    if (id) {
      await updateRowById(supabase, table, id, entry.payload, entry.sourceRow);
    } else {
      insertEntries.push(entry);
    }
  }

  await writeEntries(
    supabase,
    table,
    insertEntries,
    { mode: "insert", select: "id, source_sheet, source_row" },
  );
}

async function runStep<T>(table: string, fn: () => Promise<T>, fallback: T) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError(table, message);
    console.error(`[${table}] ${message}`);
    return fallback;
  }
}

function isLocalSupabaseUrl(url: string) {
  return /(^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$))/i.test(url);
}

function printSummary(loadedFiles: string[]) {
  const errorsByTable = Object.fromEntries(
    Object.entries(summary)
      .filter(([, stats]) => stats.errors.length > 0)
      .map(([table, stats]) => [table, stats.errors]),
  );
  const tableSummary = Object.fromEntries(
    Object.entries(summary).map(([table, stats]) => [
      table,
      {
        rowsRead: stats.rowsRead,
        rowsImported: stats.rowsImported,
        rowsSkipped: stats.rowsSkipped,
        skippedExisting: stats.skippedExisting,
        errorCount: stats.errors.length,
      },
    ]),
  );

  console.log(dryRun ? "Current data cloud import dry run complete." : "Current data cloud import complete.");
  console.log(JSON.stringify({ dryRun, dataDir, loadedFiles, summary: tableSummary, errorsByTable }, null, 2));

  if (skippedRows.length) {
    console.log("\nSkipped rows:");
    for (const skipped of skippedRows.slice(0, 500)) {
      const location = skipped.file ? `${skipped.file}:${skipped.row}` : "derived";
      console.log(`- ${skipped.table} ${location} - ${skipped.reason}`);
    }
    if (skippedRows.length > 500) {
      console.log(`...and ${skippedRows.length - 500} more skipped rows. Re-run with narrower data after fixing the first batch.`);
    }
  }
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  await loadEnvFile(".env.import.local");
  await loadEnvFile(".env.import");

  const supabaseUrl = process.env.CLOUD_SUPABASE_URL;
  const serviceRoleKey = process.env.CLOUD_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Set CLOUD_SUPABASE_URL and CLOUD_SUPABASE_SERVICE_ROLE_KEY. Put local secrets in .env.import.local.");
  }
  if (isLocalSupabaseUrl(supabaseUrl) && !allowLocal) {
    throw new Error("CLOUD_SUPABASE_URL points to localhost. Use --allow-local only for rehearsal.");
  }

  const files = await loadCurrentDataFiles();
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const locationByName = await runStep("locations", () => importLocations(supabase, files), new Map<string, string>());
  const supplierByName = await runStep("suppliers", () => importSuppliers(supabase, files), new Map<string, DbRow>());
  const productImportRows = buildProductImportRows(files);
  const productBySku = await runStep("products", () => importProducts(supabase, productImportRows), new Map<string, ProductRef>());
  const machines = await runStep(
    "machines",
    () => importMachines(supabase, files.machines, locationByName),
    { machineByCode: new Map<string, MachineRef>(), machineByVmsId: new Map<string, MachineRef>() },
  );
  const storageByName = await runStep("storage_locations", () => importStorageLocations(supabase, files), new Map<string, string>());
  const productByVmsId = await runStep("vms_product_mappings", () => importVmsMappings(supabase, files.vmsMappings, productBySku), new Map<string, ProductRef>());
  await runStep("machine_slots", () => importMachineSlots(supabase, files.machineSlots, machines, productBySku, productByVmsId), undefined);

  const purchaseGroups = buildPurchaseGroups(files);
  const purchaseOrderBySourceId = await runStep("purchase_orders", () => importPurchaseOrders(supabase, purchaseGroups, supplierByName), new Map<string, PurchaseOrderRef>());
  const purchaseLineByPurchaseAndProduct = await runStep(
    "purchase_order_lines",
    () => importPurchaseLines(supabase, purchaseGroups, purchaseOrderBySourceId, productBySku),
    new Map<string, PurchaseLineRef>(),
  );

  await runStep(
    "inventory_movements",
    () => importInventoryMovements(supabase, files.storageInventory, productBySku, storageByName, purchaseOrderBySourceId, purchaseLineByPurchaseAndProduct),
    undefined,
  );
  await runStep(
    "financial_transactions",
    () => importPurchaseFinancialTransactions(supabase, purchaseGroups, purchaseOrderBySourceId, purchaseLineByPurchaseAndProduct),
    undefined,
  );
  await runStep("financial_transactions", () => importFinancialTransactions(supabase, files.financialTransactions), undefined);

  printSummary(files.loadedFiles);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error("");
  console.error(usage());
  process.exit(1);
});
