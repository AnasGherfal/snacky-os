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
const migration = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20261004061000_smart_route_planner.sql"), "utf8");
const contextMigration = fs.readFileSync(path.join(repoRoot, "supabase/migrations/20261004062500_smart_route_machine_context.sql"), "utf8");

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

test("substitutions are allowed only for empty lanes and compatible products", () => {
  assert.match(planner, /const allowSubstitution = currentQty === 0/);
  assert.match(planner, /if \(!allowSubstitution\) return null/);
  assert.match(planner, /candidateFit !== currentFit/);
  assert.match(planner, /explicitlyAllowedIds/);
  assert.match(planner, /historically_seen_exact_slot/);
  assert.match(planner, /rule\?\.rule === "prohibited"/);
});

test("AI can choose only backend-provided candidates and invalid choices fall back safely", () => {
  assert.match(planner, /Never invent a product ID/);
  assert.match(planner, /task\.candidates\.find\(\(row\) => row\.productId === String\(decision\?\.selectedProductId/);
  assert.match(planner, /fallbackDecision\(task\)/);
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
