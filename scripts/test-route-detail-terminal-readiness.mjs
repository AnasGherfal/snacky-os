import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeDetail = fs.readFileSync(path.join(root, "src/app/routes/[id]/page.tsx"), "utf8");
const compact = routeDetail.replace(/\s+/g, " ");

test("Count & finish is exposed only when terminal completion is database-ready", () => {
  assert.match(compact, /const routeAllowsInventoryCompletion = isRouteInventoryFinalizableStatus\(routeRow\.status\)/);
  assert.match(compact, /supportClient \.from\("route_stop_inventory_commits"\) \.select\("id, route_stop_id", \{ count: "exact" \}\) \.eq\("route_id", id\) \.is\("workflow_completed_at", null\) \.order\("created_at", \{ ascending: true \}\) \.limit\(20\)/);
  assert.match(compact, /const hasPendingStopInventoryCommit = Boolean\(pendingStopInventoryCommitResult\.error\) \|\| Number\(pendingStopInventoryCommitResult\.count \?\? 0\) > 0/);
  assert.match(compact, /const canCountAndFinishRoute = canManageRouteAssignment && Boolean\(routeRow\.operator_id\) && routeAllowsInventoryCompletion && routeStops\.length > 0 && completedStopCount === routeStops\.length && !hasPendingStopInventoryCommit/);
  assert.match(compact, /\{canCountAndFinishRoute \? \( <Link href=\{`\/operator\/routes\/\$\{id\}\/leftovers`\}/);
  assert.match(compact, /pendingStopInventoryCommitResult\.error.*?Stop inventory recovery could not be checked.*?Count & finish is locked/s);
  assert.match(compact, /firstPendingStopInventoryCommit.*?href=\{`\/operator\/routes\/\$\{id\}\/stops\/\$\{firstPendingStopInventoryCommit\.route_stop_id\}`\}.*?Recover this stop/s);
  assert.doesNotMatch(compact, /canManageRouteAssignment && !isTerminalRouteStatus\(routeRow\.status\) \? \( <Link href=\{`\/operator\/routes\/\$\{id\}\/leftovers`\}/);
});

test("leftover timeline completion requires canonical terminal inventory evidence", () => {
  const leftoversTimelineLine = routeDetail.split("\n").find((line) => line.includes('"Leftovers returned"')) ?? "";
  assert.match(compact, /from\("route_inventory_reconciliations"\).*?\.eq\("route_id", id\).*?\.maybeSingle\(\)/);
  assert.match(compact, /rpc\("snacky_route_bag_snapshot", \{ p_route_id: id \}\)/);
  assert.match(compact, /canonicalRouteBagBalances\.length > 0 && canonicalRouteBagBalances\.every\(\(balance\) => Number\(balance\.signed_quantity \?\? 0\) === 0\)/);
  assert.match(compact, /const leftoversReconciled = Boolean\(terminalInventoryReconciliation\) \|\| hasAuthoritativeZeroRouteBag/);
  assert.match(compact, /label: tr\(locale, "Leftovers returned", "تمت إعادة المتبقي"\), done: leftoversReconciled/);
  assert.doesNotMatch(routeDetail, /hasReturnMovements/);
  assert.doesNotMatch(leftoversTimelineLine, /isCompletedRouteStatus/);
});

test("open discrepancy units are summed across every deterministic page", () => {
  assert.match(compact, /const pageSize = 1_000/);
  assert.match(compact, /select\("id, absolute_quantity"\).*?\.order\("id", \{ ascending: true \}\).*?\.range\(offset, offset \+ pageSize - 1\)/);
  assert.match(compact, /totalUnits \+= rows\.reduce/);
  assert.match(compact, /if \(rows\.length < pageSize\).*?openRouteDiscrepancyUnits = totalUnits/);
  assert.match(compact, /openRouteDiscrepancyUnits === null.*?complete unit total could not be loaded/);
  assert.doesNotMatch(compact, /const openRouteDiscrepancyUnits = openRouteDiscrepancies\.reduce/);
});
