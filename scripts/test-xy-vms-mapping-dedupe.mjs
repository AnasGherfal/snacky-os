import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const syncSource = fs.readFileSync(new URL("../src/lib/xy-vms-sync.ts", import.meta.url), "utf8");
const goodsStart = syncSource.indexOf("async function syncMachineGoodsWork");
const goodsEnd = syncSource.indexOf("async function syncMachineStatusWork", goodsStart);
const goodsSource = syncSource.slice(goodsStart, goodsEnd);

test("XY machine-goods sync dedupes repeated mapping writes by final product occurrence", () => {
  assert.match(goodsSource, /const pendingMappingWrites = new Map<string, PendingProductMappingWrite>\(\)/);
  assert.match(goodsSource, /pendingMappingWrites\.set\(mappingWriteKey\(row\), \{/);
  assert.match(goodsSource, /order: rowNumber/);
  assert.match(
    goodsSource,
    /Array\.from\(pendingMappingWrites\.values\(\)\)\.sort\(\(left, right\) => left\.order - right\.order\)/,
  );
  assert.ok(
    goodsSource.indexOf("const mappingWrites = Array.from") < goodsSource.indexOf("const activation = assessXyLaneSnapshot"),
    "mapping writes must flush before the snapshot activation/finalization decision, as before",
  );
  assert.equal(
    (goodsSource.match(/await upsertXyProductMapping\(\{/g) ?? []).length,
    1,
    "machine-goods sync should write each deduped mapping only in the final flush",
  );
});

test("XY sync exposes mapping-write reduction diagnostics", () => {
  assert.match(goodsSource, /mapping_rows_seen: snapshots\.length/);
  assert.match(goodsSource, /mapping_writes_attempted: mappingWrites\.length/);
  assert.match(goodsSource, /mapping_writes_deduplicated: Math\.max\(0, snapshots\.length - mappingWrites\.length\)/);
});

test("catalog product sync keeps its existing per-product mapping/update behavior", () => {
  const productStart = syncSource.indexOf("async function syncProductsWork");
  const productEnd = syncSource.indexOf("async function loadXyMachines", productStart);
  const productSource = syncSource.slice(productStart, productEnd);
  assert.match(productSource, /await upsertXyProductMapping\(\{/);
  assert.match(productSource, /await updateMatchedProductFromXy\(/);
});
