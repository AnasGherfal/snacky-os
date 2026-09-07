import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/20260906154500_historical_route_deduction_atomicity.sql";
const previewMigrationPath = "supabase/migrations/20260906155900_atomic_historical_route_deduction_preview.sql";
const actionPath = "src/lib/historical-route-deduction-actions.ts";

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const migration = compact(read(migrationPath));
const rpc = compact(between(
  read(migrationPath),
  "create or replace function public.apply_historical_route_deduction_batch(",
  "revoke all on function public.apply_historical_route_deduction_batch(uuid, text)",
));
const applyAction = compact(between(
  read(actionPath),
  "export async function applyHistoricalRouteDeduction",
  "export async function cancelHistoricalRouteDeduction",
));
const previewMigration = compact(read(previewMigrationPath));
const previewRpc = compact(between(
  read(previewMigrationPath),
  "create or replace function public.snacky_preview_historical_route_deduction_v1(",
  "revoke all on function public.snacky_preview_historical_route_deduction_v1(",
));
const previewAction = compact(between(
  read(actionPath),
  "export async function previewHistoricalRouteDeduction",
  "export async function applyHistoricalRouteDeduction",
));
const previewSubmissionIdentity = compact(between(
  read(actionPath),
  "const clientSubmissionId",
  "const { data, error }",
));

test("historical preview is one private authenticated database command", () => {
  assert.match(previewMigration, /create table if not exists public\.historical_route_deduction_preview_operations/i);
  assert.match(previewMigration, /client_submission_id text primary key/i);
  assert.match(previewMigration, /batch_id uuid not null unique[\s\S]*on delete restrict/i);
  assert.match(previewMigration, /request_payload jsonb not null/i);
  assert.match(previewMigration, /result_payload jsonb not null/i);
  assert.match(previewMigration, /alter table public\.historical_route_deduction_preview_operations enable row level security/i);
  assert.match(previewMigration, /revoke all on table public\.historical_route_deduction_preview_operations from public, anon, authenticated, service_role/i);
  assert.match(previewMigration, /before update or delete on public\.historical_route_deduction_preview_operations[\s\S]*enable always trigger trg_hist_deduction_preview_operation_immutable/i);
  assert.match(previewMigration, /before truncate on public\.historical_route_deduction_preview_operations[\s\S]*enable always trigger trg_hist_deduction_preview_operation_no_truncate/i);

  assert.match(previewRpc, /security definer set search_path = ''/i);
  assert.match(previewRpc, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(previewRpc, /snacky_current_profile_has_any_role\(array\['owner', 'admin'\]\)/i);
  assert.match(previewRpc, /v_actor_team_member_id := public\.snacky_current_team_member_id\(\)/i);
  assert.match(previewMigration, /grant execute on function public\.snacky_preview_historical_route_deduction_v1\( text, text, text, uuid, jsonb \) to authenticated/i);
});

test("preview retry proves the exact request, parent, lines, and immutable result", () => {
  const commandMutex = previewRpc.indexOf("'snacky:historical-route-deduction-preview:v1:' || v_submission_id");
  const operationLookup = previewRpc.indexOf("from public.historical_route_deduction_preview_operations operation_row", commandMutex);
  const replayBranch = previewRpc.indexOf("if found then", operationLookup);
  const batchInsert = previewRpc.indexOf("insert into public.historical_route_deduction_batches", replayBranch);
  const lineInsert = previewRpc.indexOf("insert into public.historical_route_deduction_lines", batchInsert);
  const receiptInsert = previewRpc.indexOf("insert into public.historical_route_deduction_preview_operations", lineInsert);

  assert.ok(commandMutex >= 0 && operationLookup > commandMutex && replayBranch > operationLookup);
  assert.ok(batchInsert > replayBranch && lineInsert > batchInsert && receiptInsert > lineInsert,
    "batch, every line, and its completed receipt must be written in one RPC transaction");
  assert.match(previewRpc, /v_operation\.actor_user_id is distinct from v_actor_user_id/i);
  assert.match(previewRpc, /v_operation\.actor_team_member_id is distinct from v_actor_team_member_id/i);
  assert.match(previewRpc, /v_operation\.request_payload is distinct from v_request_payload/i);
  assert.match(previewRpc, /v_batch\.original_text is distinct from v_original_text/i);
  assert.match(previewRpc, /v_persisted_request_lines_payload is distinct from v_request_lines_payload/i);
  assert.match(previewRpc, /v_operation\.result_payload is distinct from v_result_payload/i);
  assert.match(previewRpc, /'lines', v_persisted_lines_payload/i);
  assert.match(previewRpc, /return query select v_batch\.id, v_batch\.row_count, v_batch\.ready_row_count, v_batch\.needs_review_count, v_batch\.total_quantity, true/i);
});

test("stock warnings are server-derived result data and do not break an exact retry", () => {
  assert.match(previewRpc, /from public\.current_inventory_by_location inventory where inventory\.location_type = 'storage' and inventory\.location_id = p_default_storage_location_id/i);
  assert.match(previewRpc, /rows between unbounded preceding and 1 preceding/i);
  assert.match(previewRpc, /'storage_negative_warning', case when running_line\.status = 'ready' then running_line\.storage_qty_before - running_line\.quantity < 0/i);
  assert.match(previewRpc, /'lines', v_request_lines_payload/i);
  assert.match(previewRpc, /line_element\.value - 'storage_location_id' - 'storage_qty_before' - 'storage_qty_after' - 'storage_negative_warning'/i);

  const selectedStoragePreview = ({ selectedLocationId, balances, requested }) => {
    const selectedOnHand = balances
      .filter((row) => row.locationId === selectedLocationId)
      .reduce((sum, row) => sum + row.quantity, 0);
    return { before: selectedOnHand, after: selectedOnHand - requested };
  };
  assert.deepEqual(selectedStoragePreview({
    selectedLocationId: "storage-a",
    balances: [
      { locationId: "storage-a", quantity: 2 },
      { locationId: "storage-b", quantity: 100 },
    ],
    requested: 5,
  }), { before: 2, after: -3 }, "another storage must not hide a shortage at the selected destination");
});

test("the app cannot leave a partial historical preview batch", () => {
  assert.match(previewAction, /getAuthenticatedSupabaseServerClient\(\)/i);
  assert.match(previewSubmissionIdentity, /historical-route-deduction:preview:\$\{contentHash\(JSON\.stringify\(\{/i);
  assert.match(previewSubmissionIdentity, /actorUserId: profile\.id,[\s\S]*originalText,[\s\S]*notes/i);
  assert.doesNotMatch(previewSubmissionIdentity, /defaultStorageLocationId:/i,
    "transient storage selection must not silently create a second command after a lost response");
  assert.match(previewAction, /rpc\("snacky_preview_historical_route_deduction_v1"/i);
  assert.doesNotMatch(previewAction, /\.from\("historical_route_deduction_batches"\)[\s\S]*\.insert\(/i);
  assert.doesNotMatch(previewAction, /\.from\("historical_route_deduction_lines"\)[\s\S]*\.insert\(/i);
  assert.match(previewAction, /atomic historical preview database update is not active yet\. No batch was created\./i);
  assert.match(previewAction, /rowCount !== parsed\.lines\.length/i);
  assert.match(previewAction, /idempotencyKey: clientSubmissionId/i);
});

function runPreviewModel(state, { submissionId, request, lineCount, failAtLine = null, loseResponse = false }) {
  const existing = state.operations.get(submissionId);
  if (existing) {
    assert.deepEqual(existing.request, request, "same submission id must retain its exact request");
    return { ...existing.result, alreadyPreviewed: true };
  }

  const stagedBatch = { id: `batch-${state.nextBatch}`, rowCount: lineCount };
  const stagedLines = [];
  for (let index = 0; index < lineCount; index += 1) {
    if (index === failAtLine) throw new Error("simulated line constraint failure");
    stagedLines.push({ batchId: stagedBatch.id, lineNumber: index + 1 });
  }
  const result = { batchId: stagedBatch.id, rowCount: lineCount };

  // This assignment models the RPC commit boundary. Nothing above is visible
  // if a line insert throws.
  state.nextBatch += 1;
  state.batches.push(stagedBatch);
  state.lines.push(...stagedLines);
  state.operations.set(submissionId, { request: structuredClone(request), result });
  if (loseResponse) throw new Error("simulated lost response after commit");
  return { ...result, alreadyPreviewed: false };
}

test("a line failure rolls back the header, and retry/lost-response replay never duplicates", () => {
  const failedState = { nextBatch: 1, batches: [], lines: [], operations: new Map() };
  assert.throws(() => runPreviewModel(failedState, {
    submissionId: "preview-1",
    request: { source: "old route" },
    lineCount: 3,
    failAtLine: 1,
  }));
  assert.deepEqual({ batches: failedState.batches, lines: failedState.lines, receipts: failedState.operations.size }, {
    batches: [], lines: [], receipts: 0,
  });
  const retryResult = runPreviewModel(failedState, {
    submissionId: "preview-1",
    request: { source: "old route" },
    lineCount: 3,
  });
  assert.equal(retryResult.alreadyPreviewed, false);
  assert.equal(failedState.batches.length, 1);
  assert.equal(failedState.lines.length, 3);

  const lostState = { nextBatch: 1, batches: [], lines: [], operations: new Map() };
  assert.throws(() => runPreviewModel(lostState, {
    submissionId: "preview-lost",
    request: { source: "same old route" },
    lineCount: 2,
    loseResponse: true,
  }));
  const replay = runPreviewModel(lostState, {
    submissionId: "preview-lost",
    request: { source: "same old route" },
    lineCount: 2,
  });
  assert.equal(replay.alreadyPreviewed, true);
  assert.equal(lostState.batches.length, 1);
  assert.equal(lostState.lines.length, 2);
  assert.equal(lostState.operations.size, 1);
});

test("the unsafe public actor-spoofing signature is removed by a forward migration", () => {
  assert.match(migration, /revoke all on function public\.apply_historical_route_deduction_batch\(uuid, uuid\) from public, anon, authenticated, service_role/i);
  assert.match(migration, /drop function if exists public\.apply_historical_route_deduction_batch\(uuid, uuid\)/i);
  assert.match(rpc, /security definer set search_path = ''/i);
  assert.match(rpc, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(rpc, /snacky_current_profile_has_any_role\(array\['owner', 'admin'\]\)/i);
  assert.match(rpc, /v_actor_team_member_id := public\.snacky_current_team_member_id\(\)/i);
  assert.doesNotMatch(rpc, /actor_team_member_id uuid[,) ]/i,
    "the caller must not be able to choose the audit actor");
  assert.match(migration, /grant execute on function public\.apply_historical_route_deduction_batch\(uuid, text\) to authenticated/i);
});

test("one private operation receipt binds a batch and stable submission to an exact result", () => {
  assert.match(migration, /create table if not exists public\.historical_route_deduction_apply_operations/i);
  assert.match(migration, /unique \(batch_id\)/i);
  assert.match(migration, /unique \(client_submission_id\)/i);
  assert.match(migration, /request_payload jsonb not null/i);
  assert.match(migration, /result_payload jsonb/i);
  assert.match(migration, /actor_user_id uuid not null references auth\.users\(id\) on delete restrict/i);
  assert.match(migration, /actor_team_member_id uuid not null references public\.team_members\(id\) on delete restrict/i);
  assert.match(migration, /alter table public\.historical_route_deduction_apply_operations enable row level security/i);
  assert.match(migration, /revoke all on table public\.historical_route_deduction_apply_operations from public, anon, authenticated/i);

  const operationLookup = rpc.indexOf("from public.historical_route_deduction_apply_operations operation_row where operation_row.batch_id = target_batch_id for update");
  const replayBranch = rpc.indexOf("if found then", operationLookup);
  const appliedRejection = rpc.indexOf("if v_batch.status = 'applied' then", replayBranch);
  const movementInsert = rpc.indexOf("insert into public.inventory_movements", appliedRejection);
  assert.ok(operationLookup >= 0 && replayBranch > operationLookup && appliedRejection > replayBranch,
    "exact replay must be checked before the applied-state rejection");
  assert.ok(movementInsert > appliedRejection, "a replay must return before any new ledger insert");
  assert.match(rpc, /v_operation\.request_payload is distinct from v_request_payload/i);
  assert.match(rpc, /v_operation\.result_payload is distinct from v_result_payload/i);
  assert.match(rpc, /return query select v_applied_count, v_review_count, true/i);
});

test("one immutable actor-bound source claim prevents cross-batch duplicate content", () => {
  assert.match(migration, /create table public\.historical_route_deduction_source_claims/i);
  assert.match(migration, /source_content_hash text primary key/i);
  assert.match(migration, /batch_id uuid not null unique[\s\S]*on delete restrict/i);
  assert.match(migration, /operation_id uuid unique[\s\S]*on delete restrict/i);
  assert.match(migration, /actor_user_id uuid not null references auth\.users\(id\) on delete restrict/i);
  assert.match(migration, /actor_team_member_id uuid not null references public\.team_members\(id\) on delete restrict/i);
  assert.match(migration, /alter table public\.historical_route_deduction_source_claims enable row level security/i);
  assert.match(migration, /revoke all on table public\.historical_route_deduction_source_claims from public, anon, authenticated/i);
  assert.match(migration, /before insert or update or delete on public\.historical_route_deduction_source_claims[\s\S]*enable always trigger trg_hist_deduction_source_claim_immutable_row/i);
  assert.match(migration, /Historical deduction source claims are immutable/i);

  const sourceMutex = rpc.indexOf("'snacky:historical-route-deduction-source:' || v_source_content_hash");
  const sourceClaimLookup = rpc.indexOf("from public.historical_route_deduction_source_claims claim_row where claim_row.source_content_hash = v_source_content_hash for update", sourceMutex);
  const operationInsert = rpc.indexOf("insert into public.historical_route_deduction_apply_operations", sourceClaimLookup);
  const sourceClaimInsert = rpc.indexOf("insert into public.historical_route_deduction_source_claims", operationInsert);
  const storageLock = rpc.indexOf("pg_catalog.hashtext(v_stock.product_id::text), pg_catalog.hashtext(v_stock.storage_location_id::text)", sourceClaimInsert);

  assert.ok(sourceMutex >= 0 && sourceClaimLookup > sourceMutex,
    "same-content batches must serialize and inspect the immutable winner");
  assert.ok(operationInsert > sourceClaimLookup && sourceClaimInsert > operationInsert && storageLock > sourceClaimInsert,
    "the actor-bound source claim must be inserted before any stock lock/write");
  assert.match(rpc, /This historical deduction source content was already claimed by batch %[\s\S]*Nothing was changed/i);
  assert.match(rpc, /v_source_claim\.actor_user_id is distinct from v_operation\.actor_user_id/i);
  assert.match(rpc, /v_source_claim\.actor_team_member_id is distinct from v_operation\.actor_team_member_id/i);
});

test("applied fingerprints are canonical, unique, and ambiguous legacy history fails review", () => {
  assert.match(migration, /Historical deduction fingerprint migration blocked: an applied batch has a blank source hash/i);
  assert.match(migration, /extensions\.digest\(batch_row\.original_text, 'sha256'\)/i);
  assert.match(migration, /having pg_catalog\.count\(\*\) > 1/i);
  assert.match(migration, /Historical deduction fingerprint migration blocked: multiple applied batches claim the same source content/i);
  assert.match(migration, /Historical deduction fingerprint migration blocked: an applied batch has no complete actor identity/i);
  assert.doesNotMatch(migration, /on conflict[\s\S]*historical_route_deduction_source_claims/i,
    "ambiguous legacy claims must never be silently merged");
  assert.match(migration, /create unique index if not exists idx_historical_route_deduction_batches_applied_source_once[\s\S]*where status = 'applied'/i);
  assert.match(rpc, /v_source_content_hash := pg_catalog\.encode\( extensions\.digest\(v_batch\.original_text, 'sha256'\), 'hex' \)/i);
  assert.match(rpc, /v_batch\.content_hash is distinct from v_source_content_hash/i);
  assert.match(migration, /Applied historical deduction source, totals, status, and actor are immutable/i);
  assert.match(migration, /An applied historical deduction requires its locked actor-bound source claim/i);
});

test("operation receipts are insert-pending, complete-once, and immutable even to service role", () => {
  const guard = compact(between(
    read(migrationPath),
    "create or replace function public.snacky_guard_historical_deduction_apply_operation()",
    "create or replace function public.snacky_reject_historical_deduction_operation_truncate()",
  ));

  assert.match(guard, /security invoker set search_path = ''/i);
  assert.match(guard, /if tg_op = 'INSERT' then if new\.result_payload is not null or new\.completed_at is not null then/i);
  assert.match(guard, /if tg_op = 'DELETE' then raise exception 'Historical deduction operation receipts cannot be deleted\.'/i);
  assert.match(guard, /if old\.result_payload is not null or old\.completed_at is not null then raise exception 'Completed historical deduction operation receipts are immutable\.'/i);
  assert.match(guard, /if new\.result_payload is null or new\.completed_at is null then/i);
  assert.match(guard, /new\.request_payload is distinct from old\.request_payload/i);
  assert.match(guard, /pg_catalog\.to_regprocedure\( 'public\.apply_historical_route_deduction_batch\(uuid,text\)' \)/i);
  assert.match(guard, /current_user::text is distinct from v_apply_function_owner/i);
  assert.match(guard, /current_setting\( 'snacky\.historical_route_deduction_apply_operation_id', true \)/i);
  assert.match(guard, /new\.result_payload ->> 'operation_id' is distinct from old\.id::text/i);
  assert.match(guard, /new\.result_payload ->> 'client_submission_id' is distinct from old\.client_submission_id/i);
  assert.match(guard, /claim_row\.source_content_hash = new\.result_payload ->> 'content_hash'/i);

  assert.match(migration, /before insert or update or delete on public\.historical_route_deduction_apply_operations for each row execute function public\.snacky_guard_historical_deduction_apply_operation\(\)/i);
  assert.match(migration, /enable always trigger trg_hist_deduction_apply_operation_immutable_row/i);
  assert.match(migration, /before truncate on public\.historical_route_deduction_apply_operations for each statement execute function public\.snacky_reject_historical_deduction_operation_truncate\(\)/i);
  assert.match(migration, /revoke all on function public\.snacky_guard_historical_deduction_apply_operation\(\) from public, anon, authenticated, service_role/i);

  const completion = rpc.indexOf("perform pg_catalog.set_config( 'snacky.historical_route_deduction_apply_operation_id', v_operation.id::text, true )");
  const receiptUpdate = rpc.indexOf("update public.historical_route_deduction_apply_operations operation_row", completion);
  const markerClear = rpc.indexOf("perform pg_catalog.set_config( 'snacky.historical_route_deduction_apply_operation_id', '', true )", receiptUpdate);
  assert.ok(completion >= 0 && receiptUpdate > completion && markerClear > receiptUpdate,
    "only the canonical apply function may open and immediately clear the receipt completion guard");
});

test("exact replay binds the receipt identity to every ledger row", () => {
  assert.match(rpc, /movement\.idempotency_payload is distinct from pg_catalog\.jsonb_build_object\( 'contract_version', 2, 'operation_id', v_operation\.id, 'client_submission_id', v_operation\.client_submission_id/i);
  assert.match(rpc, /v_line_payload := pg_catalog\.jsonb_build_object\( 'contract_version', 2, 'operation_id', v_operation\.id, 'client_submission_id', v_operation\.client_submission_id/i);
  assert.match(rpc, /v_result_payload := pg_catalog\.jsonb_build_object\( 'contract_version', 2, 'operation_id', v_operation\.id, 'client_submission_id', v_operation\.client_submission_id/i);
  assert.match(rpc, /v_operation\.result_payload is distinct from v_result_payload/i);
});

test("historical deductions follow parent, storage, product, then movement lock order", () => {
  const batchMutex = rpc.indexOf("'snacky:historical-route-deduction:' || target_batch_id::text");
  const batchLock = rpc.indexOf("from public.historical_route_deduction_batches batch_row where batch_row.id = target_batch_id for update");
  const lineLock = rpc.indexOf("from public.historical_route_deduction_lines line_row where line_row.import_batch_id = target_batch_id order by line_row.id for update");
  const firstStorageLock = rpc.indexOf("pg_catalog.hashtext(v_stock.product_id::text), pg_catalog.hashtext(v_stock.storage_location_id::text)");
  const firstProductLock = rpc.indexOf("from public.products product_row", firstStorageLock);
  const firstMovementLock = rpc.indexOf("from public.inventory_movements movement", firstProductLock);

  assert.ok(batchMutex >= 0 && batchLock > batchMutex && lineLock > batchLock);
  assert.ok(firstStorageLock > lineLock && firstProductLock > firstStorageLock && firstMovementLock > firstProductLock,
    "inventory locks must use batch/lines -> sorted storage pairs -> products -> movements");
  assert.match(rpc, /order by line_row\.storage_location_id, line_row\.product_id/i);
  assert.match(rpc, /order by product_row\.id for update/i);
  assert.match(rpc, /order by movement\.id for update/i);
});

test("physical stock and active route reservations are rechecked under storage locks", () => {
  const newWritePath = rpc.slice(rpc.indexOf("insert into public.historical_route_deduction_apply_operations"));
  const storageLock = newWritePath.indexOf("pg_catalog.pg_advisory_xact_lock");
  const stockRead = newWritePath.indexOf("from public.current_inventory_by_location inventory");
  const physicalGuard = newWritePath.indexOf("if v_on_hand < v_stock.quantity then");
  const reservationRead = newWritePath.indexOf("from public.route_stock_lines stock_line");
  const reservationGuard = newWritePath.indexOf("if v_on_hand - v_reserved < v_stock.quantity then");
  const movementInsert = newWritePath.indexOf("insert into public.inventory_movements");

  assert.ok(storageLock >= 0 && stockRead > storageLock && physicalGuard > stockRead);
  assert.ok(reservationRead > physicalGuard && reservationGuard > reservationRead && movementInsert > reservationGuard);
  assert.match(newWritePath, /Nothing was changed/i);
  assert.match(newWritePath, /route_row\.status::text in \( 'draft', 'assigned', 'in_progress'/i);

  const mayDeduct = ({ onHand, reserved, requested }) =>
    onHand >= requested && onHand - reserved >= requested;
  assert.equal(mayDeduct({ onHand: 10, reserved: 0, requested: 10 }), true);
  assert.equal(mayDeduct({ onHand: 9, reserved: 0, requested: 10 }), false);
  assert.equal(mayDeduct({ onHand: 10, reserved: 3, requested: 8 }), false);
});

test("each exact ledger row and its line/parent links commit in the RPC", () => {
  assert.match(rpc, /'historical-route-deduction:v2:' \|\| v_line\.id::text/i);
  assert.match(rpc, /idempotency_payload[\s\S]*v_line_payload/i);
  assert.match(rpc, /historical_route_deduction_line_id[\s\S]*v_line\.id/i);
  assert.match(rpc, /source_type[\s\S]*'historical_route_deduction'/i);
  assert.match(rpc, /update public\.historical_route_deduction_lines line_row set status = 'applied', movement_id = v_movement_id/i);
  assert.match(rpc, /get diagnostics v_updated_count = row_count; if v_updated_count <> 1 then raise exception 'Historical deduction line/i);
  assert.match(rpc, /update public\.historical_route_deduction_batches batch_row set status = 'applied'/i);
  assert.match(rpc, /update public\.historical_route_deduction_apply_operations operation_row set result_payload = v_result_payload/i);
  assert.match(rpc, /movement\.idempotency_payload is distinct from pg_catalog\.jsonb_build_object/i);
  assert.match(rpc, /movement\.line_total_lyd is not null/i);
  assert.match(rpc, /movement\.reversed_movement_id is not null/i);
});

test("the app applies through the signed-in RPC with a batch-stable operation id", () => {
  assert.match(applyAction, /requireOwnerAdminAuthenticated\(path\)/i);
  assert.match(applyAction, /rpc\("apply_historical_route_deduction_batch"/i);
  assert.match(applyAction, /p_client_submission_id: `historical-route-deduction:apply:\$\{batchId\}`/i);
  assert.doesNotMatch(applyAction, /actor_team_member_id/i);
  assert.doesNotMatch(applyAction, /getSupabaseAdminClient/i);
  assert.doesNotMatch(applyAction, /\.from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)\(/i);
  assert.match(applyAction, /atomic historical deduction database update is not active yet\. No inventory was changed/i);
  assert.match(applyAction, /idempotencyKey: `historical-route-deduction-apply:\$\{batchId\}`/i);
});

test("authenticated users retain ledger reads but no direct inventory writer", () => {
  assert.match(migration, /revoke all on table public\.inventory_movements from public, anon, authenticated/i);
  assert.match(migration, /grant select on table public\.inventory_movements to authenticated/i);
  assert.match(migration, /grant all on table public\.inventory_movements to service_role/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[^;]*inventory_movements[^;]*authenticated/i);
});
