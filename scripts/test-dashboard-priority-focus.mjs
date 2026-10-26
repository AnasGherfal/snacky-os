import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  prioritizeDashboardActions,
  splitDashboardActions,
} from "../src/lib/dashboard-action-priority.ts";

function action(key) { return {key,title:key,detail:key,href:"/routes",cta:"Open"}; }

test("urgent cash, critical issues and stock differences rise ahead of routine import work", () => {
  const input=[
    action("missing-detailed-sales"), action("refill-routes"),
    action("cash-waiting"), action("route-inventory-review"),
    action("critical-issues"), action("critical-restock"),
  ];
  const original=input.map(x=>x.key);
  const prioritized=prioritizeDashboardActions(input).map(x=>x.key);
  assert.deepEqual(prioritized,[
    "critical-issues", "cash-waiting", "route-inventory-review",
    "critical-restock", "refill-routes", "missing-detailed-sales",
  ]);
  assert.deepEqual(input.map(x=>x.key),original,"sorting must never mutate dashboard inputs");
});

test("top three and remaining action queue never repeat an item",()=>{
  const items=["missing-detailed-sales","critical-restock","cash-waiting","refill-routes",
    "critical-issues","finance-gaps","pending-routes"].map(action);
  const {priority,remaining}=splitDashboardActions(items);
  assert.equal(priority.length,3);
  assert.equal(remaining.length,4);
  assert.equal(new Set([...priority,...remaining].map(x=>x.key)).size,items.length);
  assert.deepEqual(priority.map(x=>x.key),["critical-issues","cash-waiting","critical-restock"]);
});

test("unknown future actions remain visible and stable; no queue duplicates",()=>{
  const items=[action("future-a"),action("critical-issues"),action("future-b"),action("future-c")];
  const {priority,remaining}=splitDashboardActions(items,1);
  assert.deepEqual(priority.map(x=>x.key),["critical-issues"]);
  assert.deepEqual(remaining.map(x=>x.key),["future-a","future-b","future-c"]);
  assert.deepEqual(splitDashboardActions([],3),{priority:[],remaining:[]});
});

test("first-screen focus uses accessible mobile cards, real links and bilingual labels",()=>{
  const dashboard=readFileSync("src/app/dashboard/page.tsx","utf8");
  const hero=readFileSync("src/components/DashboardPriorityFocus.tsx","utf8");
  assert.ok(dashboard.includes('import { DashboardPriorityFocus }'));
  assert.ok(dashboard.includes('splitDashboardActions(actionItems)'));
  assert.ok(dashboard.includes("actions={priorityActions}"));
  assert.ok(dashboard.includes("remainingCount={remainingActions.length}"));
  assert.ok(dashboard.includes("partialSources={partialSections.length > 0}"));
  assert.ok(hero.includes('href={item.href}'));
  assert.ok(hero.includes('lg:grid-cols-3'));
  assert.ok(hero.includes('text-start'));
  assert.ok(hero.includes('focus-visible:ring-2'));
  assert.ok(hero.includes('aria-labelledby="dashboard-priority-title"'));
  assert.ok(hero.includes("ابدأ بهذه الأولويات"));
  assert.ok(hero.includes('Some sources could not be verified'));
  assert.ok(hero.includes("An empty queue is not an all-clear"));
  assert.ok(hero.includes('href="#dashboard-more-actions"'));
  assert.ok(dashboard.includes('id="dashboard-more-actions"'));
  assert.ok(dashboard.includes('remainingActions.map((item)'));
  assert.ok(!dashboard.includes('actionItems.map((item)'),"source action list must not be repeated");
});

test("owner priority cards do not introduce database writes or new source requests",()=>{
  const hero=readFileSync("src/components/DashboardPriorityFocus.tsx","utf8");
  const order=readFileSync("src/lib/dashboard-action-priority.ts","utf8");
  for(const file of [hero,order]){
    assert.doesNotMatch(file,/\.from\(|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  }
});

test("unverified VMS reads do not create false missing-import tasks",()=>{
 const dashboard=readFileSync("src/app/dashboard/page.tsx","utf8");
 assert.ok(dashboard.includes("if (!errors.vmsBatches && !activeDetailedCount)"));
 assert.ok(dashboard.includes("if (!errors.vmsBatches && !activeStockCount)"));
 assert.ok(dashboard.includes("partialSources={partialSections.length > 0}"));
});
