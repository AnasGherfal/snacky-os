import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  missingDistanceFieldName,
  parseBulkMissingDistances,
} from "../src/lib/route-distance-bulk.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const a = { fromKind: "storage", fromId: "storage-id", toId: "mall-id" };
const b = { fromKind: "machine", fromId: "mall-id", toId: "land-id" };
const c = { fromKind: "machine", fromId: "land-id", toId: "mall-id" };
const links = [a, b, c];

test("one submission saves entered 0 and decimal km, while blanks stay unknown", () => {
  const form = new FormData();
  form.set(missingDistanceFieldName(a), "3.7");
  form.set(missingDistanceFieldName(b), "0");
  form.set(missingDistanceFieldName(c), "");
  assert.deepEqual(parseBulkMissingDistances(form, links), [
    { fromKind: "storage", fromId: "storage-id", toId: "mall-id", km: 3.7 },
    { fromKind: "machine", fromId: "mall-id", toId: "land-id", km: 0 },
  ]);
});
test("outbound and inbound road connections are separate inputs", () => {
  const f = new FormData();
  f.append(missingDistanceFieldName(b), "16");
  f.append(missingDistanceFieldName(c), "14");
  assert.deepEqual(parseBulkMissingDistances(f, links).map(x => x.km), [16, 14]);
});
test("blank numeric field is not persisted as zero", () => {
  const f = new FormData();
  f.set(missingDistanceFieldName(a), "   ");
  assert.deepEqual(parseBulkMissingDistances(f, links), []);
});
test("unexpected or stale route links are rejected rather than overwriting saved distances", () => {
  const f = new FormData();
  f.set("distance:machine:unknown:mall-id", "8");
  assert.throws(() => parseBulkMissingDistances(f, links), /changed/);
});
test("bad and impossible distances reject the whole submitted batch", () => {
  for (const bad of ["-1", "NaN", "99999", "2.123", "Infinity", "1e3"]) {
    const f = new FormData();
    f.set(missingDistanceFieldName(a), "3.7");
    f.set(missingDistanceFieldName(b), bad);
    assert.throws(() => parseBulkMissingDistances(f, links));
  }
});
test("save endpoint remains restricted to owners/admins and uses one atomic insert", () => {
  const server = read("src/lib/route-distance-actions.ts");
  const page = read("src/app/reports/route-distances/fill/page.tsx");
  assert.match(server, /canManagePayroll\(profile\)/);
  assert.match(server, /parseBulkMissingDistances\(form, live.missingLinks\)/);
  assert.match(server, /\.insert\(rows\)/);
  assert.match(page, /canManagePayroll\(profile\)/);
  assert.match(page, /saveBulkMissingRouteDistances/);
  assert.match(page, /missingDistanceFieldName/);
  assert.match(page, /Save all entered distances/);
});
