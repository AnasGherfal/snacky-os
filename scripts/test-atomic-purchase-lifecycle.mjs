import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const receiveVoidPath = "supabase/migrations/20260906153000_atomic_purchase_receive_void.sql";
const draftPath = "supabase/migrations/20260906153100_atomic_purchase_draft_lifecycle.sql";
const receiveVoidMigration = read(receiveVoidPath);
const draftMigration = read(draftPath);
const receiveFunction = compact(between(
  receiveVoidMigration,
  "create or replace function public.snacky_receive_purchase_v1(",
  "revoke all on function public.snacky_receive_purchase_v1(",
));
const voidFunction = compact(between(
  receiveVoidMigration,
  "create or replace function public.snacky_void_received_purchase_v1(",
  "revoke all on function public.snacky_void_received_purchase_v1(",
));
const assertFunction = compact(between(
  receiveVoidMigration,
  "create or replace function public._snacky_assert_purchase_inventory_state_v1(",
  "revoke all on function public._snacky_assert_purchase_inventory_state_v1(",
));
const accountingFunction = compact(between(
  receiveVoidMigration,
  "create or replace function public._snacky_assert_purchase_accounting_v1(",
  "revoke all on function public._snacky_assert_purchase_accounting_v1(",
));
const updateFunction = compact(between(
  draftMigration,
  "create or replace function public.snacky_update_draft_purchase_v1(",
  "revoke all on function public.snacky_update_draft_purchase_v1(",
));
const cancelFunction = compact(between(
  draftMigration,
  "create or replace function public.snacky_cancel_draft_purchase_v1(",
  "revoke all on function public.snacky_cancel_draft_purchase_v1(",
));

const actionPath = path.join(root, "src/lib/purchase-actions.ts");
const actionSource = fs.readFileSync(actionPath, "utf8");
const purchaseFormSource = read("src/components/PurchaseForm.tsx");
const newPurchasePageSource = read("src/app/purchases/new/page.tsx");
const editPurchasePageSource = read("src/app/purchases/[id]/edit/page.tsx");
const purchaseDetailSource = read("src/app/purchases/[id]/page.tsx");
const actionAst = ts.createSourceFile(actionPath, actionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function action(name) {
  const declaration = actionAst.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration?.body, `${name} must exist`);
  return declaration;
}

function functionText(name) {
  return action(name).getText(actionAst);
}

test("purchase inventory commands are authenticated definers with private immutable receipts", () => {
  for (const body of [receiveFunction, voidFunction]) {
    assert.match(body, /security definer set search_path = ''/i);
    assert.match(body, /v_actor_user_id uuid := auth\.uid\(\)/i);
    assert.match(body, /snacky_current_team_member_id\(\)/i);
    assert.match(body, /client_submission_id/i);
    assert.match(body, /actor_user_id is distinct from v_actor_user_id/i);
    assert.match(body, /return v_operation\.result_payload/i);
  }
  assert.match(receiveFunction, /array\['owner', 'admin', 'supervisor', 'warehouse', 'purchasing'\]/i);
  assert.match(voidFunction, /array\['owner', 'admin', 'supervisor'\]/i);
  assert.match(receiveVoidMigration, /create table if not exists public\.purchase_inventory_operations[\s\S]*unique \(purchase_id, action\)[\s\S]*unique \(client_submission_id\)/i);
  assert.match(receiveVoidMigration, /before update or delete on public\.purchase_inventory_operations/i);
  assert.match(compact(receiveVoidMigration), /revoke all on table public\.purchase_inventory_operations from public, anon, authenticated, service_role/i);
  assert.match(compact(draftMigration), /revoke all on table public\.purchase_draft_operations from public, anon, authenticated, service_role/i);
  const compactMigration = compact(receiveVoidMigration);
  assert.match(compactMigration, /grant execute on function public\.snacky_receive_purchase_v1\(uuid, text, uuid\) to authenticated/i);
  assert.match(compactMigration, /grant execute on function public\.snacky_void_received_purchase_v1\(uuid, text, text\) to authenticated/i);
});

test("receive selects an exact physical destination and uses canonical lock ordering", () => {
  assert.match(receiveFunction, /p_receiving_storage_location_id uuid default null/i);
  assert.match(receiveFunction, /v_purchase\.receiving_storage_location_id/i);
  assert.match(receiveFunction, /storage\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\)/i);
  assert.match(receiveFunction, /if v_storage_candidate_count > 1 then raise exception 'More than one active physical storage exists/i);
  assert.doesNotMatch(receiveFunction, /order by storage\.(?:name|created_at)[\s\S]{0,200}limit 1/i);

  const purchaseLock = receiveFunction.indexOf("from public.purchase_orders purchase where purchase.id = p_purchase_id for update");
  const lineLock = receiveFunction.indexOf("from public.purchase_order_lines line where line.purchase_order_id = p_purchase_id order by line.product_id, line.line_position, line.id for update");
  const storageLock = receiveFunction.indexOf("pg_catalog.hashtext(v_product_lock.product_id::text), pg_catalog.hashtext(v_storage_location_id::text)");
  const productLock = receiveFunction.indexOf("from public.products product", storageLock);
  const movementInsert = receiveFunction.indexOf("insert into public.inventory_movements", productLock);
  assert.ok(purchaseLock >= 0 && lineLock > purchaseLock, "purchase and sorted lines must lock first");
  assert.ok(storageLock > lineLock && productLock > storageLock, "storage/product advisory locks must precede product rows");
  assert.ok(movementInsert > productLock, "ledger insert must follow all canonical locks");
  assert.match(receiveFunction, /linked inventory appeared while receiving this purchase[\s\S]*errcode = '40001'/i);
});

test("receive creates one exact receipt per line and never repairs malformed legacy state", () => {
  assert.match(receiveFunction, /v_existing_movement_count <> 0[\s\S]*Nothing was changed/i);
  assert.match(receiveFunction, /'purchase_receipt'[\s\S]*'purchase-receipt:v1:' \|\| p_purchase_id::text \|\| ':' \|\| line\.id::text/i);
  assert.match(receiveFunction, /'purchase_line_id', line\.id[\s\S]*'storage_location_id', v_storage_location_id[\s\S]*'quantity', line\.total_units/i);
  assert.match(receiveFunction, /update public\.purchase_order_lines line set received_qty = line\.total_units/i);
  assert.match(receiveFunction, /update public\.purchase_orders purchase set status = 'received'[\s\S]*receiving_storage_location_id = v_storage_location_id/i);
  assert.match(receiveFunction, /_snacky_assert_purchase_inventory_state_v1\( p_purchase_id, 'received', null, true, false \)/i);
  assert.match(receiveFunction, /count\(distinct line\.product_id\)[\s\S]*into v_requested_product_count/i);
  assert.match(receiveFunction, /select product\.id, product\.active[\s\S]*order by product\.id[\s\S]*for update/i);
  assert.match(receiveFunction, /v_product_lock\.active is not true[\s\S]*draft product is inactive/i);
  assert.match(receiveFunction, /v_locked_product_count <> v_requested_product_count[\s\S]*draft product is missing/i);
  const activeProof = receiveFunction.indexOf("v_locked_product_count <> v_requested_product_count");
  const movementInsert = receiveFunction.indexOf("insert into public.inventory_movements");
  assert.ok(activeProof > 0 && activeProof < movementInsert, "all products must be locked and active before inventory effects");
  assert.match(assertFunction, /v_receipt_count <> v_line_count/i);
  assert.match(assertFunction, /receipt movements do not exactly match their purchase lines/i);
  assert.doesNotMatch(receiveFunction, /on conflict[\s\S]*do update/i, "receive must not turn partial legacy rows into a synthetic success");
});

test("receive validates exact line and header accounting before any inventory effect", () => {
  assert.match(accountingFunction, /pg_catalog\.round\(line\.line_total_lyd::numeric, 2\) is distinct from pg_catalog\.round\( line\.unit_cost_lyd::numeric \* line\.total_units, 2 \)/i);
  assert.match(accountingFunction, /pg_catalog\.sum\( line\.line_total_lyd \)/i);
  assert.match(accountingFunction, /v_purchase\.calculated_total_lyd[\s\S]*is distinct from v_calculated_total/i);
  assert.match(accountingFunction, /v_purchase\.manual_total_lyd is null[\s\S]*total_source is distinct from 'calculated'/i);
  assert.match(accountingFunction, /v_purchase\.manual_total_lyd is not null[\s\S]*total_source is distinct from 'manual'/i);
  assert.match(accountingFunction, /v_selected_total <= 0/i);

  const accountingCheck = ({ lines, calculated, manual, total, source, adjustment }) => {
    const rounded = (value, scale = 2) => Number(Number(value).toFixed(scale));
    if (!lines.length || lines.some((line) => (
      line.units <= 0
      || line.unitCost < 0
      || line.lineTotal < 0
      || rounded(line.lineTotal) !== rounded(rounded(line.unitCost, 4) * line.units)
    ))) throw new Error("line accounting needs review");
    const lineSum = rounded(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const selected = rounded(manual ?? calculated);
    if (calculated < 0 || total < 0 || (manual ?? 0) < 0 || rounded(calculated) !== lineSum) {
      throw new Error("header accounting needs review");
    }
    if (selected <= 0 || rounded(total) !== selected) throw new Error("payable total invalid");
    if (manual == null && (source !== "calculated" || ![null, 0].includes(adjustment))) throw new Error("source invalid");
    if (manual != null && (source !== "manual" || rounded(adjustment) !== rounded(selected - lineSum))) throw new Error("source invalid");
  };
  const inventoryEffects = [];
  const receiveModel = (purchase) => {
    accountingCheck(purchase);
    inventoryEffects.push("receipt");
  };
  assert.throws(() => receiveModel({
    lines: [{ units: 2, unitCost: 5, lineTotal: 9 }],
    calculated: 9,
    manual: null,
    total: 9,
    source: "calculated",
    adjustment: null,
  }), /line accounting/);
  assert.throws(() => receiveModel({
    lines: [{ units: 2, unitCost: 5, lineTotal: 10 }],
    calculated: -10,
    manual: null,
    total: -10,
    source: "calculated",
    adjustment: null,
  }), /header accounting/);
  assert.deepEqual(inventoryEffects, [], "invalid legacy accounting must create zero inventory effects");

  const assertion = receiveFunction.indexOf("_snacky_assert_purchase_accounting_v1(p_purchase_id)");
  const firstMovement = receiveFunction.indexOf("insert into public.inventory_movements");
  assert.ok(assertion > 0 && assertion < firstMovement, "accounting assertion must precede inventory insertion");
  assert.equal(
    (receiveFunction.match(/_snacky_assert_purchase_accounting_v1\(p_purchase_id\)/gi) ?? []).length,
    3,
    "new receive, immutable retry, and verified legacy receive must all validate accounting",
  );
  const storedRetry = receiveFunction.indexOf("return v_operation.result_payload");
  const legacyRetry = receiveFunction.indexOf("'legacy_verified', true");
  const firstAssertion = receiveFunction.indexOf("_snacky_assert_purchase_accounting_v1(p_purchase_id)");
  const secondAssertion = receiveFunction.indexOf("_snacky_assert_purchase_accounting_v1(p_purchase_id)", firstAssertion + 1);
  assert.ok(firstAssertion < storedRetry && secondAssertion < legacyRetry);
});

test("void is payment-safe, reservation-safe, and exactly reverses every receipt", () => {
  assert.match(voidFunction, /payment_status in \('paid', 'partially_paid'\) or exists \( select 1 from public\.purchase_payments payment where payment\.purchase_order_id = p_purchase_id \)/i);
  assert.match(voidFunction, /Record an explicit supplier return\/refund instead/i);
  assert.match(voidFunction, /from public\.current_inventory_by_location inventory/i);
  assert.match(voidFunction, /from public\.route_stock_lines stock_line join public\.routes route_row/i);
  assert.match(voidFunction, /v_available - v_reserved < v_stock_group\.quantity_to_reverse/i);
  assert.match(assertFunction, /reversal\.line_total_lyd[\s\S]*is distinct from -pg_catalog\.round/i);
  assert.match(voidFunction, /'purchase_void'[\s\S]*'purchase-void:v1:' \|\| p_purchase_id::text/i);
  assert.match(voidFunction, /reversed_movement_id,[\s\S]*receipt\.id,[\s\S]*'purchase_void'/i);
  assert.match(assertFunction, /reversal\.reversed_movement_id = receipt\.id/i);
  assert.match(voidFunction, /_snacky_assert_purchase_inventory_state_v1\( p_purchase_id, 'voided', v_reason, false, true \)/i);
  assert.match(voidFunction, /return v_operation\.result_payload/i, "an exact retry must return the immutable stored result unchanged");
  assert.doesNotMatch(voidFunction, /result_payload \|\|/i);
});

test("draft edits canonicalize line money and derive header totals in the database", () => {
  assert.match(updateFunction, /with parsed_lines as \([\s\S]*priced_lines as \([\s\S]*canonical_lines as \(/i);
  assert.match(updateFunction, /when parsed_lines\.raw_line_total > 0 then parsed_lines\.raw_line_total \/ parsed_lines\.total_units else parsed_lines\.raw_unit_cost end, 4\) as canonical_unit_cost/i);
  assert.match(updateFunction, /pg_catalog\.round\( priced_lines\.canonical_unit_cost \* priced_lines\.total_units, 2 \) as canonical_line_total/i);
  assert.match(updateFunction, /'unit_cost', canonical_lines\.canonical_unit_cost[\s\S]*'line_total', canonical_lines\.canonical_line_total/i);
  assert.match(updateFunction, /pg_catalog\.sum\( line\.line_total_lyd \)/i);
  assert.match(updateFunction, /v_total_adjustment := case when v_manual_total is null then null/i);
  assert.match(updateFunction, /'lines', v_lines/i, "the immutable command must store canonical rather than raw lines");
  assert.match(updateFunction, /line\.unit_cost_lyd, line\.unit_cost_lyd, line\.line_total_lyd, line\.line_total_lyd/i);
  assert.match(updateFunction, /coalesce\(v_purchase\.payment_status, 'unpaid'\) <> 'unpaid'/i);
  assert.doesNotMatch(updateFunction, /p_payment_status|p_payment_account_id/i);
});

test("draft update and cancel refuse historical state and replay exact actor-bound results", () => {
  for (const body of [updateFunction, cancelFunction]) {
    assert.match(body, /security definer set search_path = ''/i);
    assert.match(body, /actor_user_id is distinct from v_actor_user_id/i);
    assert.match(body, /request_payload is distinct from v_request_payload/i);
    assert.match(body, /return v_operation\.result_payload/i);
    assert.match(body, /from public\.inventory_movements movement/i);
    assert.match(body, /from public\.purchase_payments payment/i);
    assert.match(body, /from public\.financial_transactions finance/i);
  }
  assert.match(updateFunction, /delete from public\.purchase_order_lines[\s\S]*insert into public\.purchase_order_lines[\s\S]*update public\.purchase_orders/i);
  assert.match(cancelFunction, /where purchase\.id = p_purchase_id and purchase\.status = 'draft' returning purchase\.\* into v_purchase/i);
  assert.match(draftMigration, /before update or delete on public\.purchase_draft_operations/i);
});

test("draft update rejects stale editors and catalog races before changing lines", () => {
  assert.match(updateFunction, /p_expected_updated_at timestamptz/i);
  assert.match(updateFunction, /'expected_updated_at', p_expected_updated_at/i);
  assert.match(updateFunction, /v_purchase\.updated_at is distinct from p_expected_updated_at[\s\S]*nothing was changed/i);
  assert.match(updateFunction, /from public\.suppliers supplier[\s\S]*for share/i);
  assert.match(updateFunction, /from public\.storage_locations storage[\s\S]*storage\.active = true[\s\S]*for share/i);
  assert.match(updateFunction, /select product\.id, product\.active[\s\S]*order by product\.id[\s\S]*for share of product/i);
  assert.match(updateFunction, /v_locked_product_count <> v_requested_product_count/i);

  const parentLock = updateFunction.indexOf("from public.purchase_orders purchase where purchase.id = p_purchase_id for update");
  const revisionCheck = updateFunction.indexOf("v_purchase.updated_at is distinct from p_expected_updated_at");
  const productLock = updateFunction.indexOf("select product.id, product.active");
  const lineDelete = updateFunction.indexOf("delete from public.purchase_order_lines");
  assert.ok(parentLock > 0 && revisionCheck > parentLock && productLock > revisionCheck && lineDelete > productLock);

  const updateText = functionText("updatePurchase");
  assert.match(updateText, /expected_updated_at/i);
  assert.match(updateText, /p_expected_updated_at: expectedUpdatedAt/i);
  assert.match(purchaseFormSource, /name="expected_updated_at" value={initialPurchase\.updatedAt \?\? ""}/i);

  const effects = [];
  const updateModel = ({ expected, actual, productsActive = true, storageActive = true }) => {
    if (expected !== actual) throw new Error("stale draft");
    if (!productsActive || !storageActive) throw new Error("catalog changed");
    effects.push("replace-lines");
  };
  assert.throws(() => updateModel({ expected: "r1", actual: "r2" }), /stale draft/);
  assert.throws(() => updateModel({ expected: "r2", actual: "r2", productsActive: false }), /catalog changed/);
  assert.deepEqual(effects, [], "stale or deactivated inputs must leave draft lines untouched");
});

test("application purchase lifecycle has no direct order, line, inventory, or finance writer", () => {
  const updateText = functionText("updatePurchase");
  const receiveHelperText = functionText("receivePurchaseById");
  const cancelText = functionText("cancelPurchase");
  const voidText = functionText("voidReceivedPurchase");

  assert.match(updateText, /rpc\("snacky_update_draft_purchase_v1"/i);
  assert.match(updateText, /p_receiving_storage_location_id: receivingStorageLocationId \|\| null/i);
  assert.match(receiveHelperText, /rpc\("snacky_receive_purchase_v1"/i);
  assert.match(receiveHelperText, /p_receiving_storage_location_id: receivingStorageLocationId/i);
  assert.match(cancelText, /rpc\("snacky_cancel_draft_purchase_v1"/i);
  assert.match(voidText, /rpc\("snacky_void_received_purchase_v1"/i);
  assert.equal(actionAst.statements.some(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "deleteDraftPurchase",
  ), false, "hard deletion must not bypass immutable command history");

  const lifecycleText = [updateText, receiveHelperText, cancelText, voidText].join("\n");
  assert.doesNotMatch(lifecycleText, /\.from\("(?:purchase_order_lines|inventory_movements)"\)\s*\.(?:insert|update|upsert|delete)/i);
  assert.doesNotMatch(lifecycleText, /\.from\("purchase_orders"\)\s*\.(?:insert|update|upsert|delete)/i);
  assert.doesNotMatch(lifecycleText, /\.from\("financial_transactions"\)\s*\.(?:insert|update|upsert|delete)/i);
  assert.doesNotMatch(lifecycleText, /createPurchaseFinancialTransaction|syncPurchaseFinance/i);
  assert.match(updateText, /Draft changes were saved, but inventory was not received/i);
});

test("purchase pages fail closed on load errors and never present unknown storage as zero", () => {
  assert.match(purchaseDetailSource, /data: purchase, error: purchaseError/i);
  assert.match(purchaseDetailSource, /data: lines, error: linesError/i);
  assert.match(purchaseDetailSource, /data: movements, count: movementCount, error: movementsError/i);
  assert.match(purchaseDetailSource, /purchaseError[\s\S]*Could not load purchase[\s\S]*no missing purchase, empty items, or missing inventory history is being inferred/i);
  assert.match(purchaseDetailSource, /!lineItemsAvailable[\s\S]*Line items are unavailable[\s\S]*not treating this query failure as an empty purchase/i);
  assert.match(purchaseDetailSource, /!movementHistoryAvailable[\s\S]*Inventory movement history is unavailable[\s\S]*not reporting that movements were never created/i);
  assert.match(purchaseDetailSource, /!movementHistoryAvailable \? "Unavailable — history could not be verified" : hasReceiptMovements \? "Created" : "Not created"/i);

  for (const page of [newPurchasePageSource, editPurchasePageSource]) {
    assert.match(page, /currentStorageQty: storageError \? null : storageQtyByProduct\.get\(product\.id\) \?\? 0/i);
    assert.match(page, /Current storage quantities are unavailable[\s\S]*Storage: Unavailable instead of zero/i);
  }
  assert.match(purchaseFormSource, /currentStorageQty: number \| null/i);
  assert.match(purchaseFormSource, /currentStorageQty === null \? "Unavailable" : Number\(product\.currentStorageQty\)/i);
});

test("receipt review cannot create an orphan product before the atomic purchase RPC", () => {
  assert.doesNotMatch(actionSource, /from\("products"\)\s*\.insert/i);
  assert.match(actionSource, /lines\.some\(\(line\) => line\.matchAction === "create"\)[\s\S]*Create every new product from Products first/i);
  assert.match(purchaseFormSource, /<option value="create" disabled>Create in Products first<\/option>/i);
  assert.match(purchaseFormSource, /Create this product before saving the purchase/i);
  assert.match(purchaseFormSource, /href="\/products\/new\?returnTo=\/purchases\/new"/i);
  for (const actionName of ["createPurchase", "updatePurchase"]) {
    const body = functionText(actionName);
    assert.ok(body.indexOf("resolvePurchaseLines(lines)") > 0);
    assert.ok(body.indexOf("resolvePurchaseLines(lines)") < body.indexOf(".rpc("));
  }
});

test("direct purchase lifecycle DML and the legacy create command are closed", () => {
  const acl = compact(draftMigration);
  assert.match(acl, /revoke all on function public\.snacky_create_purchase_with_lines\([\s\S]*from public, anon, authenticated, service_role/i);
  for (const policy of [
    "snacky_purchase_orders_insert_by_effective_role",
    "snacky_purchase_orders_update_by_effective_role",
    "snacky_purchase_orders_delete_draft_by_effective_role",
    "snacky_purchase_order_lines_insert_by_effective_role",
    "snacky_purchase_order_lines_update_by_effective_role",
    "snacky_purchase_order_lines_delete_draft_by_effective_role",
  ]) {
    assert.match(draftMigration, new RegExp(`drop policy if exists "${policy}"`, "i"));
  }
  assert.match(acl, /revoke insert, update, delete on table public\.purchase_orders from authenticated/i);
  assert.match(acl, /revoke insert, update, delete on table public\.purchase_order_lines from authenticated/i);
  assert.match(acl, /grant select on table public\.purchase_orders to authenticated/i);
  assert.match(acl, /grant select on table public\.purchase_order_lines to authenticated/i);
});
