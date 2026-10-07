import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planner = fs.readFileSync(path.join(repoRoot, "src/lib/smart-route-planner.ts"), "utf8");
const api = fs.readFileSync(path.join(repoRoot, "src/app/api/routes/smart-plan/route.ts"), "utf8");
const routeApi = fs.readFileSync(path.join(repoRoot, "src/app/api/routes/route.ts"), "utf8");
const form = fs.readFileSync(path.join(repoRoot, "src/app/routes/new/RouteCreateForm.tsx"), "utf8");
const rulesPage = fs.readFileSync(path.join(repoRoot, "src/app/settings/smart-routes/page.tsx"), "utf8");
const operatorStop = fs.readFileSync(path.join(repoRoot, "src/app/operator/routes/[id]/stops/[stopId]/page.tsx"), "utf8");
const migration = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20261004061000_smart_route_planner.sql"), "utf8");
const contextMigration = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20261004062500_smart_route_machine_context.sql"), "utf8");
const operatorPickList = fs.readFileSync(path.join(repoRoot, "src/app/operator/routes/[id]/pick-list/page.tsx"), "utf8");
const operatorSmartApi = fs.readFileSync(path.join(repoRoot, "src/app/api/operator/routes/[id]/smart-plan/route.ts"), "utf8");
const applyMigration = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20261007105000_apply_smart_route_plan.sql"), "utf8");

test("smart planner is draft-only and refreshes XY before reasoning", () => {
  assert.match(planner, /import "server-only"/);
  assert.match(planner, /ensureFreshXyRoutePlanningData/);
  assert.match(api, /generateSmartRoutePlan/);
  assert.doesNotMatch(api, /\.from\("routes"\)\.insert/);
  assert.doesNotMatch(api, /\.from\("inventory_movements"\)\.insert/);
});

test("verified unreserved storage is a hard candidate and allocation limit", () => {
  assert.match(planner, /route_storage_stock_by_product/);
  assert.match(planner, /ROUTE_RESERVATION_STATUSES/);
  assert.match(planner, /available <= 0 \|\| prohibitedIds\.has\(candidate\.id\)/);
  assert.match(planner, /const available = Math\.max\(0, remaining\.get\(candidate\.productId\) \?\? 0\)/);
  assert.match(planner, /Math\.min\(task\.neededQty, requested \|\| task\.neededQty, available\)/);
  assert.match(routeApi, /validateRouteStock\(planningReadClient, stockByProduct\)/);
});

test("substitutions use a transition zone before an unavailable product reaches zero", () => {
  assert.match(planner, /transitionFloorQty = Math\.max\(2, Math\.ceil\(capacity \* 0\.5\)\)/);
  assert.match(planner, /projectedQtyAtNextService/);
  assert.match(planner, /originalAvailableUnits <= 0/);
  assert.match(planner, /transitionMode !== "none"/);
  assert.match(planner, /replaceNow \? capacity : refillNeededQty/);
  assert.match(planner, /if \(!allowSubstitution\) return null/);
  assert.match(planner, /candidateFit !== currentFit/);
  assert.match(planner, /explicitlyAllowedIds/);
  assert.match(planner, /historically_seen_exact_slot/);
  assert.match(planner, /rule\?\.rule === "prohibited"/);
});

test("planned product changes return old stock before XY replacement and never mix products", () => {
  assert.match(planner, /Returned from machine → Product replaced/);
  assert.match(planner, /Do not mix the two products in one lane/);
  assert.match(planner, /returnCurrentQty/);
  assert.match(form, /Change before empty/);
  assert.match(form, /Remove and return/);
  assert.match(operatorStop, /item\.notes/);
});

test("AI can choose only backend-provided candidates and invalid choices fall back safely", () => {
  assert.match(planner, /Never invent a product ID/);
  assert.match(planner, /task\.candidates\.find\(\(row\) => row\.productId === String\(decision\?\.selectedProductId/);
  assert.match(planner, /fallbackDecision\(\{/);
  assert.match(planner, /next highest-ranked compatible in-stock product/);
  assert.match(planner, /plannerMode: "ai" \| "deterministic_fallback"/);
});

test("demand ranking uses XY stock depletion plus previous route fills", () => {
  assert.match(planner, /snacky_smart_route_demand_signals/);
  assert.match(planner, /route_stop_fill_lines/);
  assert.match(planner, /machineDemandUnits/);
  assert.match(planner, /locationTypeDemandUnits/);
  assert.match(planner, /recentRouteFillUnits/);
  assert.match(migration, /previous_qty > current_qty/);
  assert.match(migration, /then previous_qty - current_qty/);
});

test("route builder exposes Generate smart plan and keeps final review canonical", () => {
  assert.match(form, /Generate smart plan/);
  assert.match(form, /\/api\/routes\/smart-plan/);
  assert.match(form, /Smart route draft — review before creating/);
  assert.match(form, /Nothing is reserved until you create the route/);
  assert.match(form, /fetch\("\/api\/routes"/);
});

test("smart plan slot context survives final route creation", () => {
  assert.match(routeApi, /source: item\.source/);
  assert.match(routeApi, /machine_slot_id: item\.machineSlotId/);
  assert.match(routeApi, /slot_code: item\.slotCode/);
  assert.match(routeApi, /notes: item\.notes/);
});

test("smart planning rule tables are server-only with RLS", () => {
  for (const table of [
    "smart_route_product_profiles",
    "smart_route_slot_product_rules",
    "smart_route_location_product_rules",
    "smart_route_plan_audits",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(contextMigration, /alter table public\.smart_route_machine_context enable row level security/);
  assert.match(contextMigration, /revoke all on table public\.smart_route_machine_context from public, anon, authenticated/);
  assert.match(contextMigration, /machine_id uuid references public\.machines\(id\) on delete cascade/);
  assert.match(contextMigration, /num_nonnulls\(machine_id, location_id, location_type\) = 1/);
  assert.match(migration, /grant execute on function public\.snacky_smart_route_demand_signals\(integer\) to service_role/);
  assert.match(migration, /grant execute on function public\.snacky_smart_route_slot_fit_history\(uuid\[\], integer\) to service_role/);
});

test("smart planner mirrors canonical active route reservation filtering", () => {
  assert.match(planner, /from\("routes"\)\.select\("id, status"\)\.in\("status", \[\.\.\.ROUTE_RESERVATION_STATUSES\]\)/);
  assert.match(planner, /reservingRouteIds\.has\(routeId\)/);
});

test("smart draft is cleared when machine selection or normal XY suggestions change", () => {
  assert.match(form, /const toggleRouteMachine = \(machineId: string\) => \{\s*setSmartPlan\(null\)/);
  assert.match(form, /const applySuggestedQuantities = \([^)]*\) => \{\s*setSmartPlan\(null\)/);
});


test("owner rule screen exposes hard venue, fit, and lane controls", () => {
  assert.match(rulesPage, /Smart route rules/);
  assert.match(rulesPage, /smart_route_machine_context/);
  assert.match(rulesPage, /smart_route_product_profiles/);
  assert.match(rulesPage, /smart_route_location_product_rules/);
  assert.match(rulesPage, /smart_route_slot_product_rules/);
  assert.match(rulesPage, /isOwnerAdminRole/);
  assert.match(rulesPage, /Prohibited products are removed before the AI sees candidates/);
});

test("large route AI reasoning is batched and each failed batch falls back safely", () => {
  assert.match(planner, /AI_TASK_BATCH_SIZE = 40/);
  assert.match(planner, /tasks\.slice\(offset, offset \+ AI_TASK_BATCH_SIZE\)/);
  assert.match(planner, /batch\.map\(fallbackDecision\)/);
});


test("empty lanes are merchandised by AI instead of blindly restoring the old SKU", () => {
  assert.match(planner, /emptyLane \? 12 : 55/);
  assert.match(planner, /Every empty lane must receive a compatible in-stock candidate/);
  assert.match(planner, /Repeating the same strong product across multiple lanes is explicitly allowed/);
  assert.match(planner, /aCoverage \* 20/);
  assert.match(form, /No-empty-lane policy: AI may repeat strong sellers across lanes/);
});

test("route-wide allocation retries another compatible product instead of dropping a lane", () => {
  assert.match(planner, /Smart Route tried the next-best compatible product instead/);
  assert.match(planner, /HARD NO-EMPTY-LANE EXCEPTION/);
  assert.match(planner, /task\.candidates\.find\(\(row\) => \{/);
  assert.match(planner, /priority = \{ empty_lane: 3, replace_now: 2, none: 1 \}/);
});

test("historical exact-slot evidence can override imperfect inferred fit labels", () => {
  assert.match(planner, /candidateGroup !== currentGroup && !explicitAllowed && !historicallySeen/);
  assert.match(planner, /!explicitAllowed && !historicallySeen && candidateFit !== currentFit/);
});


test("smart plan preserves per-lane assignments separately from pickup totals", () => {
  assert.match(planner, /slotAssignments: SmartRoutePlanItem\[\]/);
  assert.match(planner, /function slotAssignmentItems/);
  assert.match(planner, /machineSlotId: decision\.machineSlotId/);
  assert.match(planner, /slotCode: decision\.slotCode/);
  assert.match(planner, /slotAssignments,\s*substitutions/);
});

test("replanning an existing route excludes that route's old reservation", () => {
  assert.match(planner, /excludeRouteId\?: string \| null/);
  assert.match(planner, /routeId === String\(input\.excludeRouteId \?\? ""\)/);
  assert.match(operatorSmartApi, /excludeRouteId: routeId/);
});

test("operator can build Smart Pickup at storage before confirmation", () => {
  assert.match(operatorPickList, /AI Smart Pickup/);
  assert.match(operatorPickList, /Build Smart Pickup/);
  assert.match(operatorPickList, /\/api\/operator\/routes\/\$\{routeId\}\/smart-plan/);
  assert.match(operatorPickList, /no usable lane is left empty/);
  assert.match(operatorPickList, /setPrepared\(Boolean\(payload\.prepared\)\)/);
  assert.match(operatorSmartApi, /generateSmartRoutePlan/);
  assert.match(operatorSmartApi, /plan\.slotAssignments/);
});

test("Smart Pickup refuses to overwrite physical pickup history", () => {
  assert.match(operatorSmartApi, /picked_quantity/);
  assert.match(operatorSmartApi, /picked_qty/);
  assert.match(operatorSmartApi, /storage_to_operator_bag/);
  assert.match(operatorSmartApi, /prepared_at/);
  assert.match(applyMigration, /Smart Route cannot be regenerated after pickup has started/);
});

test("Smart Pickup apply is atomic planning only and leaves storage deduction to confirmation", () => {
  assert.match(applyMigration, /snacky_apply_smart_route_plan_v1/);
  assert.match(applyMigration, /delete from public\.route_stop_items/);
  assert.match(applyMigration, /insert into public\.route_stop_items/);
  assert.match(applyMigration, /insert into public\.route_stock_lines/);
  assert.match(applyMigration, /'smart_ai_plan'/);
  assert.doesNotMatch(applyMigration, /insert into public\.inventory_movements/i);
  assert.doesNotMatch(applyMigration, /update public\.inventory/i);
  assert.match(applyMigration, /security invoker/);
  assert.match(applyMigration, /set search_path = pg_catalog/);
  assert.match(applyMigration, /route_stop_items_source_check/);
  assert.match(applyMigration, /refill_order_lines_source_check/);
  assert.match(applyMigration, /'smart_ai_plan'::text/);
  assert.match(applyMigration, /recommended_take_qty/);
  assert.match(applyMigration, /final_take_qty/);
  assert.match(applyMigration, /grant execute on function public\.snacky_apply_smart_route_plan_v1\(uuid, jsonb\) to service_role/);
});
