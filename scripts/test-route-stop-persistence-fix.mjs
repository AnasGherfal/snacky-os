import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("completion photo is read from the same server persistence client", () => {
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/completion-photo/route.ts");
  assert.match(api, /Persisted completion proof must be read with the same server client used to write it/);
  assert.match(api, /const \{ data, error \} = await context\.writeClient[\s\S]*\.from\("machine_refill_history"\)/);
});

test("saved machine photo state reaches the stop completion form", () => {
  const quick = read("src/components/operator/RouteStopQuickActions.tsx");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  assert.match(quick, /snacky:machine-photo-persisted/);
  assert.match(page, /persistedMachinePhotoReady/);
  assert.match(page, /window\.addEventListener\("snacky:machine-photo-persisted"/);
  assert.match(page, /const hasPersistedMachineProof = persistedMachinePhotoReady \|\| Boolean\(stopData\.hasCompletionPhoto\)/);
  assert.match(page, /proofReady: Boolean\(finalPhotoFile \|\| persistedMachinePhotoReady \|\| stopData\.hasCompletionPhoto\)/);
});

test("selecting the final machine photo persists it before stop submission", () => {
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  assert.match(page, /saveFinalMachinePhotoImmediately/);
  assert.match(page, /if \(file\) void saveFinalMachinePhotoImmediately\(file\)/);
  assert.match(page, /completion-photo[\s\S]*method: "POST"/);
  assert.match(page, /setPersistedMachinePhotoReady\(true\)/);
  assert.match(page, /Photo saved\. You can close the app and return later\./);
  assert.match(page, /!finalPhotoSaving && cleaningDone/);
});

test("role-array helper resolves with the empty route-writer search path", () => {
  const migration = read("supabase/migrations/20260908090000_auth_role_array_search_path_repair.sql");
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /'\{\}'::public\.team_role\[\]/);
  assert.doesNotMatch(migration, /::team_role\[\]/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test("operator routes hide infrastructure setup warning without hiding admin diagnostics elsewhere", () => {
  const panel = read("src/components/operator/OperatorInstructionsPanel.tsx");
  const routes = read("src/app/operator/routes/page.tsx");
  assert.match(panel, /hideSetupWarning\?: boolean/);
  assert.match(panel, /if \(!snapshot && setupRequired && hideSetupWarning\) return null/);
  assert.match(routes, /<OperatorInstructionsPanel hideSetupWarning \/>/);
});
