import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_SOURCE_FILE = path.join(os.homedir(), "Downloads", "Items - MachineRefills.csv");
const SOURCE_SHEET = "Items - MachineRefills.csv";
const BATCH_SIZE = 200;
const TRIPOLI_OFFSET = "+02:00";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const createMissingMachines = args.includes("--create-missing-machines");
const skipIssues = args.includes("--no-issues");

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const sourceFile = optionValue("--file") ?? args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_SOURCE_FILE;

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadEnvFile(filename) {
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
    if (error?.code !== "ENOENT") throw error;
  }
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
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
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current);
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header, index) => header.trim().replace(index === 0 ? /^\uFEFF/ : /^$/, ""));
  return rows.slice(1).map((values, index) => ({
    sourceFile: path.basename(sourceFile),
    sourceSheet: SOURCE_SHEET,
    sourceRow: index + 2,
    record: Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] ?? ""])),
  }));
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text && text.toUpperCase() !== "TO_CONFIRM" ? text : null;
}

function normalizeKey(value) {
  return clean(value)?.toLowerCase().replace(/\s+/g, " ") ?? null;
}

function maybeFixMojibake(value) {
  const text = clean(value);
  if (!text || !/[ØÙÃ]/.test(text)) return text;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  return decoded.includes("�") ? text : decoded;
}

function parseBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(normalized)) return true;
  if (["false", "no", "0", "n", ""].includes(normalized)) return false;
  return false;
}

function parseDateTime(value) {
  const raw = clean(value);
  if (!raw) return null;
  const mdyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (mdyMatch) {
    const [, month, day, year, hour = "0", minute = "0", second = "0"] = mdyMatch;
    const normalizedMdy = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second.padStart(2, "0")}${TRIPOLI_OFFSET}`;
    const date = new Date(normalizedMdy);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}${TRIPOLI_OFFSET}`;
  const date = new Date(withOffset);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

function chunks(rows) {
  const chunked = [];
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    chunked.push(rows.slice(index, index + BATCH_SIZE));
  }
  return chunked;
}

async function getAll(supabase, table, select, { optional = false } = {}) {
  const { data, error } = await supabase.from(table).select(select).limit(50000);
  if (error) {
    if (optional && (error.code === "PGRST205" || String(error.message ?? "").includes(table))) return [];
    throw error;
  }
  return data ?? [];
}

function buildMachineLookup(machines) {
  const lookup = new Map();
  for (const machine of machines) {
    for (const value of [machine.machine_code, machine.vms_machine_id, machine.serial_number, machine.name]) {
      const key = normalizeKey(value);
      if (key && !lookup.has(key)) lookup.set(key, machine);
    }
  }
  return lookup;
}

function buildOperatorLookup(teamMembers) {
  return new Map(teamMembers.filter((member) => member.email).map((member) => [normalizeKey(member.email), member]));
}

async function createMissingOperatorRows(supabase, rows, operatorByEmail) {
  const emails = Array.from(new Set(rows.map((row) => normalizeKey(row.record.OperatorEmail)).filter(Boolean))).filter((email) => !operatorByEmail.has(email));
  if (!emails.length || dryRun) return [];

  const payload = emails.map((email) => ({
    full_name: email.split("@")[0],
    email,
    role: "operator",
    active: true,
    active_status: "active",
  }));

  const { data, error } = await supabase.from("team_members").insert(payload).select("id, full_name, email");
  if (error) throw error;
  return data ?? [];
}

async function createMissingMachineRows(supabase, rows, machineByKey) {
  if (!createMissingMachines) return [];
  const machineNames = Array.from(new Set(rows.map((row) => clean(row.record["Machine Name"])).filter(Boolean))).filter((name) => !machineByKey.has(normalizeKey(name)));
  if (!machineNames.length || dryRun) return [];

  const payload = machineNames.map((name) => ({
    machine_code: name,
    vms_machine_id: name,
    name,
    machine_type: "vending",
    status: "active",
    notes: "Created by historical machine refill import.",
  }));

  const { data, error } = await supabase.from("machines").insert(payload).select("id, machine_code, vms_machine_id, serial_number, name");
  if (error) throw error;
  return data ?? [];
}

function classifyRows(rows, machineByKey, operatorByEmail, existingLegacyIds) {
  const seenLegacyIds = new Set();
  return rows.map((row) => {
    const legacyRefillId = clean(row.record.RefillID);
    const refillAt = parseDateTime(row.record.DateTime);
    const machineName = clean(row.record["Machine Name"]);
    const operatorEmail = normalizeKey(row.record.OperatorEmail);
    const machine = machineByKey.get(normalizeKey(machineName));
    const operator = operatorEmail ? operatorByEmail.get(operatorEmail) : null;
    const machinePhoto = clean(row.record.MachinePhoto);
    const issueNotes = maybeFixMojibake(row.record.IssueNotes);
    const reasons = [];

    if (!legacyRefillId) reasons.push("missing RefillID");
    if (!refillAt) reasons.push("missing or invalid DateTime");
    if (!machineName) reasons.push("missing machine name");
    if (machineName && !machine) reasons.push("machine not matched");
    if (operatorEmail && !operator) reasons.push("operator not matched");
    const duplicateInFile = Boolean(legacyRefillId && seenLegacyIds.has(legacyRefillId));
    if (duplicateInFile) reasons.push("duplicate RefillID in file");

    const importStatus = reasons.length ? "needs_review" : "imported";
    if (legacyRefillId) seenLegacyIds.add(legacyRefillId);

    return {
      ...row,
      legacyRefillId,
      refillAt,
      machineName,
      machine,
      operator,
      operatorEmail,
      machinePhoto,
      issueNotes,
      issuesFound: parseBoolean(row.record.IssuesFound),
      fillStatus: clean(row.record.FillStatus)?.replace(/\s+/g, " ") ?? null,
      importStatus,
      reviewReason: reasons.join("; ") || null,
      canImport: Boolean(legacyRefillId && refillAt && machineName && !duplicateInFile),
    };
  });
}

function historyPayload(row) {
  return {
    legacy_refill_id: row.legacyRefillId,
    refill_at: row.refillAt,
    machine_id: row.machine?.id ?? null,
    machine_name: row.machineName,
    operator_id: row.operator?.id ?? null,
    operator_email: row.operatorEmail,
    machine_photo_url: row.machinePhoto && isUrl(row.machinePhoto) ? row.machinePhoto : null,
    machine_photo_path: row.machinePhoto && !isUrl(row.machinePhoto) ? row.machinePhoto : null,
    fill_status: row.fillStatus,
    issues_found: row.issuesFound,
    issue_notes: row.issueNotes,
    source_file: row.sourceFile,
    source_row: row.sourceRow,
    import_status: row.importStatus,
    review_reason: row.reviewReason,
    raw_record: row.record,
    updated_at: new Date().toISOString(),
  };
}

function issuePayload(row) {
  return {
    machine_id: row.machine?.id ?? null,
    reported_by: row.operator?.id ?? null,
    issue_type: "historical_refill_issue",
    priority: "normal",
    status: "closed",
    description: [
      row.issueNotes || "Issue was marked on historical machine refill form.",
      `Historical refill ID: ${row.legacyRefillId}`,
      `Imported from ${row.sourceFile} row ${row.sourceRow}.`,
    ].join("\n"),
    photo_url: row.machinePhoto && isUrl(row.machinePhoto) ? row.machinePhoto : null,
    created_at: row.refillAt,
    resolved_at: row.refillAt,
  };
}

async function upsertHistoryRows(supabase, rows) {
  const importedRows = [];
  for (const chunk of chunks(rows)) {
    const { data, error } = await supabase
      .from("machine_refill_history")
      .upsert(chunk.map(historyPayload), { onConflict: "legacy_refill_id" })
      .select("id, legacy_refill_id, linked_issue_id, import_status");
    if (error) throw error;
    importedRows.push(...(data ?? []));
  }
  return importedRows;
}

async function createHistoricalIssues(supabase, classifiedRows, historyRowsByLegacyId) {
  if (skipIssues) return [];
  const rowsNeedingIssue = classifiedRows.filter((row) => {
    const historyRow = historyRowsByLegacyId.get(row.legacyRefillId);
    return row.canImport && row.issuesFound && !historyRow?.linked_issue_id;
  });
  if (!rowsNeedingIssue.length || dryRun) return [];

  const createdIssues = [];
  for (const row of rowsNeedingIssue) {
    const { data, error } = await supabase.from("issues").insert(issuePayload(row)).select("id").single();
    if (error) throw error;
    createdIssues.push({ legacyRefillId: row.legacyRefillId, issueId: data.id });
  }

  for (const chunk of chunks(createdIssues)) {
    await Promise.all(chunk.map(({ legacyRefillId, issueId }) => (
      supabase.from("machine_refill_history").update({ linked_issue_id: issueId }).eq("legacy_refill_id", legacyRefillId)
    )));
  }

  return createdIssues;
}

async function writeActivityLog(supabase, summary) {
  const { error } = await supabase.from("system_activity_logs").insert({
    action: "import_machine_refills",
    entity_type: "machine_refill_history",
    entity_label: "Historical machine refill import",
    after_data: summary,
    metadata: {
      source_file: path.basename(sourceFile),
      imported_by_script: "scripts/import-machine-refills.mjs",
    },
    summary: `Imported ${summary.upserted_history_rows} historical machine refill records.`,
  });
  if (error) console.warn(`Activity log failed: ${error.message}`);
}

async function main() {
  await loadEnvFile(".env.local");
  await loadEnvFile(".env");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before importing machine refill history.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rows = parseCsv(await readFile(sourceFile, "utf8"));
  const [machines, teamMembers, existingHistory] = await Promise.all([
    getAll(supabase, "machines", "id, machine_code, vms_machine_id, serial_number, name"),
    getAll(supabase, "team_members", "id, full_name, email"),
    getAll(supabase, "machine_refill_history", "id, legacy_refill_id, linked_issue_id", { optional: dryRun }),
  ]);

  const machineByKey = buildMachineLookup(machines);
  const operatorByEmail = buildOperatorLookup(teamMembers);
  const createdOperators = await createMissingOperatorRows(supabase, rows, operatorByEmail);
  for (const operator of createdOperators) {
    const key = normalizeKey(operator.email);
    if (key) operatorByEmail.set(key, operator);
  }

  const createdMachines = await createMissingMachineRows(supabase, rows, machineByKey);
  for (const machine of createdMachines) {
    for (const value of [machine.machine_code, machine.vms_machine_id, machine.serial_number, machine.name]) {
      const key = normalizeKey(value);
      if (key && !machineByKey.has(key)) machineByKey.set(key, machine);
    }
  }

  const existingLegacyIds = new Set(existingHistory.map((row) => row.legacy_refill_id));
  const classifiedRows = classifyRows(rows, machineByKey, operatorByEmail, existingLegacyIds);
  const importableRows = classifiedRows.filter((row) => row.canImport);
  const reviewRows = classifiedRows.filter((row) => row.importStatus === "needs_review");

  let upsertedHistoryRows = [];
  if (!dryRun && importableRows.length) {
    upsertedHistoryRows = await upsertHistoryRows(supabase, importableRows);
  }

  const historyRowsByLegacyId = new Map([...existingHistory, ...upsertedHistoryRows].map((row) => [row.legacy_refill_id, row]));
  const createdIssues = await createHistoricalIssues(supabase, classifiedRows, historyRowsByLegacyId);

  const summary = {
    source_file: sourceFile,
    source_rows: rows.length,
    importable_rows: importableRows.length,
    upserted_history_rows: dryRun ? 0 : upsertedHistoryRows.length,
    needs_review_rows: reviewRows.length,
    issue_flags: classifiedRows.filter((row) => row.issuesFound).length,
    created_historical_issues: dryRun ? 0 : createdIssues.length,
    created_operators: dryRun ? 0 : createdOperators.length,
    created_machines: dryRun ? 0 : createdMachines.length,
    existing_rows: existingHistory.length,
    create_missing_machines: createMissingMachines,
    dry_run: dryRun,
  };

  if (!dryRun) await writeActivityLog(supabase, summary);

  console.log(JSON.stringify(summary, null, 2));
  if (reviewRows.length) {
    console.log("\nRows needing review:");
    for (const row of reviewRows.slice(0, 20)) {
      console.log(`- row ${row.sourceRow} refill ${row.legacyRefillId ?? "(missing)"}: ${row.reviewReason}`);
    }
    if (reviewRows.length > 20) console.log(`...and ${reviewRows.length - 20} more`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
