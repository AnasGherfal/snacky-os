import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const pickedItemsApi = read("src/app/api/operator/routes/[id]/picked-items/route.ts");
const leftoversPage = read("src/app/operator/routes/[id]/leftovers/page.tsx");
const operatorRoutePage = read("src/app/operator/routes/[id]/page.tsx");

test("the authorized route endpoint loads count options through its route-scoped RPC", () => {
  assert.match(pickedItemsApi, /canAccessOperatorRoute\(routeAccessProfile, route\.operator_id\)/);
  assert.match(pickedItemsApi, /supabase\.rpc\("snacky_route_inventory_count_options", \{ p_route_id: routeId \}\)/);
  assert.doesNotMatch(pickedItemsApi, /async function loadAllActiveProducts/);
  assert.doesNotMatch(pickedItemsApi, /\.from\("storage_locations"\)/);
  assert.doesNotMatch(pickedItemsApi, /\.from\("products"\)[\s\S]{0,300}\.eq\("active", true\)/);
  assert.match(pickedItemsApi, /activeProductOptions,/);
  assert.match(pickedItemsApi, /const assignedBagOwnerId = route\.operator_id \? String\(route\.operator_id\) : null/);
  assert.match(pickedItemsApi, /inventoryFinalizationAvailable: inventoryFinalizationBlockCode === null/);
  assert.doesNotMatch(pickedItemsApi, /service[_-]?role/i, "the operator endpoint must keep using its authorized signed-in client");
});

test("bag history preserves an explicit zero-count row after custody balances return to zero", () => {
  assert.match(pickedItemsApi, /supabase\.rpc\("snacky_route_bag_snapshot", \{ p_route_id: routeId \}\)/);
  assert.match(pickedItemsApi, /const authoritativeCustodyRows =[\s\S]*?: snapshotBalances;[\s\S]*?const allCustodyItems:/);
  assert.match(pickedItemsApi, /const bagHistoryItems = allCustodyItems/);
  assert.doesNotMatch(pickedItemsApi, /const bagHistoryByKey = new Map/);
  assert.match(pickedItemsApi, /bagHistoryItems: historyItems/);

  assert.match(leftoversPage, /mergeCustodyItems\(items, bagHistoryItems\)/);
  assert.match(leftoversPage, /const countRows = displayItems\.map/);
  assert.match(leftoversPage, /countedQuantity: Math\.max\(0, Number\(countedQtys\[custodyKey\(item\)\] \?\? 0\)\)/);
  assert.match(leftoversPage, /counts: countRows/);
  const confirmationGuard = leftoversPage.indexOf("const unconfirmedRows = displayItems.filter");
  const countPayload = leftoversPage.indexOf("const countRows = displayItems.map");
  assert.ok(confirmationGuard >= 0 && countPayload > confirmationGuard, "physical confirmation must be required before building the payload");
});

test("an unexpected physical product becomes a zero-ledger count for the assigned operator", () => {
  assert.match(leftoversPage, /const \[unexpectedProductIds, setUnexpectedProductIds\]/);
  assert.match(leftoversPage, /bagOwnerId: assignedBagOwnerId,[\s\S]*?signedQuantity: 0/);
  assert.match(leftoversPage, /onChange=\{\(event\) => addUnexpectedProduct\(event\.target\.value\)\}/);
  assert.match(leftoversPage, /Not in the route ledger/);
  assert.match(leftoversPage, /hasVariance = displayItems\.some/);
  assert.match(leftoversPage, /if \(hasVariance && !reconciliationReason\.trim\(\)\)/);
  assert.match(leftoversPage, /if \(physicalReturnTotal > 0 && returnStorageOptions\.length === 0\)/);
  assert.match(leftoversPage, /if \(physicalReturnTotal > 0 && returnStorageOptions\.length > 1 && !storageLocationId\)/);
  assert.match(leftoversPage, /Confirm the physical count for every listed product, including products counted as zero/);
  assert.match(leftoversPage, /I physically counted this product/);
});

test("unexpected selections survive draft restore and never inflate totals after removal", () => {
  assert.match(leftoversPage, /unexpectedProductIds: string\[\]/);
  assert.match(leftoversPage, /confirmedCountKeys: string\[\]/);
  assert.match(leftoversPage, /setUnexpectedProductIds\(draft\.unexpectedProductIds \?\? \[\]\)/);
  assert.match(leftoversPage, /setConfirmedCountKeys\(draft\.confirmedCountKeys \?\? \[\]\)/);
  assert.match(leftoversPage, /delete next\[custodyKey\(item\)\]/);
  assert.match(leftoversPage, /const totalPhysicalCount = displayItems\.reduce/);
  assert.match(leftoversPage, /const useLedgerCounts = \(\) => \{[\s\S]*?setCountedQtys\(suggestedPhysicalCounts\(displayItems\)\);[\s\S]*?setConfirmedCountKeys\(\[\]\)/);
  assert.match(leftoversPage, /setPhysicalCount\(item, quantity\)/);
});

test("terminal-count snapshots never use cache and stale submissions force a clean recount", () => {
  assert.match(pickedItemsApi, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(leftoversPage, /fetch\(`\/api\/operator\/routes\/\$\{routeId\}\/picked-items`, \{[\s\S]*?cache: "no-store"/);
  assert.match(leftoversPage, /useDraftKey\("route-end", \[routeId \|\| "missing-route", finalizationMode\]\)/);
  assert.match(leftoversPage, /staleSnapshot = errorCode === "40001" && staleSnapshotMessage/);
  assert.doesNotMatch(leftoversPage, /staleSnapshot = errorCode === "40001"\s*\n\s*\|\|/,
    "unrelated serialization conflicts must preserve the operator's physical count draft");

  const staleBranch = leftoversPage.indexOf("if (staleSnapshot)");
  const clearDraft = leftoversPage.indexOf("localDraft.clearDraft()", staleBranch);
  const resetSubmission = leftoversPage.indexOf("leftoversSubmissionRef.current = { mode: finalizationMode", staleBranch);
  const reloadSnapshot = leftoversPage.indexOf("await loadRouteInventorySnapshot()", staleBranch);
  assert.ok(staleBranch >= 0 && clearDraft > staleBranch && resetSubmission > clearDraft && reloadSnapshot > resetSubmission,
    "a concurrency failure must discard the stale draft/idempotency key and immediately reload the authoritative snapshot");
});

test("terminal forms fail closed on route state and make multi-owner custody explicit", () => {
  assert.match(pickedItemsApi, /routeReadyForCompletion/);
  assert.match(pickedItemsApi, /canCancel/);
  assert.match(pickedItemsApi, /inventoryFinalizationBlockCode/);
  assert.match(pickedItemsApi, /hasUnassignedCustody/);
  assert.match(pickedItemsApi, /requiresManagerReconciliation/);
  assert.match(leftoversPage, /if \(routeIsTerminal\)/);
  assert.match(leftoversPage, /if \(isCancelMode && !canCancel\)/);
  assert.match(leftoversPage, /if \(!isCancelMode && !routeReadyForCompletion\)/);
  assert.match(leftoversPage, /MANAGER_RECONCILIATION_REQUIRED/);
  assert.match(leftoversPage, /UNASSIGNED_CUSTODY/);
  assert.match(leftoversPage, /countGroups\.map/);
  assert.match(leftoversPage, /aria-labelledby=\{ownerHeadingId\}/);
  assert.match(leftoversPage, /aria-label=\{`\$\{ownerLabel\} · \$\{item\.productName\}/);
  assert.match(leftoversPage, /<fieldset disabled=\{submitting\}/);
});

test("pending stop inventory commits block terminal counting and link to exact recovery", () => {
  assert.match(pickedItemsApi, /from\("route_stop_inventory_commits"\)/);
  assert.match(pickedItemsApi, /\.is\("workflow_completed_at", null\)/);
  assert.match(pickedItemsApi, /const pendingStopId = pendingStopIds\[0\] \?\? null/);
  assert.match(pickedItemsApi, /pendingStopIds\.length === 0/);
  assert.match(pickedItemsApi, /\? "STOP_INVENTORY_COMMIT_PENDING"/);
  assert.match(leftoversPage, /if \(pendingStopId\)/);
  assert.match(leftoversPage, /stopSummaries\.find\(\(stop\) => stop\.id === pendingStopId\)/);
  assert.match(leftoversPage, /href=\{`\/operator\/routes\/\$\{routeId\}\/stops\/\$\{pendingStopId\}`\}/);
  assert.match(leftoversPage, /Recover pending stop/);
});

test("terminal readiness uses the exact route statuses accepted by the database finalizer", () => {
  assert.match(pickedItemsApi, /isRouteInventoryFinalizableStatus\(routeStatus\)/);
  assert.doesNotMatch(pickedItemsApi, /isActiveRouteStatus\(routeStatus\)/);
});

test("terminal count identifies its route and machines without an unbounded list", () => {
  assert.match(pickedItemsApi, /routeDate: route\.route_date/);
  assert.match(pickedItemsApi, /routeReference: String\(route\.id\)\.slice\(0, 8\)\.toUpperCase\(\)/);
  assert.match(pickedItemsApi, /stopSummaries,/);
  assert.match(leftoversPage, /const visibleStopSummaries = stopSummaries\.slice\(0, 8\)/);
  assert.match(leftoversPage, /Assigned operator/);
  assert.match(leftoversPage, /machine stops in this route/);
});

test("operator route remaining stock comes from the canonical route bag snapshot", () => {
  assert.match(operatorRoutePage, /supabase\.rpc\("snacky_route_bag_snapshot", \{ p_route_id: routeId \}\)/);
  assert.match(operatorRoutePage, /routeBagRemainingByProduct/);
  assert.match(operatorRoutePage, /verifiedRemaining === null/);
  assert.match(operatorRoutePage, /remaining in operator bag/);
  assert.doesNotMatch(operatorRoutePage, /Math\.max\(0, Number\(item\.picked_qty[\s\S]{0,180}Number\(item\.returned_qty/);
});
