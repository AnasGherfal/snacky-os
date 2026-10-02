import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function functionBody(source, functionName) {
  const start = source.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `${functionName} must be defined`);
  const definition = source.slice(start);
  const match = definition.match(/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i);
  assert.ok(match, `${functionName} must have a dollar-quoted body`);
  return compact(match[2]);
}

function sourceFunction(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const next = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("discrepancy review migration is append-only and authenticated", () => {
  const migration = read("supabase/migrations/20260905092000_route_inventory_discrepancy_resolution.sql");
  const normalized = compact(migration);

  assert.match(normalized, /create table if not exists public\.route_inventory_discrepancy_resolution_events/i);
  assert.match(normalized, /unique \(client_submission_id\)/i);
  assert.match(normalized, /unique index if not exists idx_route_inventory_discrepancies_id_route on public\.route_inventory_discrepancies\(id, route_id\)/i);
  assert.match(normalized, /foreign key \(discrepancy_id, route_id\) references public\.route_inventory_discrepancies\(id, route_id\) on delete restrict/i);
  assert.match(normalized, /length\(client_submission_id\) <= 200/i);
  assert.match(normalized, /notes is null or length\(notes\) <= 2000/i);
  assert.match(normalized, /before update or delete on public\.route_inventory_discrepancy_resolution_events/i);
  assert.match(normalized, /append-only/i);
  assert.match(normalized, /enable row level security/i);
  assert.match(normalized, /revoke all on table public\.route_inventory_discrepancy_resolution_events from public, anon, authenticated/i);
  assert.match(normalized, /grant select on table public\.route_inventory_discrepancy_resolution_events to authenticated/i);
  assert.match(normalized, /snacky_current_profile_has_any_role\(array\['owner', 'admin', 'supervisor'\]\)/i);
  assert.doesNotMatch(normalized, /route_inventory_discrepancy_resolution_events_select[^;]+warehouse/i);
});

test("every automatic discrepancy status transition is appended to immutable history", () => {
  const migration = read("supabase/migrations/20260905092000_route_inventory_discrepancy_resolution.sql");
  const normalized = compact(migration);
  const body = functionBody(migration, "_snacky_audit_route_inventory_discrepancy_status_change");

  for (const action of ["system_reconciled", "system_reopened", "system_transition"]) {
    assert.match(normalized, new RegExp(`'${action}'`, "i"));
    assert.match(body, new RegExp(`'${action}'`, "i"));
  }
  assert.match(body, /current_setting\('snacky\.route_inventory_review_discrepancy_id', true\)/i);
  assert.match(body, /insert into public\.route_inventory_discrepancy_resolution_events/i);
  assert.match(body, /old\.status/i);
  assert.match(body, /new\.status/i);
  assert.match(body, /new\.correcting_movement_id/i);
  assert.match(normalized, /after update of status on public\.route_inventory_discrepancies for each row when \(old\.status is distinct from new\.status\)/i);
  assert.match(normalized, /revoke all on function public\._snacky_audit_route_inventory_discrepancy_status_change\(\) from public, anon, authenticated/i);
});

test("resolver changes review state atomically but never writes inventory", () => {
  const migration = read("supabase/migrations/20260905092000_route_inventory_discrepancy_resolution.sql");
  const body = functionBody(migration, "snacky_resolve_route_inventory_discrepancy_v1");

  assert.match(body, /auth\.uid\(\)/i);
  assert.match(body, /snacky_current_profile_has_any_role\(array\['owner', 'admin', 'supervisor'\]\)/i);
  assert.match(body, /from public\.route_inventory_discrepancies[\s\S]*for update/i);
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /client_submission_id/i);
  assert.match(body, /start_investigation/i);
  assert.match(body, /accept_reconciled_variance/i);
  assert.match(body, /reopen/i);
  assert.match(body, /correcting_movement_id/i);
  assert.match(body, /adjustment_movement_id/i);
  assert.match(body, /movement\.related_route_id = v_discrepancy\.route_id/i);
  assert.match(body, /movement\.product_id = v_discrepancy\.product_id/i);
  assert.match(body, /reversal\.reversed_movement_id = movement\.id/i);
  assert.match(body, /insert into public\.route_inventory_discrepancy_resolution_events/i);
  assert.match(body, /update public\.route_inventory_reconciliation_lines/i);
  assert.match(body, /update public\.route_inventory_reconciliations/i);
  assert.doesNotMatch(body, /insert into public\.inventory_movements/i);
  assert.doesNotMatch(body, /(update|delete from) public\.inventory_movements/i);

  assert.match(compact(migration), /revoke all on function public\.snacky_resolve_route_inventory_discrepancy_v1\(uuid, text, text, text, timestamptz\) from public, anon/i);
  assert.match(compact(migration), /grant execute on function public\.snacky_resolve_route_inventory_discrepancy_v1\(uuid, text, text, text, timestamptz\) to authenticated/i);
});

test("resolver idempotency is state-aware after reopening or automatic reconciliation", () => {
  const migration = read("supabase/migrations/20260905092000_route_inventory_discrepancy_resolution.sql");
  const body = functionBody(migration, "snacky_resolve_route_inventory_discrepancy_v1");
  const lockIndex = body.indexOf("from public.route_inventory_discrepancies discrepancy_row where discrepancy_row.id = p_discrepancy_id for update");
  const retryIndex = body.indexOf("if v_existing.id is not null then");

  assert.ok(lockIndex >= 0 && retryIndex > lockIndex,
    "an idempotent retry must lock and inspect the current discrepancy before returning success");
  assert.match(body, /v_discrepancy\.status is distinct from v_existing\.next_status/i);
  assert.match(body, /applied before the discrepancy changed again/i);
  assert.match(body, /errcode = '40001'/i);
  assert.match(body, /if p_expected_updated_at is not null[\s\S]*v_discrepancy\.updated_at is distinct from p_expected_updated_at/i);
});

test("acceptance proves exact authoritative terminal, global-alignment, or stop evidence", () => {
  const migration = read("supabase/migrations/20260905092000_route_inventory_discrepancy_resolution.sql");
  const body = functionBody(migration, "snacky_resolve_route_inventory_discrepancy_v1");

  assert.match(body, /source_type = 'route_terminal_reconciliation_line'/i);
  assert.match(body, /v_discrepancy\.source_id is distinct from v_line_id/i);
  assert.match(body, /v_line_adjustment_movement_id is distinct from v_discrepancy\.correcting_movement_id/i);
  assert.match(body, /movement\.source_type = 'route_terminal_reconciliation'/i);
  assert.match(body, /movement\.source_id = v_line_id/i);
  assert.match(body, /movement\.quantity::bigint = v_discrepancy\.absolute_quantity::bigint/i);
  assert.match(body, /v_discrepancy\.difference_quantity > 0[\s\S]*movement\.from_entity_type::text = 'adjustment'[\s\S]*movement\.to_entity_type::text = 'operator_bag'/i);
  assert.match(body, /v_discrepancy\.difference_quantity < 0[\s\S]*movement\.from_entity_type::text = 'operator_bag'[\s\S]*movement\.to_entity_type::text = 'adjustment'/i);

  assert.match(body, /source_type = 'route_terminal_global_bag_alignment'/i);
  assert.match(body, /source_line\.id = v_discrepancy\.source_id/i);
  assert.match(body, /movement\.related_route_id is null/i);
  assert.match(body, /movement\.source_type = 'route_terminal_global_bag_alignment'/i);
  assert.match(body, /movement\.to_entity_id = v_discrepancy\.operator_id/i);

  assert.match(body, /source_type = 'route_pickup_global_bag_alignment'/i);
  assert.match(body, /batch_row\.id = v_discrepancy\.source_id[\s\S]*batch_row\.status = 'cancelled'[\s\S]*returned_to_assigned_at is not null/i);
  assert.match(body, /movement\.source_type = 'route_pickup_global_bag_alignment'/i);
  assert.match(body, /return_movement\.source_type = 'route_pickup_return'/i);
  assert.match(body, /return_movement\.reversed_movement_id = pickup\.id/i);
  assert.match(body, /where batch_row\.id = v_discrepancy\.source_id for share/i,
    "the pristine-return batch proof must be stable while the variance is accepted");
  assert.match(body, /route_pickup_global_bag_alignment[\s\S]*where movement\.id = v_evidence_movement_id for update/i,
    "the pickup alignment movement must be row-locked before it is validated");
  assert.match(body, /where reversal\.reversed_movement_id = v_evidence_movement_id order by reversal\.id for update/i,
    "alignment reversals must be locked before accepting the case");
  assert.match(body, /route_pickup_return[\s\S]*order by return_movement\.id for update/i,
    "the exact pickup-return movements must remain locked during acceptance");

  assert.match(body, /source_type = 'route_stop_inventory_commit'/i);
  assert.match(body, /v_discrepancy\.source_id is distinct from v_discrepancy\.route_stop_id/i);
  assert.match(body, /movement\.source_type = 'route_stop_inventory_v1'/i);
  assert.match(body, /movement\.source_id = v_discrepancy\.route_stop_id/i);
  assert.match(body, /movement\.to_entity_type::text in \('machine', 'machine_storage'\)/i);
  assert.match(body, /then movement\.quantity::bigint[\s\S]*then -movement\.quantity::bigint/i,
    "split stop shortages must be validated from signed active business legs");
  assert.match(body, /v_evidence_quantity is distinct from v_discrepancy\.absolute_quantity::bigint/i);
  assert.match(body, /not exists \( select 1 from public\.inventory_movements reversal where reversal\.reversed_movement_id = movement\.id \)/i,
    "the human-facing exemplar must still be an effective, unreversed movement");
  assert.match(body, /where movement\.id = v_evidence_movement_id for update/i,
    "single-movement evidence must be row-locked before validation");
  assert.match(body, /where reversal\.reversed_movement_id = v_evidence_movement_id order by reversal\.id for update/i,
    "existing reversals must remain locked while evidence is accepted");
  assert.match(body, /route_stop_inventory_v1[\s\S]*order by movement\.id for update/i,
    "all split stop-shortage forward legs must be locked before aggregation");
  assert.match(body, /movement\.from_entity_type::text in \('machine', 'machine_storage'\)[\s\S]*movement\.to_entity_type::text = 'adjustment'/i,
    "reverse-oriented business legs must use the same evidence lock set");
  assert.match(
    body,
    /movement\.source_id = v_discrepancy\.route_stop_id and movement\.reversed_movement_id is null and not exists \( select 1 from public\.inventory_movements reversal where reversal\.reversed_movement_id = movement\.id \); if v_evidence_quantity/i,
    "the full stop-shortage proof must count only active, unreversed business legs",
  );
  assert.match(body, /does not have a supported authoritative inventory source/i);
});

test("manual review suppresses only its duplicate trigger event and bounds all client text", () => {
  const migration = read("supabase/migrations/20260905092000_route_inventory_discrepancy_resolution.sql");
  const body = functionBody(migration, "snacky_resolve_route_inventory_discrepancy_v1");

  assert.match(body, /length\(v_submission_id\) > 200/i);
  assert.match(body, /length\(coalesce\(v_notes, ''\)\) > 2000/i);
  assert.match(body, /set_config\( 'snacky\.route_inventory_review_discrepancy_id', v_discrepancy\.id::text, true \)/i);
  assert.match(body, /insert into public\.route_inventory_discrepancy_resolution_events/i);
  assert.match(body, /set_config\( 'snacky\.route_inventory_review_discrepancy_id', '', true \)/i);
  assert.ok(
    body.lastIndexOf("set_config( 'snacky.route_inventory_review_discrepancy_id', '', true )")
      > body.indexOf("insert into public.route_inventory_discrepancy_resolution_events"),
    "the duplicate-event marker must be cleared only after the explicit immutable event is written",
  );
});

test("missing-schema fallback is code-specific and does not hide permission failures", () => {
  const helper = read("src/lib/route-inventory-discrepancies.ts");
  const body = sourceFunction(helper, "isMissingRouteInventoryReviewSchema");
  for (const code of ["42P01", "PGRST202", "PGRST204", "PGRST205"]) assert.match(body, new RegExp(code));
  assert.doesNotMatch(body, /42501|permission|denied/i);
});

test("manager queue provides bilingual open/history review without direct writes", () => {
  const page = read("src/app/routes/inventory-review/page.tsx");
  const action = read("src/lib/route-inventory-discrepancy-actions.ts");

  assert.match(page, /isAdminRole\(profile\)/);
  assert.match(page, /ROUTE_INVENTORY_OPEN_STATUSES/);
  assert.match(page, /ROUTE_INVENTORY_CLOSED_STATUSES/);
  assert.match(page, /MobileCardList/);
  assert.match(page, /DataTable/);
  assert.match(page, /بدء التحقيق/);
  assert.match(page, /اعتماد الفرق الذي تمت تسويته/);
  assert.match(page, /إعادة فتح المراجعة/);
  assert.equal(page.match(/cancelLabel=\{tr\("Cancel", "إلغاء"\)\}/g)?.length, 3,
    "every inventory-review confirmation must localize its cancel action");
  assert.match(page, /params\.success \? <div role="status"/);
  assert.match(page, /params\.error \? <div role="alert"/);
  assert.match(page, /aria-current=\{view === "open" \? "page" : undefined\}/);
  assert.match(page, /aria-current=\{view === "history" \? "page" : undefined\}/);
  assert.match(page, /Units in cases shown/);
  assert.match(page, /الوحدات في الحالات المعروضة/);
  assert.match(page, /Shown cases investigating/);
  assert.doesNotMatch(page, /tr\("Units represented",/);
  assert.doesNotMatch(page, /Closed cases shown/);
  assert.match(page, /routeInventoryDiscrepancyHasCorrection/);
  assert.match(page, /isMissingRouteInventoryReviewSchema\(discrepancyResult\.error\)/);

  assert.match(action, /getAuthenticatedSupabaseServerClient/);
  assert.match(action, /isAdminRole\(profile\)/);
  assert.match(action, /rpc\("snacky_resolve_route_inventory_discrepancy_v1"/);
  assert.doesNotMatch(action, /\.from\("route_inventory_discrepancies"\)\.(insert|update|delete)/);
  assert.doesNotMatch(action, /\.from\("inventory_movements"\)\.(insert|update|delete)/);
});

test("route list and route detail expose the review workflow", () => {
  const routesPage = read("src/app/routes/page.tsx");
  const routeDetail = read("src/app/routes/[id]/page.tsx");
  const dashboard = read("src/app/dashboard/page.tsx");

  assert.match(routesPage, /isAdminRole\(profile\)/);
  assert.match(routesPage, /href="\/routes\/inventory-review"/);
  assert.match(routesPage, /مراجعة فروق المخزون/);

  assert.match(routeDetail, /route_inventory_discrepancies/);
  assert.match(routeDetail, /isMissingRouteInventoryReviewSchema/);
  assert.match(routeDetail, /\{ count: "exact" \}/);
  assert.match(routeDetail, /ROUTE_INVENTORY_OPEN_STATUSES/);
  assert.match(routeDetail, /openRouteDiscrepancies/);
  assert.match(routeDetail, /`\/routes\/inventory-review\?route=\$\{id\}`/);
  assert.match(routeDetail, /إجراءات حالة المراجعة لا تنقل المخزون/);

  assert.match(dashboard, /canReviewRouteInventory = isAdminRole\(profile\)/);
  assert.match(dashboard, /route_inventory_discrepancies/);
  assert.match(dashboard, /if \(isMissingRouteInventoryReviewSchema\(result\.error\)\) return 0/);
  assert.match(dashboard, /href: "\/routes\/inventory-review"/);
  assert.match(dashboard, /مراجعة فروق مخزون الجولات/);
  assert.match(dashboard, /dashboardSectionLabels: Record<DashboardSection, \{ en: string; ar: string \}>/);
  assert.match(dashboard, /routeInventoryReview: \{ en: "Route inventory review", ar: "مراجعة مخزون الجولات" \}/);
  assert.match(dashboard, /return localize\(label\.en, label\.ar\)/);
  assert.doesNotMatch(dashboard, /partialSections\.map\(\(\[key\]\) => dashboardSectionLabels/);
});
