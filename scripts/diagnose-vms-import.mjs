import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(fileName) {
  if (!fs.existsSync(fileName)) return {};
  return Object.fromEntries(
    fs.readFileSync(fileName, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([^#=]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => {
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [match[1].trim(), value];
      }),
  );
}

const envFile = process.argv[2] || ".env.local";
const env = {
  ...loadEnvFile(envFile),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.log(JSON.stringify({ ok: false, error: "Missing Supabase env vars." }, null, 2));
  process.exit(0);
}

const relations = [
  "vms_import_batches",
  "vms_import_previews",
  "vms_import_preview_rows",
  "vms_import_rows",
  "vms_sales_raw",
  "vms_transactions_raw",
  "vms_stock_snapshots",
  "vms_sales_snapshots",
  "vms_product_mappings",
  "vms_machine_mappings",
  "vms_header_mappings",
  "products",
  "machines",
  "vms_sales_clean",
  "latest_vms_stock_by_slot",
];

const timedFetch = async (input, init = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  global: { fetch: timedFetch },
});

function relationError(error) {
  if (!error) return null;
  return {
    code: error.code ?? null,
    message: error.message ?? String(error),
    details: error.details ?? null,
    hint: error.hint ?? null,
  };
}

async function checkRelation(name) {
  const result = await supabase.from(name).select("id", { count: "exact", head: true }).limit(1);
  return {
    name,
    exists: !result.error,
    count: result.error ? null : result.count,
    error: relationError(result.error),
  };
}

async function latestBatch() {
  const preferred = await supabase
    .from("vms_import_batches")
    .select("id,status,file_name,report_type,rows_found,rows_imported,uploaded_by,created_at,is_active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!preferred.error) return { data: preferred.data, error: null };

  const fallback = await supabase
    .from("vms_import_batches")
    .select("id,status,file_name,report_type,row_count,rows_imported,uploaded_by,imported_at")
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    data: fallback.data,
    error: relationError(fallback.error ?? preferred.error),
    preferredError: relationError(preferred.error),
  };
}

async function countForBatch(table, batchId) {
  const result = await supabase.from(table).select("id", { count: "exact", head: true }).eq("import_batch_id", batchId);
  return { table, count: result.error ? null : result.count, error: relationError(result.error) };
}

const urlHost = (() => {
  try {
    return new URL(supabaseUrl).host;
  } catch {
    return "invalid-url";
  }
})();

try {
  const tableChecks = await Promise.all(relations.map((relation) => checkRelation(relation)));
  const latest = await latestBatch();
  const batchCounts = [];
  if (latest.data?.id) {
    const countTables = [
      "vms_import_preview_rows",
      "vms_import_rows",
      "vms_sales_raw",
      "vms_transactions_raw",
      "vms_stock_snapshots",
      "vms_sales_snapshots",
    ];
    batchCounts.push(...await Promise.all(countTables.map((table) => countForBatch(table, latest.data.id))));
  }

  console.log(JSON.stringify({
    ok: true,
    envFile,
    targetHost: urlHost,
    tableChecks,
    latestBatch: latest,
    batchCounts,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    envFile,
    targetHost: urlHost,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
