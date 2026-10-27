import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {buildDueRouteCloseout} from "../src/lib/owner-daily-closeout.ts";
import {loadAllExactOwnerRows} from "../src/lib/owner-closeout-pagination.ts";

const today="2026-10-27";
const route=(id,status="in_progress",route_date="2026-10-26",operator_id="operator-1")=>
 ({id,status,route_date,operator_id});
const stop=(id,route_id,status)=>({id,route_id,status});

test("separates a finished-stop bag handoff from a route with machine stops unfinished",()=>{
 const routes=[route("finished-stops"),route("unfinished")];
 const stops=[
  stop("one","finished-stops","completed"),
  stop("two","unfinished","completed"),
  stop("three","unfinished","in_progress"),
 ];
 const r=buildDueRouteCloseout({routes,stops,todayTripoli:today});
 assert.equal(r.verified,true);
 assert.equal(r.totalDueOpenRoutes,2);
 assert.equal(r.routesNeedingBagCountReview,1);
 assert.equal(r.routesWithUnfinishedStops,1);
 assert.equal(r.routesNeedingWorkflowReview,0);
 assert.equal(r.routeQueue[0].routeId,"finished-stops");
 assert.equal(r.routeQueue[0].action,"return_bag_count");
 assert.equal(r.routeQueue[0].completedOrSkippedStops,1);
 assert.equal(r.routeQueue[1].action,"finish_machine_stops");
 assert.equal(r.routeQueue[1].unfinishedStops,1);
});

test("cancelled/completed routes are excluded, and skipped stop is accounted for but not proof of bag return",()=>{
 const r=buildDueRouteCloseout({
  routes:[route("done","completed"),route("cancel","cancelled"),route("active")],
  stops:[stop("s1","active","skipped")],
  todayTripoli:today,
 });
 assert.equal(r.totalDueOpenRoutes,1);
 assert.equal(r.routeQueue[0].action,"return_bag_count");
 assert.equal(r.routeQueue[0].completedOrSkippedStops,1);
});

test("unassigned, empty-stop and inconsistent workflows require review instead of assuming a return",()=>{
 const r=buildDueRouteCloseout({
  routes:[route("no-stops"),route("unassigned","in_progress","2026-10-26",null),route("assigned","assigned")],
  stops:[stop("s1","unassigned","completed"),stop("s2","assigned","completed")],
  todayTripoli:today,
 });
 assert.equal(r.routesNeedingWorkflowReview,3);
 assert.equal(r.routesNeedingBagCountReview,0);
 assert.equal(r.routeQueue.every(x=>x.action==="review_route"),true);
});

test("unstarted and unknown-status routes are workflow review, never treated as filling or bag return",()=>{
  const r=buildDueRouteCloseout({
    routes:[route("unstarted","assigned"),route("unknown","new_unknown_state")],
    stops:[stop("s1","unstarted","picked"),stop("s2","unknown","in_progress")],
    todayTripoli:today,
  });
  assert.equal(r.routesNeedingWorkflowReview,2);
  assert.equal(r.routesWithUnfinishedStops,0);
  assert.equal(r.routesNeedingBagCountReview,0);
});

test("undated routes remain visible and never appear as verified bag returns",()=>{
 const r=buildDueRouteCloseout({
  routes:[route("no-date","in_progress",null),route("due")],
  stops:[stop("s1","no-date","completed"),stop("s2","due","completed")],
  todayTripoli:today,
 });
 assert.equal(r.totalDueOpenRoutes,2);
 assert.equal(r.undatedOpenRoutes,1);
 assert.equal(r.routesNeedingWorkflowReview,1);
 assert.equal(r.routesNeedingBagCountReview,1);
 assert.equal(r.routeQueue.find(x=>x.routeId==="no-date")?.workflowReviewReason,"undated");
 assert.equal(r.routeQueue.find(x=>x.routeId==="no-date")?.action,"review_route");
 assert.throws(()=>buildDueRouteCloseout({routes:[route("future","in_progress","2026-10-28")],stops:[],todayTripoli:today}),/future-dated/);
});

test("precise workflow review causes are preserved for the owner",()=>{
 const r=buildDueRouteCloseout({
  routes:[route("none"),route("unassigned","in_progress","2026-10-26",null),route("not-active","assigned")],
  stops:[stop("s1","unassigned","completed"),stop("s2","not-active","completed")],
  todayTripoli:today,
 });
 assert.deepEqual(new Map(r.routeQueue.map(x=>[x.routeId,x.workflowReviewReason])),new Map([
  ["none","no_stops"],["unassigned","no_operator"],["not-active","not_active"]
 ]));
 assert.equal(r.routesNeedingWorkflowReview,3);
});

test("priority is stable and does not mutate source, with an eight-item visual cap",()=>{
 const routes=Array.from({length:17},(_,i)=>route("route-"+i,"in_progress","2026-10-25"));
 const stops=routes.map((r,i)=>stop("s-"+i,r.id,"in_progress"));
 const before=routes.map(r=>r.id);
 const result=buildDueRouteCloseout({routes,stops,todayTripoli:today});
 assert.equal(result.totalDueOpenRoutes,17);
 assert.equal(result.routeQueue.length,8);
 assert.deepEqual(result.routeQueue.map(r=>r.routeId),before.slice(0,8));
 assert.deepEqual(routes.map(r=>r.id),before);
});

test("route-stop records from outside verified due route set are rejected",()=>{
 assert.throws(()=>buildDueRouteCloseout({routes:[route("r1")],stops:[stop("wrong","other","completed")],todayTripoli:today}),/outside/);
});

test("exact paged reads fetch all rows across PostgREST page caps",async()=>{
 const rows=Array.from({length:725},(_,i)=>({id:"record-"+i}));
 const pages=[];
 const result=await loadAllExactOwnerRows(async(from,to)=>{
  pages.push([from,to]);
  return {data:rows.slice(from,to+1),count:rows.length,error:null};
 });
 assert.deepEqual(pages,[[0,299],[300,599],[600,899]]);
 assert.equal(result.length,725);
});

test("truncated page, unknown count, changing count, duplicate identifiers or read error all fail closed",async()=>{
 const scenarios=[
  async()=>({data:[{id:"a"}],count:300,error:null}),
  async()=>({data:[],count:null,error:null}),
  async()=>({data:[],count:0,error:{message:"denied"}}),
  async(from)=>from===0
   ? {data:Array.from({length:300},(_,i)=>({id:String(i)})),count:500,error:null}
   : {data:Array.from({length:200},(_,i)=>({id:String(i+300)})),count:501,error:null},
  async(from)=>({data:Array.from({length:Math.min(300,400-from)},(_,i)=>({id:from===300&&i===0?"0":String(i+from)})),count:400,error:null}),
 ];
 for(const scenario of scenarios){
  await assert.rejects(loadAllExactOwnerRows((from,to)=>scenario(from,to)));
 }
});

test("read-only management action center uses precise cash counting, owner guard and source links",()=>{
 const page=readFileSync("src/app/operations-health/page.tsx","utf8");
 const ui=readFileSync("src/components/OwnerDailyCloseoutActionCenter.tsx","utf8");
 const source=readFileSync("src/lib/owner-closeout-source.ts","utf8");
 const paging=readFileSync("src/lib/owner-closeout-pagination.ts","utf8");
 assert.ok(page.includes('hasAnyRole(profile,["owner","admin"])'));
 assert.ok(page.includes("readOwnerDueRouteCloseout(db,tripoliDate)"));
 assert.ok(page.includes('if(workspaceResult.error||!workspaceResult.data'));
 assert.ok(page.includes("openRouteStockDifferences={openRouteDiscrepancyCount}"));
 assert.ok(page.indexOf("const openRouteDiscrepancyCount") < page.indexOf("if(workspaceResult.error"));
 assert.ok(page.includes("Data Health cleanup workspace could not be verified"));

 assert.ok(page.includes("<OwnerDailyCloseoutActionCenter"));
 assert.ok(page.includes('allCashWithoutCountResult'));
 assert.ok(page.includes('cashReconciliationReviewResult'));
 assert.ok(page.includes('.is("counted_at",null)'));
 assert.ok(page.includes('.in("reconciliation_status",["pending","variance_review"])'));
 assert.ok(source.includes('getAuthenticatedSupabaseServerClient'));
 assert.ok(source.includes('.select("id,route_date,status,operator_id", {count:"exact"})'));
 assert.ok(source.includes('.select("id,route_id,status", {count:"exact"})'));
 assert.ok(source.includes('isTerminalRouteStatus(route.status)'));
 assert.ok(source.includes("route_date.is.null"));
 assert.ok(ui.includes("routesNeedingWorkflowReview"));
 assert.ok(ui.includes("workflowReasons"));
 assert.ok(paging.includes("result.count !== expected"));
 assert.ok(ui.includes("/operator/routes/"));
 assert.ok(ui.includes("/cash-collections/action-queue"));
 assert.ok(ui.includes("/routes/inventory-review"));
 assert.ok(ui.includes("physical return NOT verified"));
 assert.ok(ui.includes("An unknown count is not zero"));
 assert.doesNotMatch(source,/getSupabaseAdminClient|service_role|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
 assert.doesNotMatch(ui,/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\brpc\(/);
});
