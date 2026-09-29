import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const syncSource = fs.readFileSync(new URL("../src/lib/xy-vms-sync.ts", import.meta.url), "utf8");
const goodsStart = syncSource.indexOf("async function syncMachineGoodsWork");
const goodsEnd = syncSource.indexOf("async function syncMachineStatusWork", goodsStart);
const goodsSource = syncSource.slice(goodsStart, goodsEnd);

test("XY machine-goods stock snapshot is inserted in one batch for current production volume", () => {
  assert.match(
    goodsSource,
    /insertChunks\(context\.supabase, "vms_stock_snapshots", snapshots, 500\)/,
  );
});

test("generic insert chunking remains bounded for other VMS data", () => {
  assert.match(syncSource, /async function insertChunks\([^)]*chunkSize = 200\)/);
  assert.match(syncSource, /"vms_product_catalog_snapshots", snapshots\)/);
});
