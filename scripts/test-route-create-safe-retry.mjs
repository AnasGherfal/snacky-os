import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  isClientRouteCreateId, routeCreateFingerprint, routeReplayState,
} from "../src/lib/route-create-request.ts";

const id = "1e49d24d-44e9-4ba2-a1d9-32c16a7b5ccb";
const actor = "5a611c8f-bc48-4837-ae2b-807fce79bd24";
const member = "649da128-ac05-42d8-8caa-a6e256751f1f";
const request = {
  clientRouteId:id,
  routeDate:"2026-10-28",
  creationMode:"full",
  assignmentMode:"assigned",
  operatorId:"operator-1",
  machineIds:["m1","m2"],
  manualStopItems:[{machineId:"m1",productId:"p1",quantity:4}],
};
const fp=routeCreateFingerprint(request);
const saved={id,created_by:member,route_date:"2026-10-28",operator_id:"operator-1"};
const receipt={actor_user_id:actor,metadata:{route_create_request_fingerprint:fp}};
const replay=({route=saved,audit=receipt,requestFingerprint=fp,actorUserId=actor,
  teamMemberId=member,requestDate="2026-10-28",operatorId="operator-1",requestId=id}={})=>
  routeReplayState({route,audit,requestFingerprint,actorUserId,teamMemberId,requestDate,operatorId,requestId});

test("route save operation ID is a real UUID and independent of client user-supplied fields",()=>{
  assert.equal(isClientRouteCreateId(id),true);
  for(const invalid of ["","a-random-key","not-a-uuid",null,undefined,4])assert.equal(isClientRouteCreateId(invalid),false);
  assert.equal(routeCreateFingerprint({...request,clientRouteId:"f21cb87c-4af4-4436-93a4-f839f312d931"}),fp);
  assert.notEqual(routeCreateFingerprint({...request,routeDate:"2026-10-29"}),fp);
  assert.notEqual(routeCreateFingerprint({...request,manualStopItems:[{machineId:"m1",productId:"p1",quantity:5}]}),fp);
});

test("a completed route replays ONLY with matching owner, exact input, and final audit receipt",()=>{
  assert.equal(replay(),"complete");
  assert.equal(replay({route:null}),"absent");
  assert.equal(replay({audit:null}),"in_progress");
  assert.equal(replay({route:{...saved,created_by:"other"}}),"conflict");
  assert.equal(replay({route:{...saved,id:"different"}}),"conflict");
  assert.equal(replay({route:{...saved,route_date:"2026-10-29"}}),"conflict");
  assert.equal(replay({route:{...saved,operator_id:null}}),"conflict");
  assert.equal(replay({teamMemberId:null}),"conflict");
  assert.equal(replay({actorUserId:"other"}),"conflict");
  assert.equal(replay({requestFingerprint:"wrong"}),"conflict");
  assert.equal(replay({audit:{...receipt,actor_user_id:"other"}}),"conflict");
  assert.equal(replay({audit:{...receipt,metadata:null}}),"conflict");
});

test("server checks original receipt before changing stock reservations",()=>{
  const api=readFileSync("src/app/api/routes/route.ts","utf8");
  assert.match(api,/clientRouteId\?: string/);
  assert.match(api,/isClientRouteCreateId\(clientRouteId\)/);
  assert.match(api,/routeCreateFingerprint\(payload/);
  const lookup=api.indexOf("const findExistingSubmission = async");
  const early=api.indexOf("const saved = await findExistingSubmission()",lookup);
  const stock=api.indexOf("await validateRouteStock(planningReadClient, stockByProduct)",early);
  assert.ok(lookup>=0&&early>lookup&&stock>early,"Replay must precede stock re-validation");
  assert.equal((api.match(/\.\.\.\(clientRouteId \? \{ id: clientRouteId \} : \{\}\)/g)??[]).length,2,
    "Both enum-fallback insert paths must use the SAME UUID route primary key");
  assert.match(api,/routeInsert\.error\?\.code === "23505"/);
  assert.match(api,/state==="complete"/);
  assert.match(api,/route_save_pending/);
  assert.match(api,/route_request_conflict/);
  assert.match(api,/route_create_request_fingerprint: routeRequestFingerprint/);
  assert.match(api,/idempotencyKey: clientRouteId/);
  assert.doesNotMatch(api,/ignoreDuplicates:\s*true.*routes/s);
});

test("route creation UI has immediate synchronous lock, frozen payload and stable retry identity",()=>{
  const ui=readFileSync("src/app/routes/new/RouteCreateForm.tsx","utf8");
  assert.match(ui,/if \(routeSaveInFlightRef\.current \|\| routeSaveCompletedRef\.current\) return/);
  assert.match(ui,/routeSaveInFlightRef\.current = true/);
  assert.match(ui,/routeSaveInFlightRef\.current = false/);
  assert.match(ui,/routeSaveCompletedRef\.current = true/);
  assert.match(ui,/frozenRouteRequestRef\.current/);
  assert.match(ui,/routeCreateRequestIdRef\.current/);
  assert.match(ui,/sessionStorage\.setItem\(storageKey, routeCreateRequestIdRef\.current\)/);
  assert.match(ui,/JSON\.stringify\(frozenRouteRequestRef\.current\)/);
  assert.match(ui,/clientRouteId: routeCreateRequestIdRef\.current/);
  assert.match(ui,/if \(response\.status === 400\)/);
  assert.match(ui,/window\.sessionStorage\.removeItem\("snacky:route-create-id:v1"\)/);
  assert.match(ui,/Check previous save safely/);
  assert.match(ui,/aria-busy=\{saving\}/);
});


test("a reloaded route form recovers the exact original UUID and frozen request",()=>{
  const ui=readFileSync("src/app/routes/new/RouteCreateForm.tsx","utf8");
  assert.match(ui,/sessionStorage\.getItem\("snacky:route-create-id:v1"\)/);
  assert.match(ui,/sessionStorage\.getItem\("snacky:route-create-payload:v1"\)/);
  assert.match(ui,/sessionStorage\.setItem\("snacky:route-create-payload:v1", JSON\.stringify\(frozenRouteRequestRef\.current\)\)/);
  assert.match(ui,/record\.clientRouteId === id/);
  assert.match(ui,/const recoverSavedRouteRequest = async/);
  assert.match(ui,/body: JSON\.stringify\(original\)/);
  assert.match(ui,/if \(storedRouteRecovery !== "none"\)/);
  assert.match(ui,/Resume the SAME saved route/);
  assert.match(ui,/Check existing routes/);
  assert.match(ui,/const discardSavedRouteRequest/);
  assert.match(ui,/window\.confirm\(tr\(locale,/);
  assert.match(ui,/sessionStorage\.removeItem\("snacky:route-create-payload:v1"\)/);
  assert.match(ui,/storedRouteRecovery === "id_only"/);
});
