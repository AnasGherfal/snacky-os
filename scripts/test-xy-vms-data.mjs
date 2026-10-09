import assert from "node:assert/strict";
import test from "node:test";
import { classifyXyLane, normalizeXyLiveSelection, xyProductIdentity } from "../src/lib/xy-vms-data.ts";

test("XY native catalogue prices convert minor units to LYD", () => {
  const identity = xyProductIdentity({ spbh: "42", spmc: "Water", spjg: "300", spjj: "175" });
  assert.equal(identity.vmsProductId, "42");
  assert.equal(identity.sellingPrice, 3);
  assert.equal(identity.costPrice, 1.75);
});

test("XY alternate native selling field also converts minor units", () => {
  const identity = xyProductIdentity({ spsj: "450" });
  assert.equal(identity.sellingPrice, 4.5);
});

test("already-normalized generic price aliases remain unchanged", () => {
  const identity = xyProductIdentity({ spjg: "", spjj: "invalid", selling_price: "3.50", cost_price: "2.25" });
  assert.equal(identity.sellingPrice, 3.5);
  assert.equal(identity.costPrice, 2.25);
});

test("configured XY lane preserves exact lane, quantity, and capacity", () => {
  const lane = classifyXyLane({ hdbh: "001", spbh: "42", spmc: "Water", hdkc: "3", hdrl: "7" });
  assert.equal(lane.kind, "configured");
  assert.equal(lane.slotCode, "001");
  assert.equal(lane.currentQty, 3);
  assert.equal(lane.capacity, 7);
});

test("XY 0000 255/255 rows are placeholders, never machine stock", () => {
  const lane = classifyXyLane({ hdbh: "061", spbh: "0000", hdkc: "255", hdrl: "255" });
  assert.equal(lane.kind, "placeholder");
});

test("impossible XY quantities fail validation", () => {
  const lane = classifyXyLane({ hdbh: "001", spbh: "42", spmc: "Water", hdkc: "8", hdrl: "7" });
  assert.equal(lane.kind, "invalid");
  assert.match(lane.reason, /exceeds capacity/);
});

test("direct XY live selection parses native minor units and normalized LYD prices safely",()=>{
 const native=normalizeXyLiveSelection({hdbh:"001",spbh:"42",spmc:"Water",spjg:"500",hdkc:"6",hdrl:"7"});
 assert.equal(native.priceLyd,5);
 assert.equal(native.currentQty,6);
 assert.equal(native.capacity,7);
 const normalized=normalizeXyLiveSelection({slotCode:"002",product_id:"99",sellingPrice:"3.75",currentQty:2,capacity:5});
 assert.equal(normalized.priceLyd,3.75);
 assert.equal(normalized.currentQty,2);
 assert.equal(normalized.capacity,5);
});
test("direct XY read must not disguise invalid or unknown counts as zero",()=>{
 const negative=normalizeXyLiveSelection({hdbh:"001",spbh:"42",spjg:"400",hdkc:-1,hdrl:8});
 assert.equal(negative.currentQty,null);
 const unknown=normalizeXyLiveSelection({hdbh:"001",spbh:"42",spjg:"400",hdkc:"",hdrl:""});
 assert.equal(unknown.currentQty,null);
 assert.equal(unknown.capacity,null);
 const fractional=normalizeXyLiveSelection({hdbh:"001",spbh:"42",spjg:"400",hdkc:2.5,hdrl:8});
 assert.equal(fractional.currentQty,null);
});
