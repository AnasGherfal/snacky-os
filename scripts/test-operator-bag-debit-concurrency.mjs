import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = {
  migration: "supabase/migrations/20260905094000_operator_bag_debit_concurrency_guard.sql",
  terminalMigration: "supabase/migrations/20260905090000_route_terminal_inventory_reconciliation.sql",
  stopMigration: "supabase/migrations/20260905091000_route_stop_inventory_commit.sql",
};

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sqlFunctionBody(source, functionName) {
  const startPattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${escapeRegExp(functionName)}\\s*\\(`, "i");
  const start = source.search(startPattern);
  assert.notEqual(start, -1, `${functionName} must be defined`);
  const definition = source.slice(start);
  const body = definition.match(/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i);
  assert.ok(body, `${functionName} must use a dollar-quoted SQL body`);
  return compact(body[2]);
}

function topLevelSql(source) {
  return source.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "");
}

test("operator-bag changes use statement transition tables for deterministic multi-row locking", () => {
  const migration = compact(read(files.migration));

  assert.match(migration, /create trigger trg_snacky_operator_bag_balance_insert after insert on public\.inventory_movements referencing new table as new_rows for each statement/i);
  assert.match(migration, /create trigger trg_snacky_operator_bag_balance_update after update on public\.inventory_movements referencing old table as old_rows new table as new_rows for each statement/i);
  assert.match(migration, /create trigger trg_snacky_operator_bag_balance_delete after delete on public\.inventory_movements referencing old table as old_rows for each statement/i);
  assert.doesNotMatch(migration, /trg_snacky_operator_bag_balance_[\s\S]{0,160}for each row/i);

  const assertionBody = sqlFunctionBody(read(files.migration), "_snacky_assert_operator_bag_balance_changes");
  const custodyLock = assertionBody.indexOf("'snacky:operator-custody:'");
  const firstBagLock = assertionBody.indexOf("'snacky:operator-bag:'");
  const balanceRead = assertionBody.indexOf("from public.inventory_movements", firstBagLock);
  assert.ok(custodyLock >= 0 && firstBagLock > custodyLock && balanceRead > firstBagLock,
    "the complete sorted key set must be locked before any balance is read");
  assert.match(assertionBody.slice(0, custodyLock), /select distinct parsed\.bag_owner_id[\s\S]*order by parsed\.bag_owner_id/i);
  assert.match(assertionBody.slice(custodyLock, firstBagLock), /group by parsed\.bag_owner_id, parsed\.product_id[\s\S]*order by parsed\.bag_owner_id, parsed\.product_id/i);
  assert.doesNotMatch(assertionBody, /\blimit\b/i);
});

test("insert, update, and delete wrappers derive signed deltas from both bag endpoints", () => {
  const migration = read(files.migration);
  const insertBody = sqlFunctionBody(migration, "snacky_guard_operator_bag_balance_insert");
  const updateBody = sqlFunctionBody(migration, "snacky_guard_operator_bag_balance_update");
  const deleteBody = sqlFunctionBody(migration, "snacky_guard_operator_bag_balance_delete");

  assert.match(insertBody,
    /select inserted\.to_entity_id as bag_owner_id, inserted\.product_id, inserted\.quantity::bigint as delta_quantity from new_rows inserted[\s\S]*union all select inserted\.from_entity_id as bag_owner_id, inserted\.product_id, -inserted\.quantity::bigint as delta_quantity from new_rows inserted/i,
    "both INSERT endpoint UNION arms must expose exactly owner, product, and delta columns");
  assert.match(insertBody, /inserted\.to_entity_id as bag_owner_id[\s\S]*inserted\.quantity::bigint as delta_quantity[\s\S]*from new_rows inserted[\s\S]*inserted\.to_entity_type::text = 'operator_bag'/i);
  assert.match(insertBody, /inserted\.from_entity_id as bag_owner_id[\s\S]*-inserted\.quantity::bigint as delta_quantity[\s\S]*from new_rows inserted[\s\S]*inserted\.from_entity_type::text = 'operator_bag'/i);

  assert.match(updateBody, /updated\.to_entity_id as bag_owner_id[\s\S]*updated\.quantity::bigint as delta_quantity[\s\S]*from new_rows updated[\s\S]*updated\.to_entity_type::text = 'operator_bag'/i);
  assert.match(updateBody, /updated\.from_entity_id as bag_owner_id[\s\S]*-updated\.quantity::bigint as delta_quantity[\s\S]*from new_rows updated[\s\S]*updated\.from_entity_type::text = 'operator_bag'/i);
  assert.match(updateBody, /previous\.to_entity_id as bag_owner_id[\s\S]*-previous\.quantity::bigint as delta_quantity[\s\S]*from old_rows previous[\s\S]*previous\.to_entity_type::text = 'operator_bag'/i);
  assert.match(updateBody, /previous\.from_entity_id as bag_owner_id[\s\S]*previous\.quantity::bigint as delta_quantity[\s\S]*from old_rows previous[\s\S]*previous\.from_entity_type::text = 'operator_bag'/i);

  assert.match(deleteBody, /removed\.to_entity_id as bag_owner_id[\s\S]*-removed\.quantity::bigint as delta_quantity[\s\S]*from old_rows removed[\s\S]*removed\.to_entity_type::text = 'operator_bag'/i);
  assert.match(deleteBody, /removed\.from_entity_id as bag_owner_id[\s\S]*removed\.quantity::bigint as delta_quantity[\s\S]*from old_rows removed[\s\S]*removed\.from_entity_type::text = 'operator_bag'/i);

  for (const body of [insertBody, updateBody, deleteBody]) {
    assert.match(body, /group by legs\.bag_owner_id, legs\.product_id/i);
    assert.match(body, /having pg_catalog\.sum\(legs\.delta_quantity\) <> 0/i);
    assert.match(body, /_snacky_assert_operator_bag_balance_changes\(v_changes\)/i);
  }
});

test("the invariant blocks new negatives and worsening legacy negatives but permits improvements", () => {
  const body = sqlFunctionBody(read(files.migration), "_snacky_assert_operator_bag_balance_changes");

  assert.match(body, /sum\(legs\.quantity_delta\)/i);
  assert.match(body, /to_entity_type = 'operator_bag'::public\.inventory_entity_type[\s\S]*to_entity_id = v_change\.bag_owner_id/i);
  assert.match(body, /from_entity_type = 'operator_bag'::public\.inventory_entity_type[\s\S]*from_entity_id = v_change\.bag_owner_id/i);
  assert.match(body, /v_before_balance := v_after_balance - v_change\.delta_quantity/i);
  assert.match(body, /v_after_balance < \(case when v_before_balance < 0 then v_before_balance else 0::bigint end\)/i);
  assert.match(body, /errcode = '23514'/i);

  const rejected = (beforeBalance, delta) => {
    const afterBalance = beforeBalance + delta;
    return afterBalance < Math.min(beforeBalance, 0);
  };
  assert.equal(rejected(10, -11), true, "a healthy bag cannot cross below zero");
  assert.equal(rejected(10, -10), false, "a debit down to zero is valid");
  assert.equal(rejected(-5, -1), true, "legacy negative custody cannot be worsened");
  assert.equal(rejected(-5, 0), false, "an unchanged legacy negative is not made harder to repair");
  assert.equal(rejected(-5, 3), false, "a correction that improves a legacy negative is valid");

  const liveLegacyGlobal = -9;
  const pristineRouteReturn = 14;
  const lowerBoundAlignment = Math.max(-(liveLegacyGlobal - pristineRouteReturn), 0);
  const alignedBeforeDebit = liveLegacyGlobal + lowerBoundAlignment;
  assert.equal(lowerBoundAlignment, 23,
    "the audited pristine-return alignment must cover both legacy -9 and the exact 14-unit debit");
  assert.equal(rejected(alignedBeforeDebit, -pristineRouteReturn), false,
    "after +23 alignment, the canonical -14 return reaches zero without weakening the global guard");
});

test("lock namespace and order match route stop and terminal writers", () => {
  const migration = read(files.migration);
  const terminal = read(files.terminalMigration);
  const stop = read(files.stopMigration);
  const terminalBody = sqlFunctionBody(terminal, "snacky_finalize_route_inventory");
  const pickupReturnBody = sqlFunctionBody(terminal, "return_pickup_batch_to_assigned");
  const stopBody = sqlFunctionBody(stop, "snacky_commit_route_stop_inventory_v1");
  const lockNamespace = /'snacky:operator-bag:'\s*\|\|[\s\S]{0,160}bag_owner_id::text\s*\|\|\s*':'\s*\|\|[\s\S]{0,160}product_id::text/i;

  assert.match(migration, lockNamespace);
  assert.match(terminal, /order by involved\.bag_owner_id, involved\.product_id[\s\S]*'snacky:operator-bag:'/i);
  assert.match(stop, /order by products\.product_id[\s\S]*'snacky:operator-bag:'/i);
  assert.match(migration, /order by parsed\.bag_owner_id, parsed\.product_id[\s\S]*pg_catalog\.pg_advisory_xact_lock/i);

  for (const [writerName, body] of [
    ["terminal finalizer", terminalBody],
    ["pickup return", pickupReturnBody],
    ["stop commit", stopBody],
  ]) {
    const custodyLock = body.indexOf("'snacky:operator-custody:'");
    const bagLock = body.indexOf("'snacky:operator-bag:'");
    const firstMovementInsert = body.indexOf("insert into public.inventory_movements");
    assert.ok(custodyLock >= 0, `${writerName} must use the canonical custody lock namespace`);
    assert.ok(bagLock >= 0, `${writerName} must use the canonical bag lock namespace`);
    assert.ok(bagLock > custodyLock && firstMovementInsert > bagLock,
      `${writerName} must lock custody, then its complete sorted bag key set, before its first movement insert`);
  }
});

test("migration is internal, append-only, and contains no historical repair", () => {
  const migration = read(files.migration);
  const outsideFunctions = compact(topLevelSql(migration));

  assert.match(migration, /create index if not exists idx_inventory_movements_operator_bag_to_balance[\s\S]*on public\.inventory_movements \(to_entity_id, product_id\)[\s\S]*include \(quantity\)[\s\S]*where to_entity_type = 'operator_bag'::public\.inventory_entity_type/i);
  assert.match(migration, /create index if not exists idx_inventory_movements_operator_bag_from_balance[\s\S]*on public\.inventory_movements \(from_entity_id, product_id\)[\s\S]*include \(quantity\)[\s\S]*where from_entity_type = 'operator_bag'::public\.inventory_entity_type/i);

  for (const signature of [
    "_snacky_assert_operator_bag_balance_changes(jsonb)",
    "snacky_guard_operator_bag_balance_insert()",
    "snacky_guard_operator_bag_balance_update()",
    "snacky_guard_operator_bag_balance_delete()",
  ]) {
    const compactedSignature = signature.replace(/\s+/g, "");
    const revoke = compact(migration).split(";").find((statement) =>
      /revoke all on function/i.test(statement)
      && statement.replace(/\s+/g, "").includes(compactedSignature));
    assert.ok(revoke, `${signature} must have an explicit privilege revoke`);
    assert.match(revoke, /from public, anon, authenticated/i);
  }

  assert.equal((migration.match(/security definer/gi) ?? []).length, 4);
  assert.equal((migration.match(/set search_path = ''/gi) ?? []).length, 4);
  assert.doesNotMatch(migration, /\bdo\s+\$\$/i);
  assert.doesNotMatch(outsideFunctions, /\b(insert into|update|delete from)\s+public\.inventory_movements/i);
});
