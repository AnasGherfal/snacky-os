import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functionSource(source, functionName) {
  const start = source.indexOf(`export async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function sqlFunctionBody(source, functionName) {
  const start = source.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `${functionName} must exist`);
  const definition = source.slice(start);
  const body = definition.match(/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i);
  assert.ok(body, `${functionName} must use a dollar-quoted body`);
  return body[2];
}

test("stop completion verifies protected side effects and commits inventory as the signed-in actor", () => {
  const completeStop = functionSource(read("src/lib/operator-actions.ts"), "completeStop");
  const protectedClient = completeStop.indexOf("const completionWorkflowClient = getSupabaseAdminClient()");
  const inventoryCommit = completeStop.indexOf('"snacky_commit_route_stop_inventory_v1"');

  assert.ok(protectedClient >= 0, "the protected completion client must be required");
  assert.ok(inventoryCommit > protectedClient, "configuration failures must happen before inventory commits");
  assert.match(completeStop, /supabase\.rpc\(\s*"snacky_commit_route_stop_inventory_v1"/);
  assert.doesNotMatch(completeStop, /p_actor_user_id: rpcActorUserId/);
  assert.doesNotMatch(completeStop, /p_actor_team_member_id: rpcActorTeamMemberId/);
  assert.doesNotMatch(completeStop, /getSupabaseAdminClient\(\)\s*\?\?\s*supabase/);
  assert.match(completeStop, /from\("route_stop_inventory_commits"\)/);
  assert.match(completeStop, /terminalReceipt\?\.workflow_completed_at/);
  assert.match(completeStop, /terminalReceipt\.latest_submission_id === workflowSubmissionId/);
  assert.match(completeStop, /submitted stop payload was not applied/);
  assert.match(completeStop, /requestedPhotoPath\?\.startsWith\("storage-unavailable\/"\)/);
  assert.match(completeStop, /if \(photoUploadUnavailable\)[\s\S]*?Retry the photo upload/);
  assert.doesNotMatch(completeStop, /completionPhotoOriginalName\?\.trim\(\) \|\| existingProof\?\.machine_photo_path/);
  assert.match(completeStop, /machine_photo_reference: savedPhotoPath \|\| savedPhotoUrl/);

  const operatorActions = read("src/lib/operator-actions.ts");
  const uploadProof = functionSource(operatorActions, "uploadRefillProofPhoto");
  assert.match(uploadProof, /createHash\("sha256"\)[\s\S]*file\.arrayBuffer\(\)/);
  assert.match(uploadProof, /objectName = `\$\{safeFileSegment\(stopId, "stop"\)\}-\$\{photoDigest\}/);
});

test("cash, issues, and refill proof use stable retry identities", () => {
  const completeStop = functionSource(read("src/lib/operator-actions.ts"), "completeStop");

  assert.match(completeStop, /stableUuid\(`route-stop-cash-collection:\$\{stopId\}`\)/);
  assert.match(completeStop, /from\("cash_collections"\)[\s\S]*?\.upsert\(cashPayload, \{ onConflict: "id" \}\)/);
  assert.match(completeStop, /existingCashCollection\.counted_at/);
  assert.match(completeStop, /stableUuid\(`route-stop-issue:\$\{stopId\}`\)/);
  assert.match(completeStop, /from\("issues"\)[\s\S]*?\.upsert\([\s\S]*?\{ onConflict: "id" \}\)/);
  assert.match(completeStop, /stableUuid\(`route-stop-refill-history:\$\{stopId\}`\)/);
  assert.match(completeStop, /from\("machine_refill_history"\)[\s\S]*?\.upsert\([\s\S]*?\{ onConflict: "id" \}\)/);
  assert.match(completeStop, /throwActionError\(refillHistoryResult\.error, "Could not save the machine refill proof\."\)/);
  assert.doesNotMatch(completeStop, /continuing without optional refill proof/);
});

test("workflow status is the last required commit and is handled atomically", () => {
  const completeStop = functionSource(read("src/lib/operator-actions.ts"), "completeStop");
  const inventoryCommit = completeStop.indexOf('"snacky_commit_route_stop_inventory_v1"');
  const cashSave = completeStop.indexOf('.from("cash_collections")', inventoryCommit);
  const proofSave = completeStop.lastIndexOf('.from("machine_refill_history")');
  const workflowCommit = completeStop.indexOf('"snacky_finalize_route_stop_workflow_v1"');

  assert.ok(inventoryCommit >= 0 && cashSave > inventoryCommit);
  assert.ok(proofSave > cashSave && workflowCommit > proofSave);
  assert.doesNotMatch(completeStop, /\.from\("route_stops"\)\s*\.update\(/);

  const inventoryMigration = read("supabase/migrations/20260905091000_route_stop_inventory_commit.sql");
  const inventoryBody = sqlFunctionBody(inventoryMigration, "snacky_commit_route_stop_inventory_v1");
  assert.match(inventoryMigration, /create table if not exists public\.route_stop_inventory_commits/);
  assert.match(inventoryMigration, /alter table public\.route_stop_inventory_commits[\s\S]*add column if not exists payload_hash text/);
  assert.match(inventoryMigration, /add column if not exists result_payload jsonb/);
  assert.match(inventoryMigration, /update public\.route_stop_inventory_commits[\s\S]*set payload_hash = pg_catalog\.md5/);
  assert.match(inventoryMigration, /alter column payload_hash set not null/);
  assert.match(inventoryMigration, /insert into public\.route_stop_inventory_commits as current_receipt/);
  assert.match(inventoryMigration, /on conflict \(route_stop_id\)/);
  assert.match(inventoryMigration, /movement_count = case[\s\S]*current_receipt\.movement_count/);
  assert.match(inventoryMigration, /returning id, committed_at, movement_count/);
  assert.match(inventoryMigration, /'movement_count', v_receipt_movement_count/);
  assert.match(inventoryMigration, /if v_existing_receipt_result_payload is null[\s\S]*missing its immutable result/);
  assert.match(inventoryMigration, /return v_existing_receipt_result_payload/);
  assert.ok(
    inventoryBody.indexOf("return v_existing_receipt_result_payload")
      < inventoryBody.indexOf("Route status does not allow stop inventory changes"),
    "an exact lost-response retry must return its immutable receipt even after the route becomes terminal",
  );
  assert.ok(
    inventoryBody.indexOf("return v_existing_receipt_result_payload")
      < inventoryBody.indexOf("Stop status does not allow inventory changes"),
    "an exact lost-response retry must return its immutable receipt even after the stop becomes terminal",
  );
  assert.match(inventoryMigration, /set result_payload = v_result_payload/);
  assert.match(inventoryMigration, /'commit_receipt_id', v_commit_receipt_id/);
  assert.match(inventoryMigration, /v_existing_receipt_workflow_completed_at is null[\s\S]*Another stop-completion payload already committed inventory/);
  assert.match(inventoryMigration, /drop function if exists public\.snacky_commit_route_stop_inventory_v1\(uuid, uuid, uuid, text, jsonb, jsonb\)/);
  assert.match(inventoryMigration, /snacky_commit_route_stop_inventory_v1\(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb\)[\s\S]*to service_role/);
  assert.doesNotMatch(inventoryMigration, /snacky_commit_route_stop_inventory_v1\(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb\)[\s\S]*to authenticated/);
  assert.match(inventoryBody, /from public\.profiles p[\s\S]*join public\.team_members tm/);
  assert.match(inventoryBody, /v_actor_is_manager[\s\S]*v_actor_is_operator and v_route\.operator_id = v_actor_team_member_id/);
  assert.doesNotMatch(inventoryBody, /auth\.uid\(\)|snacky_current_profile_has_any_role|snacky_operator_can_access_route|snacky_current_team_member_id/);

  assert.match(completeStop, /const workflowPayloadHash = createHash\("sha256"\)/);
  assert.match(completeStop, /cash_collected: Boolean\(cashCollected\)/);
  assert.match(completeStop, /issue: normalizedIssue/);
  assert.match(completeStop, /const workflowSubmissionId = `route-stop-workflow:v1:\$\{workflowPayloadHash\}`/);
  assert.match(completeStop, /p_submission_id: workflowSubmissionId/);
  assert.match(completeStop, /p_client_submission_id: workflowSubmissionId/);
  const inventoryCommitCall = completeStop.indexOf('"snacky_commit_route_stop_inventory_v1"');
  const committedAtRead = completeStop.indexOf("stopInventoryResult.inventory_committed_at");
  const completedAtAssignment = completeStop.indexOf("const completedAt = priorCompletedAt ?? inventoryCommittedAt");
  assert.ok(
    inventoryCommitCall >= 0 && committedAtRead > inventoryCommitCall && completedAtAssignment > committedAtRead,
    "the first business completion timestamp must come from the committed inventory receipt",
  );

  const migration = read("supabase/migrations/20260905093000_route_stop_completion_recovery.sql");
  assert.match(migration, /add column if not exists workflow_payload_hash text/);
  assert.match(migration, /v_workflow_payload_hash := pg_catalog\.md5/);
  assert.match(migration, /workflow_payload_hash is distinct from v_workflow_payload_hash/);
  assert.match(migration, /Completed stop workflow cannot be replaced by a different payload/);
  assert.match(migration, /'already_completed', true/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /from public\.route_stop_inventory_commits receipt[\s\S]*for update/);
  assert.match(migration, /latest_submission_id is distinct from v_submission_id/);
  assert.match(migration, /update public\.refill_orders/);
  assert.match(migration, /update public\.routes/);
  assert.match(migration, /update public\.route_stops/);
  assert.match(migration, /v_stop\.completed_at,[\s\S]*v_inventory_receipt\.committed_at/);
  assert.match(migration, /security invoker[\s\S]*set search_path = ''/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /grant execute on function[\s\S]*to authenticated/);
  assert.match(completeStop, /completionWorkflowClient\.rpc\([\s\S]*"snacky_finalize_route_stop_workflow_v1"/);
  assert.match(migration, /create trigger snacky_guard_route_stop_skip_after_inventory_commit/);
  assert.match(migration, /new\.status::text in \('skipped', 'canceled', 'cancelled'\)[\s\S]*from public\.route_stop_inventory_commits/);
  assert.match(migration, /create trigger snacky_guard_route_stop_completion_receipt/);
  assert.match(migration, /new\.status::text = 'completed'[\s\S]*old\.status::text is distinct from 'completed'/);
  assert.match(migration, /current_setting\('snacky\.route_stop_completion_marker', true\)/);
  const completionMarker = migration.indexOf("'snacky.route_stop_completion_marker',\n    v_inventory_receipt.id::text");
  const stopStatusUpdate = migration.indexOf("update public.route_stops rs");
  assert.ok(completionMarker >= 0 && stopStatusUpdate > completionMarker, "the receipt marker must be set immediately before completion");
  assert.match(migration, /security definer[\s\S]*set search_path = ''/);
  assert.match(migration, /create trigger snacky_guard_00_terminal_route_stop_immutable/);
  assert.match(migration, /old\.status::text in \('completed', 'skipped', 'canceled', 'cancelled'\)/);
  assert.match(migration, /before update or delete on public\.route_stops/);
});

test("skip uses compare-and-set and cannot hide committed stop inventory", () => {
  const skipStop = functionSource(read("src/lib/operator-actions.ts"), "skipStop");

  assert.match(skipStop, /from\("route_stop_inventory_commits"\)/);
  assert.match(skipStop, /already posted inventory and cannot be skipped/);
  assert.match(skipStop, /\.eq\("status", stop\.status\)/);
  assert.match(skipStop, /if \(!after\)[\s\S]*changed while it was being skipped/);
  assert.match(skipStop, /idempotencyKey: `route-stop:\$\{stopId\}:skip`/);
});

test("completion activity logs are idempotent across retries", () => {
  const completeStop = functionSource(read("src/lib/operator-actions.ts"), "completeStop");
  const activityLog = read("src/lib/activity-log.ts");

  assert.match(completeStop, /idempotencyKey: `route-stop:\$\{stopId\}:complete`/);
  assert.match(completeStop, /idempotencyKey: `route-stop:\$\{stopId\}:refill-proof`/);
  assert.match(completeStop, /idempotencyKey: `route-stop:\$\{stopId\}:cash:\$\{cashCollection\.id\}`/);
  assert.match(activityLog, /idempotencyKey\?: string \| null/);
  assert.match(activityLog, /stableActivityLogId/);
  assert.match(activityLog, /\.upsert\(payload, \{ onConflict: "id", ignoreDuplicates: true \}\)/);
});
