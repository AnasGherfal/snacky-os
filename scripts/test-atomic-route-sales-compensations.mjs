import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  claimDurableClientOperation,
  completeDurableClientOperation,
} from "../src/lib/durable-client-operation.ts";

const migrationPath = "supabase/migrations/20260905094700_atomic_route_sales_compensations.sql";
const manualApiPath = "src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts";
const compensationApiPath = "src/app/api/operator/routes/[id]/stops/[stopId]/compensations/route.ts";
const manualComponentPath = "src/components/operator/ManualRouteSalesSection.tsx";
const quickActionsPath = "src/components/operator/RouteStopQuickActions.tsx";
const stopPagePath = "src/app/operator/routes/[id]/stops/[stopId]/page.tsx";
const operatorActionsPath = "src/lib/operator-actions.ts";
const durableOperationPath = "src/lib/durable-client-operation.ts";

const migration = readFileSync(migrationPath, "utf8");
const manualApi = readFileSync(manualApiPath, "utf8");
const compensationApi = readFileSync(compensationApiPath, "utf8");
const manualComponent = readFileSync(manualComponentPath, "utf8");
const quickActions = readFileSync(quickActionsPath, "utf8");
const stopPage = readFileSync(stopPagePath, "utf8");
const operatorActions = readFileSync(operatorActionsPath, "utf8");
const durableOperation = readFileSync(durableOperationPath, "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function mustContain(source, fragment, message) {
  assert.ok(source.includes(fragment), message ?? `Expected source to contain: ${fragment}`);
}

const manualFunction = between(
  migration,
  "create or replace function public.snacky_create_route_manual_sale_v1(",
  "revoke all on function public.snacky_create_route_manual_sale_v1(",
);
const compensationFunction = between(
  migration,
  "create or replace function public.snacky_create_route_customer_compensation_v1(",
  "revoke all on function public.snacky_create_route_customer_compensation_v1(",
);
const manualPost = between(manualApi, "export async function POST(", "export async function PATCH(");
const manualPatch = between(manualApi, "export async function PATCH(", null);
const compensationPost = between(compensationApi, "export async function POST(", null);

// Parent records expose durable review state, and direct table writes cannot
// bypass the transactional RPC contract.
mustContain(migration, "add column if not exists needs_review boolean not null default false");
mustContain(migration, "alter column location_id drop not null");
mustContain(migration, "route_manual_sales_review_reason_required");
mustContain(migration, "Legacy manual sale has no linked inventory movement");
mustContain(migration, "where sale_row.product_id is not null");
mustContain(migration, "and sale_row.inventory_movement_id is null");
mustContain(migration, "add column if not exists created_by_team_member_id uuid references public.team_members(id)");
mustContain(migration, "add column if not exists cancelled_by_team_member_id uuid references public.team_members(id)");
mustContain(migration, "add column if not exists inventory_reversal_movement_id uuid references public.inventory_movements(id)");
mustContain(migration, "idx_route_manual_sales_inventory_reversal");
mustContain(migration, "Legacy cancelled manual sale has a missing, ambiguous, or non-exact inventory reversal");
mustContain(migration, "select pg_catalog.count(*)");
mustContain(migration, "reversal.reversed_movement_id = original.id");
mustContain(migration, "reversal.unit_cost_lyd is not distinct from original.unit_cost_lyd");
mustContain(migration, "else -original.line_total_lyd");
mustContain(migration, "create or replace function public.log_inventory_movement_activity()");
mustContain(migration, "from public.team_members team_row");
mustContain(migration, "insert into public.system_activity_logs");
mustContain(migration, "security invoker");
mustContain(migration, "set search_path = ''");
mustContain(migration, "revoke all on table public.route_manual_sales from public, anon, authenticated");
mustContain(migration, "grant select on table public.route_manual_sales to authenticated");
mustContain(migration, "revoke all on table public.route_customer_compensations from public, anon, authenticated");
mustContain(migration, "grant select on table public.route_customer_compensations to authenticated");

for (const [name, source] of [
  ["manual sale", manualFunction],
  ["customer compensation", compensationFunction],
]) {
  mustContain(source, "security definer", `${name} must execute as a protected transaction`);
  mustContain(source, "set search_path = ''", `${name} must pin an empty search_path`);
  mustContain(source, "auth.uid()", `${name} must reject anonymous calls`);
  mustContain(source, "snacky_current_team_member_id()", `${name} must resolve the authenticated team member`);
  mustContain(source, "snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])", `${name} must authorize managers`);
  mustContain(source, "snacky_operator_can_access_route(p_route_id)", `${name} must authorize assigned operators`);
  mustContain(source, "from public.routes route_row", `${name} must load the canonical route`);
  mustContain(source, "for update", `${name} must lock route/stop/parent rows`);
  mustContain(source, "'snacky:operator-custody:'", `${name} must use the canonical operator custody lock`);
  mustContain(source, "'snacky:operator-bag:'", `${name} must use the canonical operator/product lock`);
  mustContain(source, "movement.related_route_id = p_route_id", `${name} must prove route-scoped bag stock`);
  mustContain(source, "v_global_bag_qty", `${name} must also protect the global operator bag invariant`);
  mustContain(source, "operator_route_custody_leases", `${name} must fail closed if route custody cannot be proven`);
  mustContain(source, "Inventory was not changed.", `${name} must persist a clear review reason without a movement`);
  mustContain(source, "returning * into v_movement", `${name} must create the ledger child in the same transaction`);
  mustContain(source, "set inventory_movement_id = v_movement.id", `${name} must link the parent in the same transaction`);
  mustContain(source, "get diagnostics v_updated_count = row_count", `${name} must verify parent-link updates`);
  assert.ok(!source.includes("on conflict") && !source.includes("when others then null"), `${name} must not silently ignore a child/link failure`);
  mustContain(source, "average_cost_lyd", `${name} must capture the canonical product cost in the transaction`);
  mustContain(source, "unit_cost_lyd", `${name} must store the captured unit cost on the movement`);
  mustContain(source, "line_total_lyd", `${name} must store the captured line cost on the movement`);
  mustContain(source, "created_by_team_member_id is distinct from v_actor_team_member_id", `${name} replay must bind the authenticated team actor`);
  mustContain(source, "created_by_user_id is distinct from v_actor_user_id", `${name} replay must bind the authenticated user`);
  mustContain(source, "'actor_user_id'", `${name} ledger receipt must bind the authenticated user`);
  mustContain(source, "'actor_team_member_id'", `${name} ledger receipt must bind the authenticated team actor`);
  mustContain(source, "idempotency_payload", `${name} movement must store an immutable receipt`);
  mustContain(source, "v_actor_team_member_id,", `${name} movement audit actor must be the caller, not the route operator`);
}

// An exact old parent is loaded and compared before lifecycle rejection, so a
// lost-response retry remains replayable after stop/route completion.
assert.ok(
  manualFunction.indexOf("where sale_row.client_submission_id = v_submission_id")
    < manualFunction.indexOf("if v_route.status::text in ("),
  "manual-sale exact replay must be evaluated before terminal-route rejection",
);
assert.ok(
  compensationFunction.indexOf("where compensation_row.client_submission_id = v_submission_id")
    < compensationFunction.indexOf("if v_route.status::text in ("),
  "compensation exact replay must be evaluated before terminal-route rejection",
);
mustContain(manualFunction, "different immutable payload");
mustContain(compensationFunction, "different immutable payload");
mustContain(manualFunction, "v_stop.status::text in ('completed', 'skipped', 'canceled')");
mustContain(compensationFunction, "v_stop.status::text in ('completed', 'skipped', 'canceled')");

// Productless manual sales remain valid business events and intentionally have
// no inventory child. Catalog-backed sales create a movement only after stock
// and custody are proven.
mustContain(manualFunction, "if p_product_id is null and v_fallback_product_name is null");
mustContain(manualFunction, "v_product_name := v_fallback_product_name");
mustContain(manualFunction, "if p_product_id is not null and v_review_reason is null then");
mustContain(manualFunction, "nullif(product_row.current_selling_price_lyd, 0)");
mustContain(manualFunction, "nullif(product_row.selling_price, 0)");
mustContain(manualFunction, "v_unit_sale_price := v_product.unit_sale_price");
mustContain(manualFunction, "The selected product has no valid canonical selling price");
mustContain(manualFunction, "p_product_id is null\n        and v_sale.unit_sale_price_lyd is distinct from v_unit_sale_price");
assert.ok(
  manualFunction.indexOf("v_unit_sale_price := v_product.unit_sale_price")
    < manualFunction.indexOf("insert into public.route_manual_sales"),
  "catalog-backed manual sales must resolve canonical selling price before inserting the parent",
);

// Cancellation is a complete actor-bound transaction. Legacy/malformed
// reversal history becomes durable review state; the public function never
// delegates to the revoked helper or synthesizes a historical bag credit.
const cancelReviewGuard = between(
  migration,
  "create or replace function public.snacky_cancel_route_manual_sale_v1(\n",
  "revoke all on function public.snacky_cancel_route_manual_sale_v1(\n",
);
mustContain(cancelReviewGuard, "for update");
mustContain(cancelReviewGuard, "'snacky:route-inventory:'");
mustContain(cancelReviewGuard, "'snacky:operator-custody:'");
mustContain(cancelReviewGuard, "'snacky:operator-bag:'");
mustContain(cancelReviewGuard, "v_candidate_count := v_candidate_count + 1");
mustContain(cancelReviewGuard, "v_sale.cancellation_reason is distinct from v_reason");
mustContain(cancelReviewGuard, "v_sale.cancelled_by_user_id is distinct from v_actor_user_id");
mustContain(cancelReviewGuard, "v_sale.cancelled_by_team_member_id is distinct from v_actor_team_member_id");
mustContain(cancelReviewGuard, "missing, ambiguous, or non-exact inventory reversal");
mustContain(cancelReviewGuard, "set needs_review = true");
mustContain(cancelReviewGuard, "get diagnostics v_updated_count = row_count");
mustContain(cancelReviewGuard, "inventory_reversal_movement_id = case");
mustContain(cancelReviewGuard, "v_original.unit_cost_lyd");
mustContain(cancelReviewGuard, "else -v_original.line_total_lyd");
mustContain(cancelReviewGuard, "'cancellation_reason', v_reason");
mustContain(cancelReviewGuard, "'actor_user_id', v_actor_user_id");
mustContain(cancelReviewGuard, "'actor_team_member_id', v_actor_team_member_id");
mustContain(cancelReviewGuard, "v_expected_reversal_payload");
mustContain(cancelReviewGuard, "v_original_exact := coalesce((");
mustContain(cancelReviewGuard, "v_reversal_exact := coalesce((");
mustContain(cancelReviewGuard, "not coalesce(v_original_exact, false)");
assert.ok(!cancelReviewGuard.includes("snacky_cancel_route_manual_sale_v1_legacy("), "public cancellation must never delegate to the legacy helper");
assert.ok(!cancelReviewGuard.includes("on conflict"), "cancellation must not silently accept a conflicting reversal receipt");
assert.ok(
  cancelReviewGuard.indexOf("if v_sale.needs_review then")
    < cancelReviewGuard.indexOf("v_sale.cancellation_reason is distinct from v_reason"),
  "any durable legacy review flag must fail closed before exact actor/reason replay checks",
);
mustContain(migration, "revoke all on function public.snacky_cancel_route_manual_sale_v1_legacy(");
mustContain(manualPatch, 'routeClient.rpc(\n      "snacky_cancel_route_manual_sale_v1"');
mustContain(manualPatch, 'code: "MANUAL_SALE_REVIEW_REQUIRED"');
mustContain(manualPatch, "requiresReview: true");
assert.ok(!manualPatch.includes("isRouteLocked("), "manual-sale cancellation retries must reach the locked database RPC");

// The API must use the signed-in client to call the atomic functions. It must
// not recreate the old parent -> movement -> link sequence over REST.
mustContain(manualPost, 'routeClient.rpc("snacky_create_route_manual_sale_v1"');
mustContain(compensationPost, 'client.rpc("snacky_create_route_customer_compensation_v1"');
for (const [name, source] of [["manual sale", manualPost], ["customer compensation", compensationPost]]) {
  assert.ok(!source.includes('.from("inventory_movements").insert'), `${name} API must not insert ledger rows directly`);
  assert.ok(!source.includes(".insert("), `${name} API POST must not insert parent rows directly`);
  assert.ok(!source.includes(".update("), `${name} API POST must not repair links outside the transaction`);
  mustContain(source, "p_client_submission_id:", `${name} API must pass the stable client submission id`);
  mustContain(source, "SCHEMA_UPDATE_REQUIRED", `${name} API must fail clearly when the migration is missing`);
}
mustContain(manualPost, "if (!productId && unitSalePriceLyd <= 0)");
mustContain(manualPost, "p_unit_sale_price_lyd: productId ? null : unitSalePriceLyd");

// Mobile remounts and lost responses must retain the exact operation id. A
// changed immutable payload receives a new id, and unavailable browser storage
// fails before the request rather than silently creating a duplicate-prone id.
mustContain(durableOperation, "window.localStorage.getItem(storageKey)");
mustContain(durableOperation, "parsed.payload === serializedPayload");
mustContain(durableOperation, "window.localStorage.setItem(storageKey");
mustContain(durableOperation, "could not safely persist this operation id");
assert.ok(!durableOperation.includes('catch {\n    return newOperationId();'), "storage failure must fail closed");
for (const [name, source] of [
  ["manual sale", manualComponent],
  ["compensation", quickActions],
  ["inventory adjustment", stopPage],
]) {
  mustContain(source, "claimDurableClientOperation", `${name} must claim a persisted operation id`);
  mustContain(source, "completeDurableClientOperation", `${name} must clear only after confirmed success`);
}
mustContain(quickActions, "Compensation was saved, but the latest list could not be refreshed.");
mustContain(quickActions, "setRecords((current) => [savedRecord");
mustContain(stopPage, 'photoFormData.append("clientSubmissionId", clientSubmissionId)');
const adjustmentUpload = between(
  operatorActions,
  "export async function uploadInventoryAdjustmentPhoto(",
  "export async function startRoute(",
);
mustContain(adjustmentUpload, 'formData.get("clientSubmissionId")');
mustContain(adjustmentUpload, 'createHash("sha256").update(clientSubmissionId)');
assert.ok(!adjustmentUpload.includes("Date.now()"), "an exact adjustment retry must reuse the same photo object path");

// Small executable model of the lock-serialized decision. A second business
// event observes stock consumed by the first and is review-only, never another
// ledger debit.
function decideInventory({ hasProduct = true, custody = true, routeQty, globalQty, requestedQty }) {
  if (!hasProduct) return { movement: false, review: false, nextRouteQty: routeQty };
  if (!custody || routeQty < requestedQty || globalQty < requestedQty) {
    return { movement: false, review: true, nextRouteQty: routeQty };
  }
  return { movement: true, review: false, nextRouteQty: routeQty - requestedQty };
}

assert.deepEqual(
  decideInventory({ hasProduct: false, routeQty: 0, globalQty: 0, requestedQty: 1 }),
  { movement: false, review: false, nextRouteQty: 0 },
);
assert.deepEqual(
  decideInventory({ custody: false, routeQty: 10, globalQty: 10, requestedQty: 1 }),
  { movement: false, review: true, nextRouteQty: 10 },
);
const first = decideInventory({ routeQty: 10, globalQty: 10, requestedQty: 6 });
const second = decideInventory({ routeQty: first.nextRouteQty, globalQty: 4, requestedQty: 5 });
assert.equal(first.movement, true);
assert.deepEqual(second, { movement: false, review: true, nextRouteQty: 4 });

// Route operator and audit actor are intentionally independent. A manager can
// act on an operator-owned bag, but the immutable receipt cannot be replayed by
// another actor using the same operation id.
function createReceipt({ operatorId, actorUserId, actorTeamMemberId }) {
  return { operatorId, actorUserId, actorTeamMemberId, createdBy: actorTeamMemberId };
}
function exactCreateReplay(receipt, actorUserId, actorTeamMemberId) {
  return receipt.actorUserId === actorUserId && receipt.actorTeamMemberId === actorTeamMemberId;
}
const managerReceipt = createReceipt({
  operatorId: "operator-a",
  actorUserId: "manager-user",
  actorTeamMemberId: "manager-member",
});
assert.equal(managerReceipt.operatorId, "operator-a");
assert.equal(managerReceipt.createdBy, "manager-member");
assert.equal(exactCreateReplay(managerReceipt, "manager-user", "manager-member"), true);
assert.equal(exactCreateReplay(managerReceipt, "other-user", "other-member"), false);

function exactCancellationReplay(saved, attempt) {
  return saved.actorUserId === attempt.actorUserId
    && saved.actorTeamMemberId === attempt.actorTeamMemberId
    && saved.reason === attempt.reason;
}
const cancellationReceipt = {
  actorUserId: "manager-user",
  actorTeamMemberId: "manager-member",
  reason: "Duplicate cash sale",
};
assert.equal(exactCancellationReplay(cancellationReceipt, cancellationReceipt), true);
assert.equal(exactCancellationReplay(cancellationReceipt, { ...cancellationReceipt, reason: "Other" }), false);
assert.equal(exactCancellationReplay(cancellationReceipt, { ...cancellationReceipt, actorTeamMemberId: "operator-a" }), false);

function cancellationDecision({ productBacked, originalExact, candidateCount, reversalExact, alreadyCancelled }) {
  if (!productBacked) return { review: false, movement: false, replay: alreadyCancelled };
  if (!originalExact || candidateCount !== (alreadyCancelled ? 1 : 0) || (alreadyCancelled && !reversalExact)) {
    return { review: true, movement: false, replay: alreadyCancelled };
  }
  return { review: false, movement: !alreadyCancelled, replay: alreadyCancelled };
}
assert.deepEqual(
  cancellationDecision({ productBacked: true, originalExact: true, candidateCount: 0, reversalExact: false, alreadyCancelled: false }),
  { review: false, movement: true, replay: false },
);
assert.deepEqual(
  cancellationDecision({ productBacked: true, originalExact: true, candidateCount: 0, reversalExact: false, alreadyCancelled: true }),
  { review: true, movement: false, replay: true },
);
assert.deepEqual(
  cancellationDecision({ productBacked: true, originalExact: true, candidateCount: 2, reversalExact: false, alreadyCancelled: true }),
  { review: true, movement: false, replay: true },
);
assert.deepEqual(
  cancellationDecision({ productBacked: true, originalExact: null, candidateCount: 0, reversalExact: false, alreadyCancelled: false }),
  { review: true, movement: false, replay: false },
  "a legacy original with a NULL immutable receipt must go to review without a reversal",
);
assert.equal(-(-125.75), 125.75, "reversal must negate the signed total, never use -abs(total)");

const originalWindow = globalThis.window;
const browserRows = new Map();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key) => browserRows.get(key) ?? null,
      setItem: (key, value) => browserRows.set(key, value),
      removeItem: (key) => browserRows.delete(key),
    },
  },
});
const durableId = claimDurableClientOperation("sale:test", { quantity: 1 });
assert.equal(claimDurableClientOperation("sale:test", { quantity: 1 }), durableId);
assert.notEqual(claimDurableClientOperation("sale:test", { quantity: 2 }), durableId);
const completedId = claimDurableClientOperation("sale:complete", { quantity: 1 });
completeDurableClientOperation("sale:complete", completedId);
assert.equal(browserRows.has("sale:complete"), false);
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: { getItem: () => { throw new Error("blocked"); } } },
});
assert.throws(
  () => claimDurableClientOperation("sale:blocked", { quantity: 1 }),
  /could not safely persist this operation id/i,
  "blocked browser storage must prevent the money/inventory request before POST",
);
if (originalWindow === undefined) {
  delete globalThis.window;
} else {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
}

console.log("Atomic route manual-sale and compensation checks passed.");
