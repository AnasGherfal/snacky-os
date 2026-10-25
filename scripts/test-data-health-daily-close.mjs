import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page=readFileSync("src/app/operations-health/page.tsx","utf8");

test("existing owner-only data-health screen includes a Tripoli-local daily close",()=>{
 assert.ok(page.includes('hasAnyRole(profile,["owner","admin"])'));
 assert.ok(page.includes('timeZone: "Africa/Tripoli"'));
 assert.ok(page.includes('const todayStart ='));
 assert.ok(page.includes('tomorrowStart'));
 assert.ok(page.includes('Daily owner closeout'));
 assert.ok(page.includes("Today's cash removals"));
 assert.ok(page.includes("Today's cash bags awaiting count"));
 assert.ok(page.includes("Today's routes recorded"));
});

test("daily close counts are independent, read-only and fail closed",()=>{
 assert.ok(page.includes('from("cash_collections").select("id",{count:"exact",head:true})'));
 assert.ok(page.includes('from("routes").select("id",{count:"exact",head:true})'));
 assert.ok(page.includes('.in("custody_status",["removed","in_storage"])'));
 assert.ok(page.includes('todayCashCount === null || todayCashUncounted === null || todayRouteCount === null'));
 assert.ok(page.includes('Unknown counts are not shown as zero'));
 assert.ok(page.includes('This snapshot never posts cash, closes routes or changes stock'));
 assert.doesNotMatch(page,/db\.from\("(cash_collections|routes)"\)\.\s*(insert|update|delete|upsert)\(/);
});

test("daily close links to existing financial and route review workflows",()=>{
 assert.ok(page.includes('href="/cash-collections/action-queue"'));
 assert.ok(page.includes('href="/routes/inventory-review"'));
 assert.ok(page.includes('href="/cash-collections"'));
 assert.ok(page.includes('href="/routes"'));
});
