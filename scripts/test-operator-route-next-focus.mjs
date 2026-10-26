import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {operatorRouteNextFocus} from "../src/lib/operator-route-next-focus.ts";
import {nextOperatorRouteHref} from "../src/lib/route-workflow.ts";

const routeId="route-xyz";
const stop=(id,stop_order,status)=>({id,stop_order,status,machine_id:"m-"+id});
const base={
 routeId,routeStatus:"in_progress",hasPickup:true,routeProductsPrepared:true,
 stops:[stop("s2",2,"picked"),stop("s1",1,"in_progress"),stop("s3",3,"picked")],
};

test("focus delegates exactly to existing pickup-safe route workflow, never reassigning navigation",()=>{
 const cases=[
   base,
   {...base,hasPickup:false},
   {...base,stops:[stop("s1",1,"completed"),stop("s2",2,"pending")]},
   {...base,stops:[stop("s1",1,"completed"),stop("s2",2,"picked")]},
   {...base,stops:[stop("s1",1,"completed"),stop("s2",2,"skipped")]},
   {...base,routeStatus:"completed"},
 ];
 for(const input of cases){
  const focus=operatorRouteNextFocus(input);
  const canonical=nextOperatorRouteHref({
   routeId:input.routeId,status:input.routeStatus,hasPickup:input.hasPickup,
   stops:input.stops,start:true,
  });
  assert.equal(focus?.href??null,canonical);
 }
});

test("partial storage pickup always stays first even if an active stop exists",()=>{
 const result=operatorRouteNextFocus({...base,stops:[
  stop("active",1,"in_progress"),stop("pending",2,"pending"),
 ]});
 assert.equal(result?.kind,"pickup");
 assert.equal(result?.stopId,null);
 assert.equal(result?.href,`/operator/routes/${routeId}/pick-list?start=1`);
});

test("suggest first eligible active machine by existing stop order, without altering order",()=>{
 const input={...base};
 const original=input.stops.map(row=>row.id);
 const result=operatorRouteNextFocus(input);
 assert.equal(result?.kind,"machine");
 assert.equal(result?.stopId,"s1");
 assert.equal(result?.href,`/operator/routes/${routeId}/stops/s1`);
 assert.deepEqual(input.stops.map(row=>row.id),original);
 assert.equal(result?.doneStops,0);
 assert.equal(result?.unfinishedStops,3);
});

test("once all stops are done or skipped, return to physical leftovers instead of silently closing",()=>{
 const result=operatorRouteNextFocus({...base,stops:[
  stop("s1",1,"completed"),stop("s2",2,"skipped"),
 ]});
 assert.equal(result?.kind,"leftovers");
 assert.equal(result?.href,`/operator/routes/${routeId}/leftovers`);
 assert.equal(result?.doneStops,2);
 assert.equal(result?.unfinishedStops,0);
});

test("no prepared stock, no stop, or terminal route never invents an actionable CTA",()=>{
 assert.equal(operatorRouteNextFocus({...base,routeProductsPrepared:false}),null);
 assert.equal(operatorRouteNextFocus({...base,stops:[]}),null);
 assert.equal(operatorRouteNextFocus({...base,routeStatus:"completed"}),null);
});

test("owner of route sees next action above stats and active stop is highlighted, no new DB calls",()=>{
 const page=readFileSync("src/app/operator/routes/[id]/page.tsx","utf8");
 const ui=readFileSync("src/components/operator/OperatorRouteNextActionCard.tsx","utf8");
 const helper=readFileSync("src/lib/operator-route-next-focus.ts","utf8");
 assert.ok(page.includes("operatorRouteNextFocus({"));
 assert.ok(page.includes("nextFocus.href === primaryAction.href"));
 assert.ok(page.includes("<OperatorRouteNextActionCard"));
 assert.ok(page.indexOf("<OperatorRouteNextActionCard") < page.indexOf("{/* Route Status Cards */}"));
 assert.ok(page.includes('id="route-machine-stops"'));
 assert.ok(page.includes("nextFocus?.stopId === stop.id"));
 assert.ok(page.includes("Next suggested machine"));
 assert.ok(ui.includes("aria-valuenow={focus.doneStops}"));
 assert.ok(ui.includes('href="#route-machine-stops"'));
 assert.ok(ui.includes('href={focus.href}'));
 assert.ok(ui.includes("{actionLabel}"));
 assert.ok(page.includes('actionLabel={primaryAction?.label ?? tr("Continue", "متابعة")}'));

 assert.ok(ui.includes("الموقع التالي المقترح"));
 assert.ok(ui.includes("Progress counts completed and skipped stops"));
 assert.doesNotMatch(helper,/\.from\(|\.rpc\(|\bfetch\(|\.insert\(|\.update\(|\.delete\(/);
 assert.doesNotMatch(ui,/\.from\(|\.rpc\(|\bfetch\(|\.insert\(|\.update\(|\.delete\(/);
});
