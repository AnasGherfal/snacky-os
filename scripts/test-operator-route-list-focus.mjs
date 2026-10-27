import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
  prioritizeAssignedOperatorRoutes,routeQueueUrgency,routeQueueItem,
} from "../src/lib/operator-route-list-focus.ts";

const stop=(id,status)=>({id,status});
const route=(id,date,status,route_stops=[stop("a","pending")])=>({
  id,route_date:date,status,route_stops,
});
const today="2026-10-26";

test("active route rises before older scheduled and newer dates without mutating input",()=>{
 const routes=[
  route("future","2026-10-28","assigned"),
  route("today","2026-10-26","assigned"),
  route("overdue","2026-10-24","assigned"),
  route("active","2026-10-25","in_progress",[stop("one","completed"),stop("two","in_progress")]),
  route("bad-date","2026-02-30","assigned"),
 ];
 const before=routes.map(x=>x.id);
 const sorted=prioritizeAssignedOperatorRoutes(routes,today,true);
 assert.deepEqual(sorted.map(x=>x.route.id),["active","overdue","today","future","bad-date"]);
 assert.deepEqual(routes.map(x=>x.id),before);
 assert.equal(sorted[0].unfinishedStops,1);
 assert.equal(sorted[0].doneStops,1);
 assert.equal(sorted[0].progressPercent,50);
 assert.equal(routeQueueUrgency(route("start","2026-10-25","started"),today),"in_progress");
});

test("same-urgency routes order oldest first; stable tie order",()=>{
 const rows=[
  route("b","2026-10-22","assigned"),
  route("a","2026-10-20","assigned"),
  route("c","2026-10-22","assigned"),
 ];
 assert.deepEqual(prioritizeAssignedOperatorRoutes(rows,today,true).map(x=>x.route.id),["a","b","c"]);
});

test("missing or partial stop source never appears as 0/0 or completed",()=>{
 const r=route("route1","2026-10-26","in_progress",[stop("one","completed")]);
 for(const data of [
  routeQueueItem(r,today,false),
  routeQueueItem({...r,route_stops:undefined},today,true),
 ]){
  assert.equal(data.doneStops,null);
  assert.equal(data.totalStops,null);
  assert.equal(data.unfinishedStops,null);
  assert.equal(data.progressPercent,null);
 }
 const noStops=routeQueueItem(route("noStops",today,"assigned",[]),today,true);
 assert.equal(noStops.totalStops,0);
 assert.equal(noStops.progressPercent,null);
});

test("skipped counts as done, never claims the machine was physically filled",()=>{
 const result=routeQueueItem(route("route2",today,"in_progress",[
  stop("a","completed"),stop("b","skipped"),stop("c","picked"),
 ]),today,true);
 assert.equal(result.doneStops,2);
 assert.equal(result.unfinishedStops,1);
 assert.equal(result.progressPercent,67);
});

test("invalid or missing date does not sort as urgent overdue",()=>{
 for(const date of ["2026-02-30","2026-13-02","",null]){
  assert.equal(routeQueueUrgency(route("x",date,"assigned"),today),"date_unverified");
 }
 assert.equal(routeQueueUrgency(route("x","2026-10-25","assigned"),today),"overdue");
 assert.equal(routeQueueUrgency(route("x","2026-10-27","assigned"),today),"upcoming");
});

test("routes page exposes mobile tabs, focused work and source-complete progress",()=>{
 const page=readFileSync("src/app/operator/routes/page.tsx","utf8");
 assert.ok(page.includes('className="flex flex-wrap gap-2" aria-label={tr("Route views"'));
 assert.ok(page.includes("const assignedOpenRoutes = prioritizeAssignedOperatorRoutes("));
 assert.ok(page.includes("const priorityRoute = assignedOpenRoutes[0] ?? null"));
 assert.ok(page.includes('YOUR NEXT ROUTE'));
 assert.ok(page.includes("Open route"));
 assert.ok(page.includes('href={`/operator/routes/${priorityRoute.id}`}'));
 assert.ok(page.includes('stopsVerified={stopsVerified}'));
 assert.ok(page.includes('new Set(stopRows.map(stop => stop.id)).size === stopRows.length'));
 assert.ok(page.includes('stopRows.length === stopCount'));
 assert.ok(page.includes('typeof assignedCount !== "number"'));
 assert.ok(page.includes('Route list incomplete'));
 assert.ok(page.includes('Stop progress unverified'));
 assert.ok(page.includes("No machine stops configured"));
 assert.ok(page.includes("aria-valuenow={doneStops ?? 0}"));
 assert.ok(page.includes("This does not assign routes or change stop order"));
 assert.doesNotMatch(page,/\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
});

test("operator home and assigned route list share the same priority source",()=>{
 const home=readFileSync("src/app/operator/page.tsx","utf8");
 const list=readFileSync("src/app/operator/routes/page.tsx","utf8");
 assert.ok(home.includes("prioritizeAssignedOperatorRoutes("));
 assert.ok(list.includes("prioritizeAssignedOperatorRoutes("));
 assert.ok(home.includes("const featuredRoute = activeAssignedRoutes[0] ?? null"));
 assert.ok(home.includes("const featuredSummary = featuredRoute ? routeQueueItem("));
 assert.ok(home.includes('id="operator-home-next-route-title"'));
 assert.ok(home.includes('href={`/operator/routes/${featuredRoute.id}`}'));
 assert.ok(home.includes("YOUR NEXT ROUTE"));
 assert.ok(home.includes("Existing assignments and pickup safeguards remain unchanged."));
 assert.ok(home.includes("item.progressPercent !== null"));
 assert.ok(home.includes("Stop progress unavailable"));
 assert.ok(home.includes("متبقي"));
 assert.ok(!home.includes("completedStops/totalStops"));
 assert.doesNotMatch(home,/\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
});
