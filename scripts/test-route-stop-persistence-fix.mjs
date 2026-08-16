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

test("operator routes hide infrastructure setup warning without hiding admin diagnostics elsewhere", () => {
  const panel = read("src/components/operator/OperatorInstructionsPanel.tsx");
  const routes = read("src/app/operator/routes/page.tsx");
  assert.match(panel, /hideSetupWarning\?: boolean/);
  assert.match(panel, /if \(!snapshot && setupRequired && hideSetupWarning\) return null/);
  assert.match(routes, /<OperatorInstructionsPanel hideSetupWarning \/>/);
});
