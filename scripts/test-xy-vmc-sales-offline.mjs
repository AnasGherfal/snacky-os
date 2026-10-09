import test from "node:test";
import assert from "node:assert/strict";

import {
  parseXyVmcFrame, parseXyVmcSalesReply, XY_VMC_SALES_QUERY,
} from "../src/lib/xy-vmc-sales-offline.ts";

function makeFrame(command, payload = []) {
  const bytes = [0xfa, 0xfb, command, payload.length, ...payload];
  let xor = 0;
  bytes.forEach((byte) => { xor ^= byte; });
  return Uint8Array.from([...bytes, xor]);
}

test("published XY POLL and ACK example frames have valid XOR", () => {
  const poll = parseXyVmcFrame(Uint8Array.from([0xfa, 0xfb, 0x41, 0x00, 0x40]));
  assert.equal(poll.command, 0x41);
  assert.equal(poll.packetNumber, null);
  const ack = parseXyVmcFrame(Uint8Array.from([0xfa, 0xfb, 0x42, 0x00, 0x43]));
  assert.equal(ack.command, 0x42);
  assert.equal(ack.packetNumber, null);
});

test("invalid checksums, partial frames and trailing bytes cannot be decoded", () => {
  const frame = makeFrame(0x71, [4, 0x47, 0x00, ...new Array(8).fill(0)]);
  const broken = frame.slice();
  broken[broken.length - 1] ^= 1;
  assert.throws(() => parseXyVmcFrame(broken), /checksum/);
  assert.throws(() => parseXyVmcFrame(frame.slice(0, -1)), /length/);
  assert.throws(() => parseXyVmcFrame(Uint8Array.from([...frame, 0])), /length/);
  assert.throws(() => parseXyVmcFrame(Uint8Array.from([0, ...frame.slice(1)])), /marker/);
});

test("a synthetic daily VMC reply yields unscaled cash/total words in both candidate byte orders", () => {
  const fields = new Array(18 * 4).fill(0);
  fields.splice(0, 4, 0, 0, 0, 3);
  fields.splice(4, 4, 0, 0, 0x03, 0xe8);
  fields.splice(8, 4, 0, 0, 0, 3);
  fields.splice(12, 4, 0, 0, 0x03, 0xe8);
  const reply = makeFrame(0x71, [7, XY_VMC_SALES_QUERY.DAILY, 0, ...fields]);
  const parsed = parseXyVmcSalesReply(parseXyVmcFrame(reply));
  assert.equal(parsed.category, "daily");
  assert.equal(parsed.packetNumber, 7);
  assert.equal(parsed.fields.total_transaction_count.candidateBigEndian, 3);
  assert.equal(parsed.fields.cash_transaction_amount.candidateBigEndian, 1000);
  assert.equal(parsed.fields.cash_transaction_amount.bytesHex, "000003e8");
  assert.equal(parsed.interpretationVerified, false);
  assert.equal(Object.keys(parsed.fields).length, 18);
});

test("a synthetic per-selection reply has only two raw unverified fields", () => {
  const frame = makeFrame(0x71, [1, XY_VMC_SALES_QUERY.SELECTION, 0, 0, 0, 0, 9, 0, 0, 1, 0]);
  const parsed = parseXyVmcSalesReply(parseXyVmcFrame(frame));
  assert.equal(parsed.category, "selection");
  assert.equal(parsed.fields.selection_transaction_count.candidateBigEndian, 9);
  assert.equal(Object.keys(parsed.fields).length, 2);
});

test("incomplete and non-sales vendor responses are rejected without changing the machine", () => {
  const incomplete = makeFrame(0x71, [7, 0x43, 0, 0, 0, 0, 1]);
  assert.throws(() => parseXyVmcSalesReply(parseXyVmcFrame(incomplete)), /layout/);
  const nonSales = makeFrame(0x71, [7, 0x42, 0, 0, 0]);
  assert.throws(() => parseXyVmcSalesReply(parseXyVmcFrame(nonSales)), /sales response/);
  const invalidOperation = makeFrame(0x71, [7, 0x43, 1, ...new Array(72).fill(0)]);
  assert.throws(() => parseXyVmcSalesReply(parseXyVmcFrame(invalidOperation)), /operation/);
});
