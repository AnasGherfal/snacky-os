import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  confirmedFinanceCreateOperationId,
  financeCreateOperationStorageKey,
  isFinanceOperationId,
  resolveFinanceCreateOperationId,
} from "../src/lib/finance-operation-id.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = read("supabase/migrations/20260906155800_atomic_manual_finance_create.sql");
const actions = read("src/lib/finance-actions.ts");
const newPage = read("src/app/finance/transactions/new/page.tsx");
const editPage = read("src/app/finance/transactions/[id]/edit/page.tsx");
const component = read("src/components/FinanceTransactionCreateForm.tsx");
const writeClient = read("src/lib/finance-write-client.ts");

function functionBody(name, nextPattern) {
  const match = migration.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?(?=${nextPattern})`, "i"));
  assert.ok(match, `${name} function must exist`);
  return match[0];
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const createCommand = functionBody(
  "snacky_create_manual_finance_transaction_v1",
  "revoke all on function public\\.snacky_create_manual_finance_transaction_v1",
);

test("manual finance command owns an actor-bound immutable receipt and exact replay", () => {
  assert.match(migration, /create table if not exists public\.manual_finance_create_submissions/i);
  assert.match(migration, /client_submission_id uuid primary key/i);
  assert.match(migration, /actor_user_id uuid not null references auth\.users/i);
  assert.match(migration, /actor_team_member_id uuid not null references public\.team_members/i);
  assert.match(migration, /financial_transaction_id uuid unique[\s\S]*references public\.financial_transactions\(id\) on delete restrict/i);
  assert.match(migration, /enable always trigger snacky_manual_finance_create_submissions_immutable/i);
  assert.match(migration, /revoke all on table public\.manual_finance_create_submissions[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(createCommand, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(createCommand, /array\['owner', 'admin', 'supervisor', 'finance'\]/i);
  assert.match(createCommand, /request_payload is distinct from v_request_payload/i);
  assert.match(createCommand, /belongs to another actor or immutable request/i);
  assert.match(createCommand, /from public\.financial_transactions finance[\s\S]*where finance\.id = v_submission\.financial_transaction_id[\s\S]*for update/i);
  assert.match(createCommand, /source_type is distinct from 'manual'/i);
  assert.match(createCommand, /source_id is distinct from p_client_submission_id/i);
  assert.match(createCommand, /metadata ->> 'client_submission_id' is distinct from p_client_submission_id::text/i);
  assert.match(createCommand, /created_by is distinct from v_actor_team_member_id/i);
  assert.match(createCommand, /saved manual finance identity no longer matches the finance ledger/i);
  assert.match(createCommand, /return pg_catalog\.jsonb_populate_record\([\s\S]*v_submission\.result_payload/i);
});

test("receipt serialization precedes every category or ledger effect", () => {
  const receiptInsert = createCommand.indexOf("insert into public.manual_finance_create_submissions");
  const receiptLock = createCommand.indexOf("from public.manual_finance_create_submissions submission", receiptInsert);
  const categoryInsert = createCommand.indexOf("insert into public.finance_categories", receiptLock);
  const ledgerInsert = createCommand.indexOf("insert into public.financial_transactions", categoryInsert);
  const completion = createCommand.indexOf("update public.manual_finance_create_submissions", ledgerInsert);
  assert.ok(receiptInsert > 0 && receiptInsert < receiptLock && receiptLock < categoryInsert && categoryInsert < ledgerInsert && ledgerInsert < completion);
  assert.match(createCommand.slice(receiptInsert, receiptLock), /on conflict \(client_submission_id\) do nothing/i);
  assert.match(createCommand.slice(receiptLock, categoryInsert), /for update/i);
  assert.match(createCommand, /v_amount::text in \('NaN', 'Infinity', '-Infinity'\)[\s\S]*v_amount <= 0/i);
  assert.match(createCommand, /source_type,[\s\S]*'manual'/i);
  assert.match(createCommand, /source_id,[\s\S]*p_client_submission_id/i);
  assert.match(createCommand, /related_purchase_id,[\s\S]*linked_purchase_id,[\s\S]*null,[\s\S]*null/i);
});

test("authenticated users cannot mutate the finance table directly", () => {
  assert.match(migration, /drop policy if exists "financial_transactions_insert_finance_roles"/i);
  assert.match(migration, /drop policy if exists "financial_transactions_update_finance_roles"/i);
  assert.match(migration, /revoke insert, update, delete on table public\.financial_transactions[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant insert, update, delete on table public\.financial_transactions[\s\S]*to service_role/i);
  assert.match(migration, /grant execute on function public\.snacky_create_manual_finance_transaction_v1[\s\S]*to authenticated/i);
});

test("manual finance UI uses the command and cannot create or edit a purchase link", () => {
  assert.match(actions, /\.rpc\("snacky_create_manual_finance_transaction_v1"/i);
  assert.match(actions, /p_client_submission_id: clientSubmissionId/i);
  assert.match(actions, /idempotencyKey: `manual-finance-create:v1:\$\{clientSubmissionId\}`/i);
  assert.match(actions, /Supplier%20payments%20must%20be%20recorded%20from%20the%20purchase%20payment%20history/i);
  assert.doesNotMatch(newPage, /name="related_purchase_id"/i);
  assert.doesNotMatch(editPage, /name="related_purchase_id"/i);
});

test("browser operation id persists through errors and rotates only after exact success", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  assert.equal(isFinanceOperationId(first), true);
  assert.equal(financeCreateOperationStorageKey("user-a"), "snacky:finance-operation:v1:user-a:create");
  assert.equal(resolveFinanceCreateOperationId({ storedId: first, initialId: second, createId: () => second }), first);
  assert.equal(resolveFinanceCreateOperationId({ storedId: "bad", initialId: second, createId: () => first }), second);

  const success = { digest: `NEXT_REDIRECT;replace;/finance/transactions/tx?created=1&finance_submission_id=${first};303;` };
  const failure = { digest: `NEXT_REDIRECT;replace;/finance/transactions/new?error=no&finance_submission_id=${first};303;` };
  assert.equal(confirmedFinanceCreateOperationId(success), first);
  assert.equal(confirmedFinanceCreateOperationId(failure), "");
  assert.match(component, /window\.localStorage\.getItem\(storageKey\)/i);
  assert.match(component, /confirmedId && confirmedId === submissionId/i);
  assert.match(component, /window\.localStorage\.setItem\(storageKey, replacement\)/i);
  assert.match(component, /<fieldset disabled=\{!ready\}/i);
});

test("only enumerated server workflows use the service finance writer", () => {
  assert.match(writeClient, /const client = getSupabaseAdminClient\(\)/i);
  assert.match(writeClient, /if \(!client\)[\s\S]*throw new Error/i);
  assert.doesNotMatch(writeClient, /\?\?/);

  const expectedFiles = new Set([
    "src/lib/cash-actions.ts",
    "src/lib/finance-actions.ts",
    "src/lib/payroll-actions.ts",
    "src/lib/payroll-v2-actions.ts",
  ]);
  const actualFiles = new Set();
  const violations = [];
  const mutationPattern = /([A-Za-z][A-Za-z0-9_]*)\s*\.from\(["']financial_transactions["']\)\s*\.\s*(insert|update|upsert|delete)\s*\(/g;

  for (const absolutePath of sourceFiles(path.join(root, "src"))) {
    const source = fs.readFileSync(absolutePath, "utf8");
    const relativePath = path.relative(root, absolutePath);
    for (const match of source.matchAll(mutationPattern)) {
      actualFiles.add(relativePath);
      if (match[1] !== "financeWriteSupabase") {
        violations.push(`${relativePath}: ${match[1]}.${match[2]}`);
      }
    }
  }

  assert.deepEqual(violations, []);
  assert.deepEqual([...actualFiles].sort(), [...expectedFiles].sort());
  for (const relativePath of expectedFiles) {
    assert.match(read(relativePath), /getRequiredFinanceWriteClient/i);
  }
});
