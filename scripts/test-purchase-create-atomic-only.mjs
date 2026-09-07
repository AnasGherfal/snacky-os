import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/lib/purchase-actions.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const formSource = fs.readFileSync(path.join(root, "src/components/PurchaseForm.tsx"), "utf8");
const receiptSource = fs.readFileSync(path.join(root, "src/lib/purchase-receipts.ts"), "utf8");
const newPurchasePageSource = fs.readFileSync(path.join(root, "src/app/purchases/new/page.tsx"), "utf8");
const editPurchasePageSource = fs.readFileSync(path.join(root, "src/app/purchases/[id]/edit/page.tsx"), "utf8");
const purchaseDetailPageSource = fs.readFileSync(path.join(root, "src/app/purchases/[id]/page.tsx"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260906152716_purchase_create_idempotency_v2.sql"),
  "utf8",
);
const lifecycleMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260906153100_atomic_purchase_draft_lifecycle.sql"),
  "utf8",
);

function functionDeclaration(name) {
  return sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  ) ?? null;
}

function descendants(node, predicate) {
  const matches = [];
  function visit(current) {
    if (predicate(current)) matches.push(current);
    ts.forEachChild(current, visit);
  }
  visit(node);
  return matches;
}

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : ts.isIdentifier(node.expression)
      ? node.expression.text
      : null;
}

test("purchase creation has one atomic writer and no app-side fallback", () => {
  const createPurchase = functionDeclaration("createPurchase");
  assert.ok(createPurchase?.body, "createPurchase must exist");
  assert.equal(
    functionDeclaration("createPurchaseWithLinesFallback"),
    null,
    "the multi-request purchase/line/inventory fallback must not exist",
  );

  const calls = descendants(createPurchase.body, ts.isCallExpression);
  const atomicRpcCalls = calls.filter((call) => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "rpc") return false;
    return call.arguments[0]?.getText(sourceFile) === "PURCHASE_CREATE_RPC";
  });
  assert.equal(atomicRpcCalls.length, 1, "createPurchase must call the atomic purchase RPC exactly once");

  const forbiddenTables = new Set(["purchase_orders", "purchase_order_lines", "inventory_movements"]);
  const forbiddenWrites = calls.filter((call) => {
    const method = callName(call);
    if (!method || !["insert", "upsert", "delete"].includes(method)) return false;
    const callText = call.getText(sourceFile);
    return [...forbiddenTables].some((table) => callText.includes(`.from("${table}")`));
  });
  assert.deepEqual(
    forbiddenWrites.map((call) => call.getText(sourceFile)),
    [],
    "createPurchase must not write purchase, line, or inventory rows outside the atomic RPC",
  );
});

test("an RPC error or empty response fails closed before follow-up writes", () => {
  const createPurchase = functionDeclaration("createPurchase");
  assert.ok(createPurchase?.body, "createPurchase must exist");

  const failureGuard = descendants(createPurchase.body, ts.isIfStatement).find((statement) => {
    const condition = statement.expression.getText(sourceFile).replace(/\s+/g, "");
    return condition === "purchaseError||!purchase";
  });
  assert.ok(failureGuard, "purchase RPC errors and empty results must share one fail-closed guard");

  const guardCalls = descendants(failureGuard.thenStatement, ts.isCallExpression);
  assert.ok(guardCalls.some((call) => callName(call) === "logPurchaseSaveFailure"), "the atomic failure must be logged");
  const formErrorCall = guardCalls.find((call) => callName(call) === "formError");
  assert.equal(formErrorCall?.arguments[0]?.getText(sourceFile), "PURCHASE_SAVE_ADMIN_MESSAGE");
  assert.equal(
    descendants(failureGuard.thenStatement, ts.isTryStatement).length,
    0,
    "the RPC failure path must not attempt another writer",
  );

  const createText = createPurchase.getText(sourceFile);
  assert.equal(createText.includes("createPurchaseWithLinesFallback"), false);
  assert.match(source, /function formError\(message: string\): never/);
});

test("purchase creation does not invent a finance payment", () => {
  const createPurchase = functionDeclaration("createPurchase");
  assert.ok(createPurchase?.body, "createPurchase must exist");
  const createText = createPurchase.getText(sourceFile);

  assert.doesNotMatch(createText, /syncPurchaseFinanceSafely|createPurchaseFinancialTransaction/);
  assert.doesNotMatch(createText, /financeSync|financeNeedsRepair|financeWarning/);
  assert.match(formSource, /Payment status is derived only from actual supplier payments/);
  assert.match(formSource, /paymentStatus:\s*"unpaid"/);
  assert.match(formSource, /type="hidden" name="payment_status" value="unpaid"/);
  assert.doesNotMatch(formSource, /<option value="(?:partially_paid|paid)">/);
  assert.match(formSource, /initialPurchase\?\.id \? \([\s\S]*type="hidden" name="payment_account_id"/);
  assert.match(formSource, /change this when recording the actual supplier payment/);
  assert.doesNotMatch(
    source,
    /createPurchaseFinancialTransaction|syncPurchaseFinanceSafely|syncPurchaseFinanceBestEffort|getDefaultStorageId/,
    "purchase lifecycle actions must not invent aggregate finance rows or guess an implicit storage destination",
  );
});

test("purchase creation uses a caller-stable submission UUID", () => {
  const createPurchase = functionDeclaration("createPurchase");
  assert.ok(createPurchase?.body, "createPurchase must exist");
  const createText = createPurchase.getText(sourceFile);

  assert.match(source, /const PURCHASE_CREATE_RPC = "snacky_create_purchase_with_lines_v2"/);
  assert.match(createText, /fd\.get\("client_submission_id"\)/);
  assert.match(createText, /p_client_submission_id:\s*clientSubmissionId/);
  assert.doesNotMatch(
    createText,
    /clientSubmissionId[\s\S]{0,120}(?:randomUUID|Date\.now|Math\.random)/,
    "the server action must reject a missing command id instead of inventing a different one on retry",
  );
  assert.doesNotMatch(createText, /p_created_by\s*:/, "the v2 RPC derives its actor from auth.uid()");
  assert.match(createText, /p_payment_account_id:\s*paymentAccountId/);
  assert.match(createText, /p_receiving_storage_location_id:\s*receivingStorageLocationId \|\| null/);

  assert.match(formSource, /clientSubmissionId:\s*string/);
  assert.match(formSource, /name="client_submission_id"\s+value=\{clientSubmissionId\}/);
  assert.match(formSource, /formData\.set\("client_submission_id",\s*clientSubmissionId\)/);
  assert.match(formSource, /localPurchaseDraft[\s\S]*clientSubmissionId/);
  assert.match(formSource, /setClientSubmissionId\(draft\.clientSubmissionId\)/);

  assert.match(receiptSource, /fd\.get\("client_submission_id"\)/);
  assert.match(receiptSource, /const path = `\$\{receiptNumber\}-\$\{stableSuffix\}\.\$\{extension\}`/);
});

test("purchase receiving requires a reviewed physical storage destination", () => {
  const createPurchase = functionDeclaration("createPurchase");
  assert.ok(createPurchase?.body, "createPurchase must exist");
  const createText = createPurchase.getText(sourceFile);

  assert.match(createText, /fd\.get\("receiving_storage_location_id"\)/);
  assert.match(createText, /submitAction === "received" && !receivingStorageLocationId/);
  assert.match(formSource, /storageLocations\.some\(\(location\) => location\.id === details\.receivingStorageLocationId\)/);
  assert.match(formSource, /name="receiving_storage_location_id"/);
  assert.match(formSource, /Receiving storage \/ مخزن الاستلام/);
  assert.match(formSource, /storageLocations\.length === 1 \? storageLocations\[0\]\.id : ""/);
  assert.match(formSource, /formData\.set\("receiving_storage_location_id", details\.receivingStorageLocationId\)/);

  for (const pageSource of [newPurchasePageSource, editPurchasePageSource, purchaseDetailPageSource]) {
    assert.match(pageSource, /\.from\("storage_locations"\)/);
    assert.match(pageSource, /\["main_storage", "vehicle", "temporary", "other"\]/);
  }
  assert.match(purchaseDetailPageSource, /name="receiving_storage_location_id"/);
  assert.match(purchaseDetailPageSource, /required/);
  assert.match(purchaseDetailPageSource, /Receiving is locked until an active physical storage location loads/);

  assert.match(migration, /add column if not exists receiving_storage_location_id uuid[\s\S]*references public\.storage_locations\(id\) on delete restrict/i);
  const functionStart = migration.indexOf("create or replace function public.snacky_create_purchase_with_lines_v2(");
  const functionEnd = migration.indexOf("$function$;", functionStart);
  const functionBody = migration.slice(functionStart, functionEnd);
  assert.match(functionBody, /p_receiving_storage_location_id uuid/);
  assert.match(functionBody, /'receiving_storage_location_id', v_storage_id/);
  assert.match(functionBody, /v_submit_action = 'received' and v_storage_id is null/);
  assert.match(functionBody, /storage\.id = v_storage_id[\s\S]*storage\.active = true[\s\S]*storage\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\)[\s\S]*for share/i);
  assert.match(functionBody, /insert into public\.purchase_orders \([\s\S]*receiving_storage_location_id/i);
  assert.doesNotMatch(functionBody, /order by storage\.name/i, "create-v2 must never choose the first storage implicitly");

  const storageLock = functionBody.indexOf("pg_catalog.pg_advisory_xact_lock(");
  const productRowLock = functionBody.indexOf("perform product.id", storageLock);
  assert.ok(storageLock >= 0 && productRowLock > storageLock, "canonical storage/product advisory locks must precede product row locks");
  assert.match(functionBody, /select distinct[\s\S]*v_storage_id as storage_location_id,[\s\S]*line\.product_id[\s\S]*order by storage_location_id, line\.product_id[\s\S]*pg_catalog\.hashtext\(v_storage_lock\.product_id::text\),[\s\S]*pg_catalog\.hashtext\(v_storage_lock\.storage_location_id::text\)/i);
  assert.match(functionBody, /priced_lines as \([\s\S]*round\(case[\s\S]*raw_line_total \/ normalized_lines\.total_units[\s\S]*end, 4\) as unit_cost/i);
  assert.match(functionBody, /canonical_lines as \([\s\S]*round\(priced_lines\.unit_cost \* priced_lines\.total_units, 2\) as line_total/i);
  assert.doesNotMatch(functionBody, /then normalized_lines\.raw_line_total[\s\S]*end, 2\) as line_total/i,
    "the persisted total must be recomputed from the final four-decimal unit cost");
});

test("draft update and cancellation are atomic RPC-only commands with no hard delete", () => {
  const updatePurchase = functionDeclaration("updatePurchase");
  const cancelPurchase = functionDeclaration("cancelPurchase");
  const receivePurchase = functionDeclaration("receivePurchase");
  assert.ok(updatePurchase?.body, "updatePurchase must exist");
  assert.ok(cancelPurchase?.body, "cancelPurchase must exist");
  assert.ok(receivePurchase?.body, "receivePurchase must exist");
  assert.equal(functionDeclaration("deleteDraftPurchase"), null, "hard-delete must not remain an app action");

  const updateText = updatePurchase.getText(sourceFile);
  const cancelText = cancelPurchase.getText(sourceFile);
  const receiveText = receivePurchase.getText(sourceFile);
  assert.match(updateText, /supabase\.rpc\("snacky_update_draft_purchase_v1"/);
  assert.match(updateText, /p_client_submission_id:\s*clientSubmissionId/);
  assert.match(updateText, /p_receiving_storage_location_id:\s*receivingStorageLocationId \|\| null/);
  assert.doesNotMatch(updateText, /p_payment_status|p_payment_account_id|payment_status\s*:|payment_account_id\s*:/);
  assert.match(cancelText, /supabase\.rpc\("snacky_cancel_draft_purchase_v1"/);
  assert.match(cancelText, /p_client_submission_id:\s*clientSubmissionId/);
  assert.match(receiveText, /fd\.get\("receiving_storage_location_id"\)/);
  assert.match(receiveText, /fd\.get\("client_submission_id"\)/);
  assert.match(receiveText, /receivePurchaseById\(id, receivingStorageLocationId, clientSubmissionId\)/);

  for (const [name, declaration] of [["updatePurchase", updatePurchase], ["cancelPurchase", cancelPurchase]]) {
    const calls = descendants(declaration.body, ts.isCallExpression);
    const directLifecycleWrites = calls.filter((call) => {
      const method = callName(call);
      if (!method || !["insert", "upsert", "update", "delete"].includes(method)) return false;
      const callText = call.getText(sourceFile);
      return ["purchase_orders", "purchase_order_lines", "inventory_movements", "financial_transactions"]
        .some((table) => callText.includes(`.from("${table}")`));
    });
    assert.deepEqual(
      directLifecycleWrites.map((call) => call.getText(sourceFile)),
      [],
      `${name} must not mutate purchase, inventory, or finance tables outside its atomic RPC`,
    );
  }

  assert.doesNotMatch(purchaseDetailPageSource, /deleteDraftPurchase|Delete draft/);
  assert.match(purchaseDetailPageSource, /isAdminRole\(profile\)/);
  assert.match(purchaseDetailPageSource, /derivedPaymentStatus === "unpaid"/);
  assert.match(purchaseDetailPageSource, /record its refund or correction first/);
  assert.match(purchaseDetailPageSource, /<PurchaseOperationForm[\s\S]*operation="receive"/);
  assert.match(purchaseDetailPageSource, /<PersistentPurchaseConfirmDialog[\s\S]*operation="cancel"/);
  assert.match(purchaseDetailPageSource, /confirmedSubmissionId=\{purchaseReceived\}/);
  assert.match(purchaseDetailPageSource, /confirmedSubmissionId=\{purchaseCancelled\}/);
  assert.doesNotMatch(purchaseDetailPageSource, /client_submission_id[\s\S]*crypto\.randomUUID\(\)/);

  assert.match(lifecycleMigration, /create or replace function public\.snacky_update_draft_purchase_v1\(/i);
  assert.match(lifecycleMigration, /create or replace function public\.snacky_cancel_draft_purchase_v1\(/i);
  assert.match(lifecycleMigration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(lifecycleMigration, /receiving_storage_location_id = p_receiving_storage_location_id/i);
  assert.match(lifecycleMigration, /delete from public\.purchase_order_lines/i);
  assert.match(lifecycleMigration, /update public\.purchase_orders purchase/i);
  assert.match(formSource, /name="expected_updated_at" value=\{initialPurchase\.updatedAt \?\? ""\}/);
  assert.match(editPurchasePageSource, /updatedAt: \(purchase as any\)\.updated_at/);
});

test("the v2 RPC binds one immutable request to one exact result", () => {
  const createPurchase = functionDeclaration("createPurchase");
  assert.ok(createPurchase?.body, "createPurchase must exist");
  const createText = createPurchase.getText(sourceFile);

  assert.match(
    migration,
    /create table if not exists public\.purchase_create_submissions[\s\S]*client_submission_id uuid primary key/i,
  );
  assert.match(migration, /request_payload jsonb not null[\s\S]*result_payload jsonb/i);
  assert.match(migration, /purchase_id uuid unique references public\.purchase_orders\(id\) on delete restrict/i);
  assert.match(migration, /alter table public\.purchase_create_submissions enable row level security/i);
  assert.match(
    migration,
    /revoke all on table public\.purchase_create_submissions[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(migration, /completed purchase creation results are immutable/i);

  const functionStart = migration.indexOf("create or replace function public.snacky_create_purchase_with_lines_v2(");
  const functionEnd = migration.indexOf("$function$;", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart, "the v2 purchase RPC must exist");
  const functionBody = migration.slice(functionStart, functionEnd);

  assert.match(functionBody, /p_client_submission_id uuid/);
  assert.doesNotMatch(functionBody, /p_created_by/i);
  assert.match(functionBody, /security definer[\s\S]*set search_path = ''/i);
  assert.match(functionBody, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(functionBody, /v_actor_team_member_id := public\.snacky_current_team_member_id\(\)/i);
  assert.match(functionBody, /'payment_account_id', v_payment_account_id[\s\S]*'lines', v_lines/i);
  assert.match(functionBody, /v_payment_status <> 'unpaid'/i);
  assert.match(createText, /if \(paymentStatus !== "unpaid"\)/);
  assert.match(functionBody, /v_submit_action = 'received' and p_supplier_id is null/i);
  assert.match(functionBody, /from public\.suppliers supplier[\s\S]*for share/i);
  assert.match(functionBody, /with parsed_lines as[\s\S]*canonical_lines as/i);
  assert.match(functionBody, /when normalized_lines\.raw_line_total > 0 and normalized_lines\.total_units > 0[\s\S]*then normalized_lines\.raw_line_total \/ normalized_lines\.total_units/i);
  assert.match(functionBody, /pg_catalog\.round\(case[\s\S]*else normalized_lines\.raw_unit_cost[\s\S]*end, 4\) as unit_cost/i);
  assert.match(functionBody, /pg_catalog\.round\(priced_lines\.unit_cost \* priced_lines\.total_units, 2\) as line_total/i,
    "persisted line totals must be recomputed from the final four-decimal unit cost");
  assert.match(functionBody, /pg_catalog\.round\(coalesce\(pg_catalog\.sum\(canonical_lines\.line_total\), 0\), 2\)[\s\S]*v_calculated_total_lyd/i);
  assert.match(functionBody, /'lines', v_lines/i, "the immutable request must store canonical lines");
  assert.match(functionBody, /'canonical_lines', v_lines/i, "the immutable result must retain canonical lines");
  const executableBody = functionBody.slice(functionBody.indexOf("begin"));
  assert.doesNotMatch(
    executableBody,
    /p_calculated_total_lyd|p_total_adjustment_lyd|p_total_source|p_total_amount/,
    "the database must ignore caller-computed header totals and derive them from canonical lines",
  );

  const commandInsert = functionBody.indexOf("insert into public.purchase_create_submissions");
  const receivedPositiveTotalGuard = functionBody.indexOf("v_submit_action = 'received' and v_total_amount <= 0");
  const commandLock = functionBody.indexOf("for update;", commandInsert);
  const payloadCheck = functionBody.indexOf("request_payload is distinct from v_request_payload", commandLock);
  const replayReturn = functionBody.indexOf("return query", payloadCheck);
  const productLock = functionBody.indexOf("for update of product", replayReturn);
  const activeProductCheck = functionBody.indexOf("product.active is distinct from true", productLock);
  const purchaseInsert = functionBody.indexOf("insert into public.purchase_orders", replayReturn);
  assert.ok(receivedPositiveTotalGuard >= 0 && commandInsert > receivedPositiveTotalGuard,
    "zero-cost received stock must fail before the command receipt or any purchase/inventory effect");
  assert.ok(commandInsert >= 0, "the command receipt must be inserted first");
  assert.ok(commandLock > commandInsert, "concurrent retries must serialize on the command receipt");
  assert.ok(payloadCheck > commandLock, "the immutable payload must be checked after locking");
  assert.ok(replayReturn > payloadCheck, "an exact retry must return its stored result");
  assert.ok(productLock > replayReturn && activeProductCheck > productLock,
    "all referenced product rows must be locked before active/missing validation");
  assert.ok(purchaseInsert > activeProductCheck,
    "an inactive or missing purchase product must fail before parent, line, or receipt effects");
  assert.ok(purchaseInsert > replayReturn, "the replay return must happen before any new purchase write");

  const validatesCanonicalProducts = (requestedIds, products) => requestedIds.every((id) => products.get(id) === true);
  assert.equal(validatesCanonicalProducts(["active"], new Map([["active", true]])), true);
  assert.equal(validatesCanonicalProducts(["inactive"], new Map([["inactive", false]])), false);
  assert.equal(validatesCanonicalProducts(["missing"], new Map()), false);
  const canSubmitPurchase = ({ action, total }) => action !== "received" || total > 0;
  assert.equal(canSubmitPurchase({ action: "draft", total: 0 }), true);
  assert.equal(canSubmitPurchase({ action: "received", total: 0 }), false);
  assert.equal(canSubmitPurchase({ action: "received", total: 0.01 }), true);

  assert.match(functionBody, /result_payload is not null[\s\S]*return query/i);
  assert.match(functionBody, /set[\s\S]*purchase_id = v_purchase_id,[\s\S]*result_payload = v_result_payload/i);
  assert.match(functionBody, /source_type[\s\S]*'purchase_receipt'/i);
  assert.match(functionBody, /idempotency_key[\s\S]*'purchase-receipt:v1:'/i);
  assert.match(functionBody, /'contract_version', 1,[\s\S]*'purchase_line_id', line\.id,[\s\S]*'product_id', line\.product_id,[\s\S]*'storage_location_id', v_storage_id,[\s\S]*'quantity', line\.total_units/i);
  assert.match(
    migration,
    /revoke all on function public\.snacky_create_purchase_with_lines\([\s\S]*from public, anon, authenticated, service_role/i,
    "the legacy non-idempotent RPC must no longer be an authenticated write path",
  );
  assert.match(
    migration,
    /grant execute on function public\.snacky_create_purchase_with_lines_v2\([\s\S]*to authenticated/i,
  );
});
