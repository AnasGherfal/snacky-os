import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { archivePrefix, prepareArchive, readBatchRows, runArchive,
  validateBatch, verifyArchive, parseArgs, createR2Store } from "./vms-cold-archive.mjs";

const NOW = new Date("2026-11-07T12:00:00Z");
const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "thrthmeyhuhxnmizjhqx";
const id = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const batch = () => ({
  id: BATCH_ID, status: "deleted", is_active: false,
  imported_at: "2026-06-14T05:00:00Z", deleted_at: "2026-07-01T08:00:00Z",
  report_type: "vms_order_details_weekly", source_type: "csv", row_count: 0
});
const row = n => ({
  id: id(n), import_batch_id: BATCH_ID, row_number: n,
  created_at: "2026-06-14T05:00:00Z", raw_data: { product: "a", qty: n },
  normalized_data: { product: "a", quantity: n }, validation_status: "valid",
  validation_errors: [], matched_machine_id: null, matched_product_id: null
});
function fakeSource(seed = [row(1), row(2), row(3)]) {
  let entries = [...seed];
  let metadata = batch();
  return {
    get writes() { return 0; },
    async batch() { return structuredClone(metadata); },
    async count() { return entries.length; },
    async rows(_batchId, after, limit) {
      return entries.filter(x => !after || x.id > after).slice(0, limit).map(x => structuredClone(x));
    },
    mutate(callback) { entries = callback(entries); },
    mutateBatch(callback) { metadata = callback(metadata); }
  };
}
function fakeStore() {
  const objects = new Map();
  const calls = [];
  return {
    objects, calls,
    async get(key, maxBytes) {
      calls.push({ method: "GET", key });
      const data = objects.get(key);
      if (!data) return null;
      if (data.length > maxBytes) throw Error("too big");
      return new Uint8Array(data);
    },
    async putIfAbsent(key, data, type) {
      calls.push({ method: "PUT", key, type });
      if (objects.has(key)) return false;
      objects.set(key, new Uint8Array(data));
      return true;
    }
  };
}

test("only deleted inactive batches old enough can be archived", () => {
  assert.deepEqual(validateBatch(batch(), BATCH_ID, NOW), batch());
  assert.throws(() => validateBatch({ ...batch(), is_active: true }, BATCH_ID, NOW), /batch_not_deleted/);
  assert.throws(() => validateBatch({ ...batch(), status: "imported" }, BATCH_ID, NOW), /batch_not_deleted/);
  assert.throws(() => validateBatch({ ...batch(), deleted_at: "2026-10-31T00:00:00Z" }, BATCH_ID, NOW), /batch_too_recent/);
  assert.throws(() => validateBatch({ ...batch(), deleted_at: null }, BATCH_ID, NOW), /batch_not_deleted/);
  assert.throws(() => validateBatch(batch(), id(9), NOW), /invalid_batch/);
});

test("archive has immutable ordered raw and normalized data, and never has a deletion step", async () => {
  const source = fakeSource();
  const preview = await runArchive({ source, projectRef: PROJECT, batchId: BATCH_ID, now: NOW });
  assert.equal(preview.mode, "inspect");
  assert.equal(preview.rows, 3);
  assert.equal(preview.originalsDeleted, 0);
  assert.match(preview.approvalSha256, /^[a-f0-9]{64}$/);
  const store = fakeStore();
  const copied = await runArchive({ source, store, projectRef: PROJECT,
    batchId: BATCH_ID, mode: "copy", approval: preview.approvalSha256, now: NOW });
  assert.equal(copied.archiveVerified, true);
  assert.equal(copied.originalsDeleted, 0);
  assert.equal(copied.rows, 3);
  assert.equal(store.objects.size, 2);
  const restored = await verifyArchive(store, PROJECT, BATCH_ID);
  assert.equal(restored.rowCount, 3);
  assert.equal(restored.manifestSha256, preview.approvalSha256);
  const body = [...store.objects.entries()].find(([key]) => key.endsWith(".ndjson"))[1];
  const parsed = new TextDecoder().decode(body).trim().split("\n").map(JSON.parse);
  assert.deepEqual(parsed, [row(1), row(2), row(3)]);
  assert.equal(source.writes, 0);
  assert.ok(store.calls.every(call => ["GET", "PUT"].includes(call.method)));
});

test("repeated archival is idempotent, conflicting source requires a new approval and existing receipt blocks replacement", async () => {
  const store = fakeStore(), source = fakeSource();
  const preview = await runArchive({ source, projectRef: PROJECT, batchId: BATCH_ID, now: NOW });
  await runArchive({ source, store, projectRef: PROJECT, batchId: BATCH_ID,
    mode: "copy", approval: preview.approvalSha256, now: NOW });
  const size = store.objects.size;
  await runArchive({ source, store, projectRef: PROJECT, batchId: BATCH_ID,
    mode: "copy", approval: preview.approvalSha256, now: NOW });
  assert.equal(store.objects.size, size);
  source.mutate(rows => rows.map(x => x.id === id(2)
    ? { ...x, raw_data: { product: "changed", qty: 2 } } : x));
  await assert.rejects(runArchive({ source, store, projectRef: PROJECT, batchId: BATCH_ID,
    mode: "copy", approval: preview.approvalSha256, now: NOW }), /archive_approval_mismatch/);
  const newApproval = (await runArchive({ source, projectRef: PROJECT,
    batchId: BATCH_ID, now: NOW })).approvalSha256;
  await assert.rejects(runArchive({ source, store, projectRef: PROJECT, batchId: BATCH_ID,
    mode: "copy", approval: newApproval, now: NOW }), /archive_existing_manifest_conflict/);
});

test("bad readback cannot produce a verified archive manifest", async () => {
  const store = fakeStore(), source = fakeSource();
  const preview = await runArchive({ source, projectRef: PROJECT, batchId: BATCH_ID, now: NOW });
  await runArchive({ source, store, projectRef: PROJECT, batchId: BATCH_ID,
    mode: "copy", approval: preview.approvalSha256, now: NOW });
  const path = [...store.objects.keys()].find(x => x.endsWith(".ndjson"));
  store.objects.set(path, new Uint8Array([1,2,3]));
  await assert.rejects(verifyArchive(store, PROJECT, BATCH_ID), /archive_readback_mismatch/);
});

test("changing batch status between approval and final copy fails closed", async () => {
  const source = fakeSource(), store = fakeStore();
  const dry = await runArchive({ source, projectRef: PROJECT, batchId: BATCH_ID, now: NOW });
  let reads = 0;
  const guarded = {
    ...source,
    async batch() {
      reads++;
      if (reads > 1) return { ...batch(), status: "imported", is_active: true };
      return batch();
    }
  };
  await assert.rejects(runArchive({ source: guarded, store, projectRef: PROJECT,
    batchId: BATCH_ID, mode: "copy", approval: dry.approvalSha256, now: NOW }),
    /batch_not_deleted_or_still_active/);
  assert.ok(![...store.objects.keys()].some(x => x.endsWith("manifest.json")));
});

test("source counts, ID order, created-at age and payload bounds fail closed", async () => {
  await assert.rejects(readBatchRows({
    rows: async () => [{ ...row(1), created_at: "2026-11-01T10:00:00Z" }]
  }, BATCH_ID, NOW), /archive_source_row_too_recent/);
  const unsorted = [row(3), row(1)];
  assert.throws(() => prepareArchive(PROJECT, batch(), unsorted, NOW), /archive_row_order_invalid/);
  const source = fakeSource();
  source.count = async () => 25;
  await assert.rejects(runArchive({ source, projectRef: PROJECT, batchId: BATCH_ID, now: NOW }),
    /archive_source_count_changed/);
});

test("bad arguments and unrelated R2 keys are rejected", () => {
  assert.deepEqual(parseArgs(["--batch-id", BATCH_ID]), { batchId: BATCH_ID, mode: "inspect", approval: "" });
  assert.throws(() => parseArgs(["--batch-id", BATCH_ID, "--copy"]), /archive_arguments_invalid/);
  assert.throws(() => parseArgs(["--batch-id", BATCH_ID, "--verify", "--copy"]), /archive_arguments_invalid/);
  assert.throws(() => parseArgs(["--batch-id", "../x"]), /archive_arguments_invalid/);
  assert.equal(archivePrefix(PROJECT, BATCH_ID).includes("vms_import_rows"), true);
  assert.throws(() => createR2Store({}), /archive_r2_config_invalid/);
});

test("no source DELETE, TRUNCATE, purge or admin HTTP write commands exist in the archive runner", () => {
  const src = fs.readFileSync("scripts/vms-cold-archive.mjs", "utf8");
  assert.doesNotMatch(src, /\.delete\s*\(|\.remove\s*\(|\.rpc\s*\(|\bTRUNCATE\b\s+TABLE|\bDELETE\b\s+FROM/i);
  assert.match(src, /sourceRowsRetained: true/);
  assert.match(src, /originalsDeleted: 0/);
  assert.match(src, /archive_approval_mismatch/);
  assert.match(src, /archive_source_changed/);
});

test("manual VMS archive action is opt-in, copy-only, and never runs on push", () => {
  const workflow = fs.readFileSync(".github/workflows/vms-cold-archive-manual.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  // The four secrets are scoped to the GitHub Production environment, not repository secrets.
  assert.match(workflow, /^    environment: Production$/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /github\.actor == 'AnasGherfal'/);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request|schedule):/m);
  assert.match(workflow, /COPY ONLY - RETAIN SOURCE/);
  assert.match(workflow, /--copy --approve-sha256 "\$ARCHIVE_SHA"/);
  assert.match(workflow, /--verify/);
  assert.match(workflow, /--batch-id "\$BATCH_ID"/);
  assert.doesNotMatch(workflow, /(?:supabase db reset|DELETE FROM|TRUNCATE TABLE|--remove|--purge)/i);
  const verifySection = workflow.slice(workflow.indexOf("      - name: Verify readback from private R2"));
  assert.ok(verifySection.includes("SNACKY_R2_ACCESS_KEY_ID"));
  assert.ok(!verifySection.includes("SUPABASE_SERVICE_ROLE_KEY"));
});
