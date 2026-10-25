import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnoseCashMachineExpectation } from "../src/lib/cash-expectation-diagnostics.ts";

const detailPage = readFileSync("src/app/cash-collections/[id]/page.tsx", "utf8");

test("pending calculation does not falsely claim missing VMS or previous cash removal", () => {
  const result = diagnoseCashMachineExpectation({ expectation_status: "pending", interval_start_at: null });
  assert.equal(result.kind, "pending");
  assert.equal(result.needsAttention, true);
  assert.match(result.nextStep, /does not yet prove/);
});

test("cash expectation statuses explain evidence-based corrective actions", () => {
  for (const [status,kind,fragment] of [
    ["missing_start", "missing_start", "Do not invent a start date"],
    ["no_exact_vms_data", "no_exact_vms_data", "raw transaction import"],
    ["payment_split_incomplete", "payment_split_incomplete", "do not count card"],
    ["partial_removal", "partial_removal", "combined bag"],
    ["ready_cash_only_assumption", "ready_cash_only_assumption", "unclassified payment methods"],
    ["ready_exact", "ready_exact", "covered dates"],
    ["manual_override", "manual_override", "whole cash bag"],
  ]) {
    const result = diagnoseCashMachineExpectation({ expectation_status: status });
    assert.equal(result.kind, kind);
    assert.match(result.nextStep, new RegExp(fragment, "i"));
  }
  assert.equal(diagnoseCashMachineExpectation({ expectation_status: "future_status" }).kind, "review_unknown");
});

test("Arabic diagnostics preserve the source-specific remediation", () => {
  const missing = diagnoseCashMachineExpectation({ expectation_status: "missing_start" }, "ar");
  assert.match(missing.heading, /السحب الكامل/);
  assert.match(missing.nextStep, /لا تفترض/);
  const raw = diagnoseCashMachineExpectation({ expectation_status: "no_exact_vms_data" }, "ar");
  assert.match(raw.nextStep, /معاملات VMS الخام/);
});

test("cash detail shows the actionable diagnostics only to the amount-authorized view", () => {
  assert.match(detailPage, /import \{ diagnoseCashMachineExpectation \}/);
  assert.match(detailPage, /const diagnosis = diagnoseCashMachineExpectation\(entry, locale\)/);
  assert.match(detailPage, /diagnosis\.heading/);
  assert.match(detailPage, /diagnosis\.nextStep/);
  assert.match(detailPage, /Cash comparison needs source evidence/);
  assert.match(detailPage, /Do not invent a period, sales amount, or split by machine/);
  assert.match(detailPage, /if \(!canSeeMoney\)/);
});
