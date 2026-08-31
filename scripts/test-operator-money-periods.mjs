import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const migration = read(
  "supabase/migrations/20260831170000_operator_money_periods.sql",
);
const xyRepair = read(
  "supabase/migrations/20260831171000_xy_minor_unit_price_repair.sql",
);
const api = read("src/app/api/operator-money/route.ts");
const ui = read("src/app/operator-money/OperatorMoneyLedgerClient.tsx");
const teamMoneyPage = read("src/app/team/[id]/money/page.tsx");
const teamProfilePage = read("src/app/team/[id]/page.tsx");

test("operator money is organized into auditable Libya-month periods", () => {
  assert.match(migration, /create table public\.operator_money_periods/i);
  assert.match(migration, /period_start date not null/i);
  assert.match(migration, /period_end date not null/i);
  assert.match(migration, /Africa\/Tripoli/i);
  assert.match(migration, /lifecycle_status[\s\S]*'open'[\s\S]*'closed'/i);
  assert.match(migration, /settled_at timestamptz/i);
  assert.match(migration, /operator_money_periods_one_open_per_person_idx/i);
});

test("every operator-money ledger row belongs to exactly one period", () => {
  for (const table of [
    "operator_personal_purchases",
    "operator_debt_payments",
    "operator_advances",
    "operator_expenses",
    "operator_advance_returns",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `alter table public\\.${table} add column period_id uuid[\\s\\S]{0,160}operator_money_periods`,
        "i",
      ),
    );
    assert.match(
      migration,
      new RegExp(
        `alter table public\\.${table} alter column period_id set not null`,
        "i",
      ),
    );
  }
});

test("personal debt and Snacky work money remain separate and itemized", () => {
  assert.match(migration, /operator_debt_payment_allocations/i);
  assert.match(migration, /operator_personal_purchase_status/i);
  assert.match(migration, /paid_amount_lyd/i);
  assert.match(migration, /remaining_amount_lyd/i);
  assert.match(migration, /payment_status/i);
  assert.match(migration, /operator_expense_reimbursements/i);
  assert.match(migration, /operator_reimbursement_due_lyd/i);
  assert.match(migration, /operator_money_period_summary/i);
});

test("period lifecycle is explicit, authorized, and auditable", () => {
  assert.match(migration, /close_operator_money_period/i);
  assert.match(migration, /settle_operator_money_period/i);
  assert.match(migration, /reopen_operator_money_period/i);
  assert.match(migration, /Only owner\/admin can close a money period/i);
  assert.match(migration, /Only owner\/admin can settle a money period/i);
  assert.match(migration, /Only owner\/admin can reopen a money period/i);
  assert.match(migration, /operator_money_period_events/i);
  assert.match(migration, /closing_snapshot jsonb/i);
});

test("personal items use the canonical database price and stay stock-safe", () => {
  const purchaseFunction =
    migration.match(
      /create or replace function public\.create_operator_personal_purchase[\s\S]*?(?=create or replace function|$)/i,
    )?.[0] ?? "";

  assert.match(
    purchaseFunction,
    /select coalesce\(current_selling_price_lyd,selling_price,0\) into price/i,
  );
  assert.match(
    purchaseFunction,
    /Not enough genuinely available storage stock after route reservations/i,
  );
  assert.match(
    purchaseFunction,
    /p_person_id,v_period_id,p_product_id,p_storage_location_id,p_quantity,price/i,
  );
  assert.doesNotMatch(
    purchaseFunction,
    /p_person_id,v_period_id,p_product_id,p_storage_location_id,p_quantity,p_unit_price_lyd/i,
  );
});

test("the XY minor-unit repair is evidence-based and auditable", () => {
  assert.match(xyRepair, /spjg\/spjj in minor units/i);
  assert.match(xyRepair, /raw_selling\/100/i);
  assert.match(xyRepair, /raw_cost\/100/i);
  assert.match(xyRepair, /operator_personal_purchase_corrections/i);
  assert.match(xyRepair, /vms_sync_runs[\s\S]*provider='xy'/i);
  assert.match(xyRepair, /selling_price_source='vms'/i);
});

test("the API and UI support manager entries and period settlement actions", () => {
  assert.match(api, /periodId/i);
  assert.match(api, /p_unit_price_lyd:\s*null/i);
  assert.match(api, /periodEvents/i);
  assert.match(api, /action === "reimbursement"/i);
  assert.match(api, /closePeriod/i);
  assert.match(api, /reopenPeriod/i);
  assert.match(api, /settlePeriod/i);

  for (const label of [
    "Operator Money",
    "Personal purchases",
    "Snacky work money",
    "Money period",
    "Add personal item",
    "Record personal payment",
    "Close period",
    "Reopen period",
    "Mark period settled",
  ]) {
    assert.match(ui, new RegExp(label, "i"));
  }
  assert.match(ui, /reimbursement/i);
  assert.match(ui, /toISOString\(\)/);
});

test("team money has a dedicated owner-or-self authorized page", () => {
  assert.match(teamMoneyPage, /isOwnerAdminRole\(profile\)/);
  assert.match(teamMoneyPage, /profile\.team_member_id === id/);
  assert.match(teamMoneyPage, /if \(!manager && !viewingSelf\)/);
  assert.match(teamMoneyPage, /OperatorMoneyLedgerClient/);
  assert.match(teamMoneyPage, /initialPersonId=\{id\}/);
  assert.match(teamMoneyPage, /lockPerson/);
  assert.match(teamMoneyPage, /selfServiceOnly=\{viewingSelf && !manager\}/);

  assert.match(teamProfilePage, /href=\{\`\/team\/\$\{id\}\/money\`\}/);
  assert.doesNotMatch(teamProfilePage, /OperatorMoneyLedgerClient/);
});
