import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const page=readFileSync("src/app/operations-health/page.tsx","utf8");

test("Data Health loads daily and owner workspace signals concurrently",()=>{
 assert.match(page,/const \[\s*todayCashResult,todayCashUncountedResult,todayRoutesResult,[\s\S]*?cashSourceGapsResult,[\s\S]*?\] = await Promise\.all\(\[/);
 assert.equal((page.match(/await Promise\.all\(\[/g) ?? []).length,1);
 assert.ok(page.includes('db.rpc("snacky_data_health_workspace_v1")'));
 assert.ok(page.includes('.gte("collected_at",todayStart)'));
 assert.ok(page.includes('ROUTE_INVENTORY_OPEN_STATUSES'));
});

test("cash and machine setup unverified reads do not become fake zero or all clear",()=>{
 assert.ok(page.includes('const machineSetupVerified = !machinesResult.error && !locationsResult.error'));
 assert.ok(page.includes('currentCashCount = !currentCashResult.error && typeof currentCashResult.count === "number"'));
 assert.ok(page.includes('currentCashCount !== null ? [['));
 assert.ok(page.includes('machineSetupVerified ? [['));
 assert.ok(page.includes('const dataHealthCountsIncomplete ='));
 assert.ok(page.includes("const negativeInventoryCount = verifiedCount(counts.negative_inventory)"));
 assert.ok(page.includes("const safeRefillCancellationCount = verifiedCount(counts.safe_refill_cancellations)"));
 assert.ok(page.includes("const recentVmsAttentionCount = verifiedCount(counts.vms_recent_attention)"));
 assert.ok(page.includes("negativeInventoryCount === null"));
 assert.ok(page.includes("todayCashCount === null || todayCashUncounted === null || todayRouteCount === null"));

 assert.ok(page.includes("(currentCashCount !== null && currentCashCount > 0)"));
 assert.ok(page.includes('dataHealthCountsIncomplete ? "alert" : "status"'));
 assert.ok(page.includes('No missing-site totals have been assumed to be zero'));
 assert.ok(page.includes('An empty list as an all-clear') || page.includes('an all-clear'));
});

test("owner closeout and action cards have professional RTL/mobile accessible styling",()=>{
 assert.ok(page.includes('getServerI18n()'));
 assert.ok(page.includes('title={tr("Data Health", "صحة البيانات")}'));
 assert.ok(page.includes('tr("Daily owner closeout", "ملخص الإغلاق اليومي")'));
 assert.ok(page.includes('labelsAr: Record<string, string>'));
 assert.ok(page.includes('uiLabel(label)'));
 assert.ok(page.includes('Cash action queue", "مهام النقد'));
 assert.ok(page.includes('border-s-4'));
 assert.ok(page.includes('focus-visible:ring-2'));
 assert.ok(page.includes('sm:grid-cols-3'));
 assert.ok(page.includes('count === null ? tr("Unverified", "غير مؤكد")'));
});
