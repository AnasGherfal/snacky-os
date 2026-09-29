import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = fs.readFileSync(path.join(root, "src/components/Sidebar.tsx"), "utf8");

test("sidebar does not eagerly prefetch every Snacky OS module", () => {
  const eagerPrefetchCalls = (sidebar.match(/router\.prefetch\(/g) ?? []).length;
  const forcedPrefetchLinks = (sidebar.match(/prefetch=\{true\}/g) ?? []).length;
  const disabledPrefetchLinks = (sidebar.match(/prefetch=\{false\}/g) ?? []).length;

  assert.equal(eagerPrefetchCalls, 0, "sidebar must not call router.prefetch for every navigation item on mount");
  assert.equal(forcedPrefetchLinks, 0, "sidebar links must not force automatic route prefetch");
  assert.ok(disabledPrefetchLinks > 0, "sidebar navigation should explicitly disable background prefetch");
});
