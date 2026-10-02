import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migrationPath = "supabase/migrations/202608040001_operator_instructions.sql";
const apiPath = "src/app/api/operator-instructions/route.ts";
const panelPath = "src/components/operator/OperatorInstructionsPanel.tsx";
const routesPath = "src/app/operator/routes/page.tsx";
const profilePath = "src/app/team/[id]/page.tsx";

test("operator instructions ledger is append-only, scoped, and idempotent", () => {
  const sql = read(migrationPath);
  assert.match(sql, /create table if not exists public\.operator_instructions/);
  assert.match(sql, /client_submission_id text not null unique/);
  assert.match(sql, /where client_submission_id = v_submission_id/);
  assert.match(sql, /operator_id = public\.snacky_current_team_member_id\(\)/);
  assert.match(sql, /Only owner\/admin can assign operator instructions/);
  assert.match(sql, /Operators can read only their own|You can only update your own instructions|operator_instructions_read/i);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete)[^;]*operator_instructions\s+to\s+authenticated/i);
});
test("price change updates the product and creates an operator task atomically", () => {
  const sql = read(migrationPath);
  assert.match(sql, /v_type = 'price_change'/);
  assert.match(sql, /for update/);
  assert.match(sql, /update public\.products/);
  assert.match(sql, /current_selling_price_lyd = round\(p_requested_selling_price_lyd, 2\)/);
  assert.match(sql, /selling_price_source = 'manual'/);
  assert.match(sql, /previous_selling_price_lyd/);
  assert.match(sql, /requested_selling_price_lyd/);
  assert.match(sql, /v_requires_completion := true/);
});
test("normalized operator actions preserve acknowledgement/completion and manager-only cancellation", () => {
  const sql = read(migrationPath);
  assert.match(sql, /v_action text := lower\(trim\(coalesce\(p_action, ''\)\)\)/);
  for (const action of ['acknowledge','complete','cancel']) assert.match(sql,new RegExp(`v_action = '${action}'`));
  assert.match(sql, /Only owner\/admin can cancel instructions/);
  assert.match(sql, /completion_note = v_note/);
  assert.match(sql, /Completed instruction cannot be cancelled/);
});
test("instructions reuse the existing in-app notification system", () => {
  const sql = read(migrationPath);
  assert.match(sql, /to_regclass\('public\.notifications'\)/);
  assert.match(sql, /insert into public\.notifications/);
  assert.match(sql, /\/operator\/routes#operator-instructions/);
  assert.match(sql, /operator_instruction_completed/);
});
test("API enforces permissions, setup diagnostics, and self-only actions", () => {
  const source = read(apiPath);
  assert.match(source, /isOwnerAdminRole/);
  assert.match(source, /You can only view your own instructions/);
  assert.match(source, /Only owner\/admin can assign instructions/);
  assert.match(source, /Only owner\/admin can cancel instructions/);
  assert.match(source, /create_operator_instruction/);
  assert.match(source, /advance_operator_instruction/);
  assert.match(source, /setupRequired: true/);
  assert.match(source, /202608040001_operator_instructions\.sql/);
  assert.match(source, /revalidatePath\("\/products"\)/);
});
test("UI supports tasks, notes, price search, Arabic, and completion", () => {
  const source = read(panelPath);
  for(const label of ['Instructions & tasks','التعليمات والمهام','Price change','تغيير سعر','Search by product, brand, or category','ابحث باسم المنتج أو العلامة أو التصنيف','Current selling price','New selling price','Mark completed','تأكيد التنفيذ','acknowledge','complete'])assert.ok(source.includes(label),label);
  assert.doesNotMatch(source, /WhatsApp|whatsapp/i);
});
test("daily routes and permanent operator profile render the same anchored instruction ledger", () => {
  const routes = read(routesPath), profile = read(profilePath), panel = read(panelPath);
  assert.match(routes, /OperatorInstructionsPanel/);
  assert.match(panel, /id="operator-instructions"/);
  assert.match(profile, /OperatorInstructionsPanel/);
  assert.match(profile, /initialOperatorId=\{id\}/);
  assert.match(profile, /Assign instruction/);
});
