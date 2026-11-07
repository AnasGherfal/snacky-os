#!/usr/bin/env node
// COPY-ONLY historical VMS import archive. No database write/delete capability.
// Use Node 22+: node --experimental-strip-types scripts/vms-cold-archive.mjs ...
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { signedS3Headers, boundedResponseBytes } from "../src/lib/photo-archive-r2.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[a-z0-9]{20}$/;
const SHA = /^[a-f0-9]{64}$/;
const AGE_MS = 60 * 86400000;
const PAGE_SIZE = 250;
const MAX_ROWS = 10_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export class VmsArchiveError extends Error {
  constructor(code) { super(code); this.code = code; this.name = "VmsArchiveError"; }
}
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (ok, code) => { if (!ok) throw new VmsArchiveError(code); };
const dateMs = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

export function validateBatch(batch, batchId, now = new Date()) {
  check(UUID.test(batchId) && batch?.id === batchId, "invalid_batch");
  check(batch.status === "deleted" && batch.is_active === false && !!batch.deleted_at,
    "batch_not_deleted_or_still_active");
  const cutoff = now.getTime() - AGE_MS;
  check(Number.isFinite(cutoff) && dateMs(batch.imported_at) < cutoff && dateMs(batch.deleted_at) < cutoff,
    "batch_too_recent_or_date_invalid");
  return batch;
}

export function archivePrefix(projectRef, batchId) {
  check(REF.test(projectRef) && UUID.test(batchId), "archive_identity_invalid");
  return "snacky-vms-archive/v1/" + projectRef + "/vms_import_rows/" + batchId + "/";
}

export function prepareArchive(projectRef, batch, rows, now = new Date()) {
  validateBatch(batch, batch.id, now);
  const prefix = archivePrefix(projectRef, batch.id);
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_ROWS, "archive_row_count_invalid");
  const seen = new Set();
  let previousId = "";
  for (const row of rows) {
    check(row && typeof row === "object" && UUID.test(row.id) && row.import_batch_id === batch.id,
      "archive_row_identity_invalid");
    const id = String(row.id).toLowerCase();
    check(!seen.has(id) && (previousId === "" || previousId < id), "archive_row_order_invalid");
    check(dateMs(row.created_at) < now.getTime() - AGE_MS, "archive_row_not_old");
    previousId = id;
    seen.add(id);
  }
  const chunks = [];
  let totalBytes = 0;
  const data = [];
  for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
    const subset = rows.slice(offset, offset + PAGE_SIZE);
    const bytes = encode(subset.map(row => JSON.stringify(row)).join("\n") + "\n");
    check(bytes.byteLength <= MAX_CHUNK_BYTES, "archive_chunk_too_large");
    totalBytes += bytes.byteLength;
    check(totalBytes <= MAX_TOTAL_BYTES, "archive_batch_too_large");
    const sha256 = hash(bytes);
    const key = prefix + "objects/" + sha256 + ".ndjson";
    chunks.push({ key, sha256, bytes: bytes.byteLength, rows: subset.length,
      firstId: subset[0].id, lastId: subset[subset.length - 1].id });
    data.push(bytes);
  }
  const receipt = {
    version: 1, state: "copy_verified_source_retained", projectRef,
    sourceTable: "public.vms_import_rows", batchId: batch.id,
    batchSnapshot: batch, rowCount: rows.length, totalBytes,
    chunks, originalRowsDeleted: 0
  };
  const body = encode(JSON.stringify(receipt));
  check(body.length <= MAX_MANIFEST_BYTES, "archive_manifest_too_large");
  return { receipt, body, manifestSha256: hash(body),
    manifestKey: prefix + "manifest.json", chunks: data };
}

export async function readBatchRows(source, batchId, now = new Date()) {
  check(UUID.test(batchId), "invalid_batch");
  const result = [];
  let after = null;
  for (let page = 0; page <= Math.ceil(MAX_ROWS / PAGE_SIZE); page++) {
    const rows = await source.rows(batchId, after, PAGE_SIZE);
    check(Array.isArray(rows) && rows.length <= PAGE_SIZE, "archive_source_page_invalid");
    if (!rows.length) return result;
    for (const row of rows) {
      check(UUID.test(row?.id) && row.import_batch_id === batchId,
        "archive_source_row_identity_invalid");
      const id = String(row.id).toLowerCase();
      check(!after || id > after, "archive_source_order_invalid");
      check(dateMs(row.created_at) < now.getTime() - AGE_MS, "archive_source_row_too_recent");
      result.push(row);
      check(result.length <= MAX_ROWS, "archive_source_too_large");
      after = id;
    }
    if (rows.length < PAGE_SIZE) return result;
  }
  throw new VmsArchiveError("archive_source_too_large");
}

export async function prepareFromSource(source, projectRef, batchId, now = new Date()) {
  const batch = validateBatch(await source.batch(batchId), batchId, now);
  const beforeCount = await source.count(batchId);
  check(Number.isSafeInteger(beforeCount) && beforeCount > 0 && beforeCount <= MAX_ROWS, "archive_source_count_invalid");
  const rows = await readBatchRows(source, batchId, now);
  check(rows.length === beforeCount, "archive_source_count_changed");
  return prepareArchive(projectRef, batch, rows, now);
}

async function readVerified(store, part) {
  const bytes = await store.get(part.key, part.bytes);
  check(bytes !== null && bytes.length === part.bytes && hash(bytes) === part.sha256, "archive_readback_mismatch");
  const lines = decode(bytes).trimEnd().split("\n");
  check(lines.length === part.rows, "archive_restore_row_count_invalid");
  let previous = "";
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { throw new VmsArchiveError("archive_restore_invalid_json"); }
    check(UUID.test(row.id) && (!previous || String(row.id).toLowerCase() > previous),
      "archive_restore_row_order_invalid");
    previous = String(row.id).toLowerCase();
  }
  check(lines.length && JSON.parse(lines[0]).id === part.firstId
    && JSON.parse(lines[lines.length - 1]).id === part.lastId, "archive_restore_boundary_invalid");
  return lines.length;
}

export async function verifyArchive(store, projectRef, batchId) {
  const prefix = archivePrefix(projectRef, batchId);
  const body = await store.get(prefix + "manifest.json", MAX_MANIFEST_BYTES);
  check(body !== null, "archive_manifest_missing");
  let receipt;
  try { receipt = JSON.parse(decode(body)); }
  catch { throw new VmsArchiveError("archive_manifest_invalid"); }
  check(receipt?.version === 1 && receipt.state === "copy_verified_source_retained"
    && receipt.projectRef === projectRef && receipt.batchId === batchId
    && receipt.sourceTable === "public.vms_import_rows" && receipt.originalRowsDeleted === 0
    && Array.isArray(receipt.chunks) && receipt.chunks.length > 0
    && receipt.chunks.length <= Math.ceil(MAX_ROWS / PAGE_SIZE),
    "archive_manifest_invalid");
  let count = 0, totalBytes = 0;
  for (const chunk of receipt.chunks) {
    check(chunk.key.startsWith(prefix + "objects/") && SHA.test(chunk.sha256)
      && chunk.key === prefix + "objects/" + chunk.sha256 + ".ndjson"
      && Number.isSafeInteger(chunk.rows) && chunk.rows > 0 && chunk.rows <= PAGE_SIZE
      && Number.isSafeInteger(chunk.bytes) && chunk.bytes > 0 && chunk.bytes <= MAX_CHUNK_BYTES,
      "archive_manifest_invalid");
    count += await readVerified(store, chunk);
    totalBytes += chunk.bytes;
  }
  check(count === receipt.rowCount && totalBytes === receipt.totalBytes && count <= MAX_ROWS,
    "archive_restore_totals_invalid");
  return { batchId, rowCount: count, totalBytes,
    manifestSha256: hash(body), archiveVerified: true, sourceRowsRetained: true };
}

export async function runArchive({ source, store, projectRef, batchId, mode = "inspect", approval = "", now = new Date() }) {
  check(["inspect", "copy", "verify"].includes(mode), "archive_mode_invalid");
  if (mode === "verify") {
    check(store !== null && store !== undefined, "archive_store_not_configured");
    return verifyArchive(store, projectRef, batchId);
  }
  const prepared = await prepareFromSource(source, projectRef, batchId, now);
  const summary = { mode, batchId, rows: prepared.receipt.rowCount,
    bytes: prepared.receipt.totalBytes, chunkCount: prepared.chunks.length,
    approvalSha256: prepared.manifestSha256, sourceRowsRetained: true,
    originalsDeleted: 0 };
  if (mode === "inspect") return summary;
  check(approval === prepared.manifestSha256, "archive_approval_mismatch");
  check(store !== null && store !== undefined, "archive_store_not_configured");
  const existing = await store.get(prepared.manifestKey, MAX_MANIFEST_BYTES);
  if (existing !== null) check(hash(existing) === prepared.manifestSha256,
    "archive_existing_manifest_conflict");
  for (let i = 0; i < prepared.receipt.chunks.length; i++) {
    const part = prepared.receipt.chunks[i];
    if ((await store.get(part.key, part.bytes)) === null) {
      await store.putIfAbsent(part.key, prepared.chunks[i], "application/x-ndjson");
    }
    await readVerified(store, part);
  }
  // Copy-only staging: compare complete rows and batch status a second time.
  const later = await prepareFromSource(source, projectRef, batchId, now);
  check(later.manifestSha256 === prepared.manifestSha256, "archive_source_changed");
  if (existing === null) {
    await store.putIfAbsent(prepared.manifestKey, prepared.body, "application/json");
  }
  const verified = await verifyArchive(store, projectRef, batchId);
  check(verified.manifestSha256 === prepared.manifestSha256, "archive_manifest_readback_mismatch");
  return { ...summary, archiveVerified: true, sourceRowsRetained: true,
    originalsDeleted: 0, mode: "copy_only" };
}

export function parseArgs(argv) {
  const output = { batchId: "", mode: "inspect", approval: "" };
  const used = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    check(!used.has(flag), "archive_arguments_invalid");
    used.add(flag);
    if (flag === "--copy" || flag === "--verify") {
      check(output.mode === "inspect", "archive_arguments_invalid");
      output.mode = flag === "--copy" ? "copy" : "verify";
      continue;
    }
    check(["--batch-id", "--approve-sha256"].includes(flag), "archive_arguments_invalid");
    const value = argv[++i];
    check(typeof value === "string" && !value.startsWith("--"), "archive_arguments_invalid");
    if (flag === "--batch-id") output.batchId = value;
    else output.approval = value;
  }
  check(UUID.test(output.batchId) && (output.mode === "copy" ? SHA.test(output.approval) : !output.approval),
    "archive_arguments_invalid");
  return output;
}

export function createR2Store(env, projectRef, fetcher = fetch) {
  const accountId = env.SNACKY_VMS_ARCHIVE_ACCOUNT_ID ?? "";
  const bucket = env.SNACKY_VMS_ARCHIVE_BUCKET ?? "";
  const accessKeyId = env.SNACKY_VMS_ARCHIVE_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.SNACKY_VMS_ARCHIVE_SECRET_ACCESS_KEY ?? "";
  check(/^[a-f0-9]{32}$/.test(accountId) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    && accessKeyId.length > 5 && secretAccessKey.length > 5
    && !/[\r\n]/.test(accessKeyId + secretAccessKey), "archive_r2_config_invalid");
  const credentials = { accessKeyId, secretAccessKey };
  const prefix = "snacky-vms-archive/v1/" + projectRef + "/vms_import_rows/";
  const urlFor = key => {
    check(typeof key === "string" && key.startsWith(prefix) && !key.split("/").some(x => !x || x === "." || x === "..")
      && !/[\\\u0000-\u001f%?#]/.test(key), "archive_r2_key_invalid");
    return new URL("https://" + accountId + ".r2.cloudflarestorage.com/" + bucket + "/" + key);
  };
  return {
    async get(key, maxBytes) {
      const url = urlFor(key);
      const res = await fetcher(url, { method: "GET", headers: signedS3Headers("GET", url, credentials),
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (res.status === 404) { await res.body?.cancel(); return null; }
      if (res.status !== 200) { await res.body?.cancel(); throw new VmsArchiveError("archive_r2_read_failed"); }
      try { return await boundedResponseBytes(res, maxBytes); }
      catch { throw new VmsArchiveError("archive_r2_read_failed"); }
    },
    async putIfAbsent(key, bytes, contentType) {
      const url = urlFor(key);
      const extra = { "content-type": contentType, "if-none-match": "*" };
      const res = await fetcher(url, { method: "PUT",
        headers: signedS3Headers("PUT", url, credentials, bytes, extra),
        body: new Blob([new Uint8Array(bytes)], { type: contentType }),
        redirect: "error", signal: AbortSignal.timeout(20000) });
      await res.body?.cancel();
      if (res.status === 412) return false;
      check(res.ok, "archive_r2_write_failed");
      return true;
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accountRef = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(base ?? "")?.[1];
  check(!!accountRef && !!key && !/[\r\n]/.test(key), "archive_source_config_invalid");
  // This tool is run on a trusted owner's machine only. No key is ever logged or bundled.
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(base, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-snacky-archive": "copy-only-v1" } }
  });
  const source = {
    async batch(batchId) {
      const { data, error } = await supabase.from("vms_import_batches").select("*")
        .eq("id", batchId).maybeSingle();
      if (error) throw new VmsArchiveError("archive_batch_read_failed");
      return data;
    },
    async count(batchId) {
      const { count, error } = await supabase.from("vms_import_rows")
        .select("id", { head: true, count: "exact" }).eq("import_batch_id", batchId);
      if (error) throw new VmsArchiveError("archive_count_failed");
      return count;
    },
    async rows(batchId, after, limit) {
      let query = supabase.from("vms_import_rows").select("*")
        .eq("import_batch_id", batchId).order("id", { ascending: true }).limit(limit);
      if (after !== null) query = query.gt("id", after);
      const { data, error } = await query;
      if (error) throw new VmsArchiveError("archive_rows_read_failed");
      return data;
    }
  };
  const store = args.mode === "inspect" ? null : createR2Store(process.env, accountRef);
  const result = await runArchive({ ...args, source, store,
    projectRef: accountRef, batchId: args.batchId });
  // No private imported rows, access keys, or photo URLs in stdout.
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false,
      reason: error instanceof VmsArchiveError ? error.code : "archive_unexpected_error",
      originalRowsDeleted: 0 }));
    process.exitCode = 1;
  });
}
