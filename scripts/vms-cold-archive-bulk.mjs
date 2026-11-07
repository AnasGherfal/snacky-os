#!/usr/bin/env node
// Fixed-scope, COPY-ONLY coordinator for the seven remaining reviewed VMS batches.
// Does not issue SQL writes, delete rows/files, or discover new batch IDs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const PROJECT_REF = "thrthmeyhuhxnmizjhqx";
export const PREVIOUSLY_VERIFIED = Object.freeze({
  id: "50e5063e-5595-4669-b8b1-34b0049bb6a7", expectedRows: 183
});
// Fixed against a read-only production SQL review on 2026-11-07.
// Eligibility/status/age are *revalidated* by the original single-batch runner.
export const REMAINING = Object.freeze([
  { id: "9a6d9703-7bcc-4e82-84a7-1dfbffc98366", expectedRows: 249 },
  { id: "ebe64093-f5e8-4d8d-82de-15c40b54fd34", expectedRows: 1921 },
  { id: "a6ae1837-0411-4831-9052-f7a5bbb0ad88", expectedRows: 2696 },
  { id: "dbb4caba-634b-4bd4-a192-8c4736fe93ef", expectedRows: 2696 },
  { id: "23b7e1df-4707-444a-bcb1-905742331e45", expectedRows: 2696 },
  { id: "2aa9ca15-39bf-43b5-8d66-e9acbd6d1a0b", expectedRows: 2822 },
  { id: "4f5678c3-445b-404d-8661-89baac1f0933", expectedRows: 2871 }
].map(x => Object.freeze(x)));

const SHA = /^[a-f0-9]{64}$/;
const check = (good, message) => { if (!good) throw new Error(message); };
const hash = data => createHash("sha256").update(data).digest("hex");
export function parseBulkArgs(argv) {
  const args = { mode: "", approval: "" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    check(!seen.has(key) && ["--mode", "--approve-sha256"].includes(key), "invalid_arguments");
    seen.add(key);
    const val = argv[++i];
    check(typeof val === "string" && val.length > 0 && !val.startsWith("--"), "invalid_arguments");
    if (key === "--mode") args.mode = val;
    if (key === "--approve-sha256") args.approval = val;
  }
  check(["inspect", "copy", "verify"].includes(args.mode), "invalid_mode");
  check(args.mode === "copy" ? SHA.test(args.approval) : args.approval === "", "invalid_approval");
  return args;
}

export function validateInspection(batch, result) {
  check(result?.ok === true && result.mode === "inspect" && result.batchId === batch.id,
    "inspection_identity_invalid");
  check(result.rows === batch.expectedRows && Number.isSafeInteger(result.bytes) && result.bytes > 0,
    "inspection_row_count_or_size_changed");
  check(Number.isSafeInteger(result.chunkCount) && result.chunkCount > 0
    && result.chunkCount <= Math.ceil(batch.expectedRows / 250), "inspection_chunks_invalid");
  check(SHA.test(result.approvalSha256) && result.originalsDeleted === 0
    && result.sourceRowsRetained === true, "inspection_not_safe");
  return {
    batchId: batch.id, rows: result.rows, bytes: result.bytes,
    chunkCount: result.chunkCount, snapshotSha256: result.approvalSha256
  };
}

export function bundleApproval(inspections) {
  check(Array.isArray(inspections) && inspections.length === REMAINING.length, "bundle_count_invalid");
  for (let i = 0; i < inspections.length; i++) {
    const row = inspections[i], expected = REMAINING[i];
    check(row.batchId === expected.id && row.rows === expected.expectedRows
      && Number.isSafeInteger(row.bytes) && row.bytes > 0
      && SHA.test(row.snapshotSha256), "bundle_source_invalid");
  }
  return hash(JSON.stringify({
    version: 1, projectRef: PROJECT_REF, intent: "copy_verified_source_retained",
    originalDeletionEnabled: false, batches: inspections
  }));
}

function parseChildResult(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  check(lines.length > 0, "archive_child_no_result");
  let output;
  try { output = JSON.parse(lines[lines.length - 1]); }
  catch { throw new Error("archive_child_invalid_result"); }
  check(output?.ok === true, "archive_child_reported_failure");
  return output;
}

const RETRYABLE_SOURCE_ERRORS = new Set([
  "archive_batch_read_failed", "archive_count_failed", "archive_rows_read_failed",
]);

/** Only emit known, code-only reasons from a child process. Never echo stderr,
 * URLs, tokens, SQL payloads or raw imported data to GitHub Actions logs. */
export function safeChildFailureCode(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-25);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; }
    if (parsed?.ok !== false || typeof parsed.reason !== "string") continue;
    const code = parsed.reason;
    return /^[a-z][a-z0-9_]{0,70}$/.test(code) ? code : "unknown";
  }
  return "unknown";
}

export async function runSingle(batch, mode, approval = "",
  spawn = spawnSync, env = process.env, sleep = delay) {
  check(mode === "inspect" || mode === "copy" || mode === "verify", "invalid_child_mode");
  check(mode === "copy" ? SHA.test(approval) : approval === "", "invalid_child_approval");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "vms-cold-archive.mjs");
  const argv = ["--experimental-strip-types", cli, "--batch-id", batch.id];
  if (mode === "copy") argv.push("--copy", "--approve-sha256", approval);
  if (mode === "verify") argv.push("--verify");

  // An occasional Supabase REST 500 is retried up to twice because these are
  // idempotent reads. Never retry permission failures, changed source rows,
  // mismatched approvals, archive-integrity failures or unknown errors.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = spawn(process.execPath, argv, {
      encoding: "utf8", env, timeout: 120_000, maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    if (!run.error && run.status === 0) return parseChildResult(run.stdout || "");
    const code = safeChildFailureCode(run.stderr);
    if (!run.error && attempt < 3 && RETRYABLE_SOURCE_ERRORS.has(code)) {
      await sleep(attempt * 2000);
      continue;
    }
    throw new Error("archive_child_" + code + "_for_batch_" + batch.id);
  }
  throw new Error("archive_child_retry_exhausted_for_batch_" + batch.id);
}
export async function runBulk(args, deps = {}) {
  const run = deps.runSingle ?? runSingle;
  const output = deps.output ?? (value => console.log(JSON.stringify(value)));
  if (args.mode === "verify") {
    const items = [PREVIOUSLY_VERIFIED, ...REMAINING];
    let total = 0, bytes = 0;
    for (const batch of items) {
      const result = await run(batch, "verify");
      check(result.ok === true && result.batchId === batch.id &&
        result.rowCount === batch.expectedRows && result.archiveVerified === true
        && result.sourceRowsRetained === true && SHA.test(result.manifestSha256)
        && Number.isSafeInteger(result.totalBytes) && result.totalBytes > 0,
        "verification_failed_for_batch_" + batch.id);
      total += result.rowCount; bytes += result.totalBytes;
      output({ mode: "verify", batchId: batch.id, rows: result.rowCount,
        archiveVerified: true, originalsDeleted: 0 });
    }
    check(total === 16134, "verification_total_invalid");
    const summary = { ok: true, mode: "verify_all", batchesVerified: items.length,
      totalRowsVerified: total, totalBytesVerified: bytes, originalsDeleted: 0 };
    output(summary);
    return summary;
  }

  const inspected = [];
  for (const batch of REMAINING) {
    const result = await run(batch, "inspect");
    inspected.push(validateInspection(batch, result));
  }
  const combined = bundleApproval(inspected);
  const size = inspected.reduce((n, x) => n + x.bytes, 0);
  const total = inspected.reduce((n, x) => n + x.rows, 0);
  check(total === 15951, "inspection_total_invalid");
  const manifest = { ok: true, mode: "inspect_remaining", batches: inspected.length,
    rowCount: total, bytes: size, bundleApprovalSha256: combined,
    sourceRowsRetained: true, originalsDeleted: 0 };
  output(manifest);
  if (args.mode === "inspect") return manifest;
  // No external writes are attempted unless every source batch matches the
  // reviewed fixed allowlist and the precise approved *bundle* fingerprint.
  check(combined === args.approval, "bundle_approval_mismatch");
  let copied = 0, bytesCopied = 0;
  for (const item of inspected) {
    const result = await run({ id: item.batchId }, "copy", item.snapshotSha256);
    check(result.ok === true && result.mode === "copy_only"
      && result.batchId === item.batchId && result.rows === item.rows
      && result.approvalSha256 === item.snapshotSha256
      && result.archiveVerified === true && result.sourceRowsRetained === true
      && result.originalsDeleted === 0, "copy_verification_failed_for_batch_" + item.batchId);
    copied += result.rows;
    bytesCopied += result.bytes;
    output({ mode: "copy_verified", batchId: item.batchId,
      rows: result.rows, archiveVerified: true, originalsDeleted: 0 });
  }
  check(copied === 15951, "copied_total_invalid");
  const summary = { ok: true, mode: "copy_remaining", batchesCopied: inspected.length,
    rowsCopied: copied, bytesCopied, archiveVerified: true, originalsDeleted: 0 };
  output(summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseBulkArgs(process.argv.slice(2));
    await runBulk(args);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "archive_failed", originalsDeleted: 0 }));
    process.exitCode = 1;
  }
}
