import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/app/routes/new/RouteCreateForm.tsx"), "utf8");

test("selecting a machine focuses and surfaces that machine's recommendations", () => {
  assert.match(source, /setRecommendationMachineFilter\(machineId\)/);
  assert.match(source, /Use recommended quantities for this machine/);
  assert.match(source, /selectedManualRecommendationGroups\.some\(\(group\) => group\.recommendedTotal > 0\)/);
  assert.match(source, /selectRecommendationGroups\(selectedManualRecommendationGroups\)/);
  assert.match(source, /Tap to add recommendation/);
});
