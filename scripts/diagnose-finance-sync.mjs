import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(fileName) {
  if (!fileName || !fs.existsSync(fileName)) return {};
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

function parseArgs(argv) {
  const args = {
    envFile: ".env.local",
    repair: false,
    confirmRepair: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      args.envFile = argv[index + 1] ?? args.envFile;
      index += 1;
    } else if (arg === "--repair") {
      args.repair = true;
    } else if (arg === "--confirm-repair") {
      args.confirmRepair = true;
    } else if (arg === "--check-env") {
      args.checkEnv = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

const envAliases = {
  SUPABASE_URL: ["NEXT_PUBLIC_SUPABASE_URL"],
  SUPABASE_SERVICE_ROLE_KEY: ["SUPABASE_SERVICE_KEY"],
  DATABASE_URL: ["POSTGRES_URL"],
};

function normalizeCodexEnv(rawEnv) {
  const env = { ...rawEnv };
  const mapped = {};

  for (const [canonicalName, aliases] of Object.entries(envAliases)) {
    const sourceName = [canonicalName, ...aliases].find((name) => {
      const value = env[name];
      return typeof value === "string" && value.length > 0;
    });
    if (sourceName) {
      env[canonicalName] = env[sourceName];
      mapped[canonicalName] = sourceName;
    }
  }

  return { env, mapped };
}

function envStatus(env) {
  return {
    hasUrl: Boolean(env.SUPABASE_URL),
    hasService: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
    hasDb: Boolean(env.DATABASE_URL),
    hasAnon: Boolean(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
}

function usage() {
  return [
    "Usage: node scripts/diagnose-finance-sync.mjs [--env-file .env.local] [--check-env] [--repair --confirm-repair]",
    "",
    "Environment variables:",
    "  SUPABASE_URL                 Required Supabase project URL.",
    "  SUPABASE_SERVICE_ROLE_KEY    Preferred for admin diagnostics/repair.",
    "  DATABASE_URL                  Required for direct SQL diagnostics outside this script.",
    "  NEXT_PUBLIC_SUPABASE_ANON_KEY Fallback for read-only diagnostics when RLS allows it.",
    "",
    "Aliases supported:",
    "  NEXT_PUBLIC_SUPABASE_URL -> SUPABASE_URL",
    "  SUPABASE_SERVICE_KEY -> SUPABASE_SERVICE_ROLE_KEY",
    "  POSTGRES_URL -> DATABASE_URL",
    "",
    "Safety:",
    "  Diagnostics run first and are SELECT/RPC reads only.",
    "  Repair only calls backfill_missing_finance_transactions(); it does not DROP, TRUNCATE, DELETE, or void rows.",
    "  Verification diagnostics run again after repair.",
    "",
    "Checks:",
    "  --check-env prints only boolean environment status and never prints secret values.",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const { env, mapped } = normalizeCodexEnv({
  ...loadEnvFile(args.envFile),
  ...process.env,
});

process.env.SUPABASE_URL = env.SUPABASE_URL ?? "";
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
process.env.DATABASE_URL = env.DATABASE_URL ?? "";

if (args.checkEnv) {
  console.log(JSON.stringify({
    ok: true,
    phase: "environment_check",
    envFile: args.envFile,
    envStatus: envStatus(env),
    mappedEnvAliases: mapped,
  }, null, 2));
  process.exit(0);
}

const supabaseUrl = env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(JSON.stringify({
    ok: false,
    phase: "configuration",
    envFile: args.envFile,
    envStatus: envStatus(env),
    aliases: {
      SUPABASE_URL: envAliases.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: envAliases.SUPABASE_SERVICE_ROLE_KEY,
      DATABASE_URL: envAliases.DATABASE_URL,
    },
    error: "Missing Supabase environment variables. Set SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY. Aliases are supported for NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, and POSTGRES_URL.",
  }, null, 2));
  process.exit(1);
}

if (args.repair && !args.confirmRepair) {
  console.error(JSON.stringify({
    ok: false,
    phase: "configuration",
    error: "Repair mode requires --confirm-repair so a live data backfill is never accidental.",
  }, null, 2));
  process.exit(1);
}

const timedFetch = async (input, init = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
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

function publicHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function errorDetails(error) {
  if (!error) return null;
  return {
    code: error.code ?? null,
    message: error.message ?? String(error),
    details: error.details ?? null,
    hint: error.hint ?? null,
  };
}

async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });
  return { table, count: error ? null : count ?? 0, error: errorDetails(error) };
}

async function sampleMissingPurchases() {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("id,order_date,status,payment_status,total_amount,grand_total")
    .not("status", "in", "(cancelled,voided)")
    .limit(10);

  if (error) return { rows: [], error: errorDetails(error) };
  return { rows: data ?? [], error: null };
}

async function sampleMissingCashCollections() {
  const { data, error } = await supabase
    .from("cash_collections")
    .select("id,collection_date,review_status,expected_cash,actual_cash_collected,variance")
    .not("actual_cash_collected", "is", null)
    .limit(10);

  if (error) return { rows: [], error: errorDetails(error) };
  return { rows: data ?? [], error: null };
}

async function rpcJson(name) {
  const { data, error } = await supabase.rpc(name);
  return { name, data: data ?? null, error: errorDetails(error) };
}

async function diagnostics(phase) {
  const [health, sourceSync, purchaseCount, cashCount, financeCount, purchaseSample, cashSample] = await Promise.all([
    rpcJson("finance_health_report"),
    rpcJson("finance_source_sync_diagnosis"),
    countRows("purchase_orders"),
    countRows("cash_collections"),
    countRows("financial_transactions"),
    sampleMissingPurchases(),
    sampleMissingCashCollections(),
  ]);

  return {
    ok: !health.error,
    phase,
    targetHost: publicHost(supabaseUrl),
    envStatus: envStatus(env),
    mappedEnvAliases: mapped,
    usingServiceRole: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
    diagnosticsAreReadOnly: true,
    counts: {
      purchaseOrders: purchaseCount,
      cashCollections: cashCount,
      financialTransactions: financeCount,
    },
    financeHealthReport: health,
    financeSourceSyncDiagnosis: sourceSync,
    samplesForManualReviewOnly: {
      purchases: purchaseSample,
      cashCollections: cashSample,
    },
  };
}

const preRepair = await diagnostics("pre_repair_select_diagnostics");
console.log(JSON.stringify(preRepair, null, 2));

if (args.repair) {
  const repairStartedAt = new Date().toISOString();
  const { data, error } = await supabase.rpc("backfill_missing_finance_transactions");
  const repair = {
    ok: !error,
    phase: "repair_backfill_missing_finance_transactions",
    startedAt: repairStartedAt,
    finishedAt: new Date().toISOString(),
    safety: "Called only the additive finance backfill RPC. No DROP/TRUNCATE/DELETE statements are used by this script.",
    data: data ?? null,
    error: errorDetails(error),
  };
  console.log(JSON.stringify(repair, null, 2));
  if (error) process.exitCode = 1;

  const postRepair = await diagnostics("post_repair_verification");
  console.log(JSON.stringify(postRepair, null, 2));
  if (postRepair.financeHealthReport.error) process.exitCode = 1;
}
