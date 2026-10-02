import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const correctionMigrationPath = "supabase/migrations/20260906154000_inventory_correction_atomicity.sql";
const actionPath = "src/lib/inventory-actions.ts";
const movementPagePath = "src/app/inventory/movements/page.tsx";

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

const correctionMigration = read(correctionMigrationPath);
const correctionFunction = compact(between(
  correctionMigration,
  "create or replace function public.snacky_create_inventory_movement_correction_v1(",
  "revoke all on function public.snacky_create_inventory_movement_correction_v1(",
));
const correctionAction = compact(
  read(actionPath).split("export async function createInventoryMovementCorrection")[1] ?? "",
);
const movementPage = read(movementPagePath);

test("generic inventory corrections are authenticated owner/admin database commands", () => {
  assert.match(correctionFunction, /security definer set search_path = ''/i);
  assert.match(correctionFunction, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(correctionFunction, /if v_actor_user_id is null then raise exception 'You must be signed in/i);
  assert.match(correctionFunction, /snacky_current_profile_has_any_role\(array\['owner', 'admin'\]\)/i);
  assert.match(correctionFunction, /v_actor_team_member_id := public\.snacky_current_team_member_id\(\)/i);
  assert.match(correctionFunction, /A correction reason is required/i);
  assert.match(
    compact(correctionMigration),
    /revoke all on function public\.snacky_create_inventory_movement_correction_v1\(uuid, text\) from public, anon, authenticated, service_role; grant execute on function public\.snacky_create_inventory_movement_correction_v1\(uuid, text\) to authenticated/i,
  );
});

test("correction lock order matches route and ledger writers", () => {
  const routeAdvisory = correctionFunction.indexOf("'snacky:route-inventory:' || v_preflight.related_route_id::text");
  const routeLock = correctionFunction.indexOf("from public.routes route_row where route_row.id = v_preflight.related_route_id for update");
  const storageLock = correctionFunction.indexOf("pg_catalog.hashtext(v_preflight.product_id::text), pg_catalog.hashtext(v_preflight.to_entity_id::text)");
  const custodyLock = correctionFunction.indexOf("'snacky:operator-custody:' || v_bag_owner_id::text");
  const machineLock = correctionFunction.indexOf("'snacky:machine-stock:' || v_preflight.to_entity_id::text || ':' || v_preflight.product_id::text");
  const productLock = correctionFunction.indexOf("from public.products product_row where product_row.id = v_preflight.product_id for update");
  const exactLock = correctionFunction.indexOf("'snacky:inventory-correction:' || p_original_movement_id::text");
  const originalLock = correctionFunction.indexOf("where movement.id = p_original_movement_id for update");

  assert.ok(routeAdvisory >= 0 && routeLock > routeAdvisory,
    "the shared route-inventory mutex must precede route, review and ledger row locks");
  assert.doesNotMatch(correctionFunction, /from public\.purchase_orders/i,
    "purchase receipts are domain-managed and must never reach the generic correction lock path");
  assert.ok(storageLock > routeLock, "storage must be locked after the optional route parent");
  assert.ok(custodyLock > storageLock, "custody/bag locks must follow storage");
  assert.ok(machineLock > custodyLock, "the shared machine/product mutex must follow custody locks");
  assert.ok(productLock > machineLock, "product rows must be locked after the machine mutex");
  assert.ok(exactLock > productLock, "the correction namespace lock must precede ledger row locks");
  assert.ok(originalLock > exactLock, "the original ledger row must be locked last in the shared hierarchy");

  assert.match(correctionFunction, /v_original\.product_id is distinct from v_preflight\.product_id/i);
  assert.match(correctionFunction, /v_original\.from_entity_type is distinct from v_preflight\.from_entity_type/i);
  assert.match(correctionFunction, /v_original\.to_entity_id is distinct from v_preflight\.to_entity_id/i);
  assert.match(correctionFunction, /v_original\.line_total_lyd is distinct from v_preflight\.line_total_lyd/i);
  assert.match(correctionFunction, /errcode = '40001'/i);
});

test("domain-managed movements fail closed or become route review without a generic reversal", () => {
  const guardAssignment = correctionFunction.indexOf("v_domain_managed_reason := case");
  const replayBranch = correctionFunction.indexOf("if v_winner_found then");
  const unmanagedWinnerGate = correctionFunction.indexOf("if not v_is_domain_managed then", replayBranch);
  const cleanWinnerReturn = correctionFunction.indexOf("return query select v_winner.id, true, false", unmanagedWinnerGate);
  const unmanagedFailure = correctionFunction.indexOf("if v_is_domain_managed and v_original.related_route_id is null then");
  const reviewBranch = correctionFunction.indexOf("if v_route_is_terminal or v_is_domain_managed then");
  const movementInsert = correctionFunction.indexOf("insert into public.inventory_movements", reviewBranch);

  assert.ok(guardAssignment >= 0 && replayBranch > guardAssignment,
    "the managed classification must be immutable before exact replay validation");
  assert.ok(unmanagedWinnerGate > replayBranch && cleanWinnerReturn > unmanagedWinnerGate,
    "a winner may return cleanly only through the explicit unmanaged gate");
  assert.ok(unmanagedFailure > cleanWinnerReturn && reviewBranch > unmanagedFailure,
    "managed winners and new requests must fail closed or enter review");
  assert.ok(movementInsert > reviewBranch,
    "the review branch must return before the generic reversal insert");

  assert.match(correctionFunction, /v_original\.related_purchase_id is not null or v_original\.related_purchase_line_id is not null then 'purchase_receipt'/i);
  assert.match(correctionFunction, /v_original\.related_pickup_batch_id is not null then 'route_pickup'/i);
  assert.match(correctionFunction, /v_original\.related_route_id is not null or v_original\.related_route_stop_id is not null then 'route_inventory'/i);
  assert.match(correctionFunction, /v_original\.reason::text = 'operator_personal_purchase'[\s\S]*v_original\.source_type = 'operator_personal_purchase'/i);
  assert.match(correctionFunction, /v_original\.reason::text = 'manual_sale'[\s\S]*'route_manual_sale_cancel'/i);
  assert.match(correctionFunction, /v_original\.reason::text = 'customer_compensation'[\s\S]*'route_customer_compensation_cancel'/i);
  assert.match(correctionFunction, /v_original\.source_type in \( 'inventory_adjustment', 'inventory_adjustment_cancel' \) then 'inventory_adjustment'/i);
  assert.match(correctionFunction, /v_original\.reason::text = 'historical_route_deduction'[\s\S]*v_original\.historical_route_deduction_line_id is not null/i);
  assert.match(correctionFunction, /v_original\.reversed_movement_id is not null then 'reversal_of_reversal'/i);
  assert.match(correctionFunction, /'domain_managed_reason', v_domain_managed_reason/i);
  assert.match(correctionFunction, /'legacy_generic_reversal_id', case when v_winner_found then v_winner\.id else null end/i);
  assert.match(correctionFunction, /v_review\.details ->> 'legacy_generic_reversal_id' is distinct from/i);
  assert.match(correctionFunction, /This % movement is managed by its source workflow and cannot be reversed with a generic inventory correction/i);
  assert.match(movementPage, /Voiding a personal purchase is not available yet; contact an admin for a documented correction\./i);
  assert.match(movementPage, /linkLabel: "Review in Operator Money"/i);
  assert.doesNotMatch(movementPage, /Open Operator Money to cancel/i,
    "the movement page must not advertise a personal-purchase cancellation workflow that does not exist");
});

test("exact correction replay validates the immutable signed reversal and returns the winner", () => {
  const exactLookup = correctionFunction.indexOf("where movement.idempotency_key = v_correction_key for update");
  const reversalLookup = correctionFunction.indexOf("where movement.reversed_movement_id = p_original_movement_id");
  const replayBranch = correctionFunction.indexOf("if v_winner_found then");
  const terminalBranch = correctionFunction.indexOf("if v_route_is_terminal or v_is_domain_managed then", replayBranch);
  const physicalCheck = correctionFunction.indexOf("if v_storage_on_hand < v_original.quantity::bigint then");

  assert.ok(exactLookup >= 0 && reversalLookup > exactLookup && replayBranch > reversalLookup);
  assert.ok(terminalBranch > replayBranch, "an exact replay must be accepted before terminal-state rejection");
  assert.ok(physicalCheck > replayBranch, "an exact replay must not fail because physical stock changed later");
  assert.match(correctionFunction, /v_winner\.idempotency_payload is distinct from v_expected_payload/i);
  assert.match(correctionFunction, /v_winner\.reversed_movement_id is distinct from v_original\.id/i);
  assert.match(correctionFunction, /v_winner\.line_total_lyd is distinct from \( case when v_original\.line_total_lyd is null then null else -v_original\.line_total_lyd end \)/i);
  assert.match(correctionFunction, /if not v_is_domain_managed then[\s\S]*return query select v_winner\.id, true, false/i);
  assert.match(correctionFunction, /return query select v_winner\.id, true, false/i);

  const insert = between(
    correctionMigration,
    "insert into public.inventory_movements (",
    "returning * into v_winner;",
  );
  assert.match(insert, /else -v_original\.line_total_lyd/i);
  assert.doesNotMatch(insert, /abs\s*\(\s*v_original\.line_total_lyd/i,
    "a reversal of a negative correction must restore a positive signed total");
});

test("machine-debit corrections use the global mutex and cannot create negative verified stock", () => {
  const machineMutex = correctionFunction.indexOf("'snacky:machine-stock:' || v_preflight.to_entity_id::text || ':' || v_preflight.product_id::text");
  const originalLock = correctionFunction.indexOf("where movement.id = p_original_movement_id for update");
  const machineBalance = correctionFunction.indexOf("if v_original.to_entity_type::text in ('machine', 'machine_storage') then", originalLock);
  const balanceRead = correctionFunction.indexOf("from public.inventory_movements movement", machineBalance);
  const balanceGuard = correctionFunction.indexOf("if v_machine_on_hand < v_original.quantity::bigint then", balanceRead);
  const movementInsert = correctionFunction.indexOf("insert into public.inventory_movements", balanceGuard);

  assert.ok(machineMutex >= 0 && originalLock > machineMutex,
    "the shared machine/product mutex must be held before the original is locked and revalidated");
  assert.ok(machineBalance > originalLock && balanceRead > machineBalance && balanceGuard > balanceRead,
    "verified machine stock must be calculated from immutable ledger legs under the mutex");
  assert.ok(movementInsert > balanceGuard,
    "a machine debit that would go negative must fail before the reversal insert");
  assert.match(correctionFunction, /movement\.to_entity_type = v_original\.to_entity_type[\s\S]*movement\.from_entity_type = v_original\.to_entity_type/i);
  assert.match(correctionFunction, /Correction cannot remove % unit\(s\) from verified % stock because only % are recorded on hand\. Open an inventory review instead/i);
  assert.match(correctionFunction, /The existing generic reversal left verified % stock below zero \(%\)\. Open an inventory review instead/i);

  const mayReverseMachineCredit = ({ onHand, originalQuantity }) => onHand >= originalQuantity;
  assert.equal(mayReverseMachineCredit({ onHand: 10, originalQuantity: 10 }), true);
  assert.equal(mayReverseMachineCredit({ onHand: 9, originalQuantity: 10 }), false);
  assert.equal(mayReverseMachineCredit({ onHand: -1, originalQuantity: 1 }), false);
});

test("terminal-route corrections persist review state without changing closed custody", () => {
  const terminalBranch = correctionFunction.indexOf("if v_route_is_terminal or v_is_domain_managed then");
  const movementInsert = correctionFunction.indexOf("insert into public.inventory_movements", terminalBranch);
  const terminalSegment = correctionFunction.slice(terminalBranch, movementInsert);

  assert.ok(terminalBranch >= 0 && movementInsert > terminalBranch,
    "the terminal review branch must return before the reversal insert");
  assert.match(terminalSegment, /insert into public\.route_inventory_discrepancies/i);
  assert.match(terminalSegment, /'physical_count_asserted', false/i);
  assert.match(terminalSegment, /update public\.route_inventory_reconciliations reconciliation set status = 'needs_review'/i);
  assert.match(terminalSegment, /update public\.route_stop_inventory_commits stop_commit set inventory_needs_review = true/i);
  assert.match(terminalSegment, /return query select null::uuid, v_review_found, true, v_review\.id/i);
  assert.doesNotMatch(terminalSegment, /insert into public\.inventory_movements/i);
  assert.doesNotMatch(terminalSegment, /update public\.routes/i);
});

test("unparented storage-debit reversals preserve active-route reservations", () => {
  const physicalCheck = correctionFunction.indexOf("if v_storage_on_hand < v_original.quantity::bigint then");
  const reservationRead = correctionFunction.indexOf("from public.route_stock_lines stock_line", physicalCheck);
  const reservationCheck = correctionFunction.indexOf("if v_storage_on_hand - v_storage_reserved < v_original.quantity::bigint then", reservationRead);
  const movementInsert = correctionFunction.indexOf("insert into public.inventory_movements", reservationCheck);

  assert.ok(physicalCheck >= 0 && reservationRead > physicalCheck,
    "reservation availability is checked only after physical on-hand under the storage lock");
  assert.ok(reservationCheck > reservationRead && movementInsert > reservationCheck,
    "a reserved storage debit must fail before the reversal movement insert");
  assert.match(correctionFunction, /greatest\( coalesce\(stock_line\.planned_qty, 0\) - coalesce\(stock_line\.picked_qty, 0\), 0 \)::bigint/i);
  assert.match(correctionFunction, /'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready', 'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'/i);
  assert.match(correctionFunction, /active routes reserve stock; only % are genuinely available/i);
});

test("active-route reversal and affected review projections commit together", () => {
  const movementInsert = correctionFunction.indexOf("insert into public.inventory_movements");
  const routeSync = correctionFunction.indexOf("perform public._snacky_sync_route_stock_lines(v_original.related_route_id)", movementInsert);
  const reconciliationUpdate = correctionFunction.indexOf("update public.route_inventory_reconciliations reconciliation", routeSync);
  const discrepancyUpdate = correctionFunction.indexOf("update public.route_inventory_discrepancies discrepancy", reconciliationUpdate);
  const lineUpdate = correctionFunction.indexOf("update public.route_inventory_reconciliation_lines reconciliation_line", discrepancyUpdate);

  assert.ok(movementInsert >= 0 && routeSync > movementInsert,
    "the route projection must be synchronized only after its reversal exists");
  assert.ok(reconciliationUpdate > routeSync && discrepancyUpdate > reconciliationUpdate && lineUpdate > discrepancyUpdate,
    "review parent, discrepancy and line projections must be updated in the same RPC");
  assert.match(correctionFunction, /correcting_movement_id = null/i);
  assert.match(correctionFunction, /adjustment_movement_id = case when reconciliation_line\.adjustment_movement_id = v_original\.id then null/i);
});

test("the server action has no raw correction fallback writer", () => {
  assert.match(correctionAction, /rpc\("snacky_create_inventory_movement_correction_v1"/i);
  assert.match(correctionAction, /p_original_movement_id: id/i);
  assert.match(correctionAction, /p_reason: reason/i);
  assert.match(correctionAction, /atomic inventory correction database update is not active yet\. No inventory was changed/i);
  assert.doesNotMatch(
    correctionAction,
    /\.from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)\(/i,
    "correction writes must remain inside the database transaction",
  );
  assert.doesNotMatch(correctionAction, /-Math\.abs/i);
  assert.match(correctionAction, /if \(result\?\.review_required\)/i);
  assert.match(correctionAction, /inventory_changed: false/i);
  assert.match(correctionAction, /\/routes\/inventory-review\?route=/i);
});
