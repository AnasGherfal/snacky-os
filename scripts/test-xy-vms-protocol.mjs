import assert from "node:assert/strict";
import test from "node:test";
import { buildXyReqData, buildXySign, normalizeXyApiResponse } from "../src/lib/xy-vms-protocol.ts";

test("XY signature uses sorted business parameters without authentication fields", () => {
  const params = {
    timestamp: "ignored",
    shbh: "6591",
    secret: "ignored",
    sign: "ignored",
    key: "ignored",
  };

  assert.equal(buildXyReqData(params), "shbh=6591");
  assert.equal(buildXySign("test-secret", "1700000000000", params), "aa36294ee937fa94c5e4f5f409835903");
});

test("XY H0000 envelope exposes the nested success code and machine rows", () => {
  const envelope = {
    code: "H0000",
    data: {
      code: 1,
      message: "success",
      data: [{ jqbh: "machine-1", jqmc: "Test machine" }],
    },
  };

  const normalized = normalizeXyApiResponse(envelope);

  assert.equal(normalized.code, 1);
  assert.equal(normalized.message, "success");
  assert.deepEqual(normalized.data, [{ jqbh: "machine-1", jqmc: "Test machine" }]);
  assert.equal(normalized.rawEnvelope, envelope);
});
