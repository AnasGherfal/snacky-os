import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isPurchaseOperationId,
  purchaseOperationStorageKey,
  resolvePurchaseOperationId,
} from "../src/lib/purchase-operation-id.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const component = read("src/components/PurchaseOperationForm.tsx");
const detailPage = read("src/app/purchases/[id]/page.tsx");
const actions = read("src/lib/purchase-actions.ts");

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

test("a pending operation keeps one browser-stored UUID across reloads and errors", () => {
  assert.equal(isPurchaseOperationId(FIRST_ID), true);
  assert.equal(isPurchaseOperationId("not-a-uuid"), false);
  assert.equal(
    purchaseOperationStorageKey("purchase-a", "payment"),
    "snacky:purchase-operation:v1:purchase-a:payment",
  );

  const pending = resolvePurchaseOperationId({
    storedId: FIRST_ID,
    initialId: SECOND_ID,
    confirmedId: "",
    createId: () => THIRD_ID,
  });
  assert.deepEqual(pending, { id: FIRST_ID, rotatedAfterSuccess: false });

  const failedOrUnrelated = resolvePurchaseOperationId({
    storedId: FIRST_ID,
    initialId: SECOND_ID,
    confirmedId: THIRD_ID,
    createId: () => SECOND_ID,
  });
  assert.deepEqual(failedOrUnrelated, { id: FIRST_ID, rotatedAfterSuccess: false });
});

test("a matching confirmed result rotates exactly once for a deliberate next payment", () => {
  const afterSuccess = resolvePurchaseOperationId({
    storedId: FIRST_ID,
    initialId: THIRD_ID,
    confirmedId: FIRST_ID,
    createId: () => SECOND_ID,
  });
  assert.deepEqual(afterSuccess, { id: SECOND_ID, rotatedAfterSuccess: true });

  const sameSuccessUrlReloaded = resolvePurchaseOperationId({
    storedId: afterSuccess.id,
    initialId: THIRD_ID,
    confirmedId: FIRST_ID,
    createId: () => THIRD_ID,
  });
  assert.deepEqual(sameSuccessUrlReloaded, { id: SECOND_ID, rotatedAfterSuccess: false });
});

test("purchase detail forms persist receive, payment, cancel, and void command identities", () => {
  assert.match(component, /window\.localStorage\.getItem\(storageKey\)/);
  assert.match(component, /window\.localStorage\.setItem\(storageKey, resolved\.id\)/);
  assert.match(component, /<fieldset disabled=!\{ready\}|<fieldset disabled=\{!ready\}/);
  assert.match(component, /name="client_submission_id" value=\{submissionId\}/);

  for (const operation of ["receive", "payment", "cancel", "void"]) {
    assert.match(detailPage, new RegExp(`operation=["']${operation}["']`));
  }
  assert.match(detailPage, /confirmedSubmissionId=\{purchaseReceived\}/);
  assert.match(detailPage, /confirmedSubmissionId=\{paymentRecorded\}/);
  assert.match(detailPage, /confirmedSubmissionId=\{purchaseCancelled\}/);
  assert.match(detailPage, /confirmedSubmissionId=\{purchaseVoided\}/);
  assert.doesNotMatch(
    detailPage,
    /name=["']client_submission_id["'][^>]*crypto\.randomUUID\(\)/,
  );
});

test("server redirects acknowledge the exact completed command, not a generic success flag", () => {
  assert.match(actions, /new URLSearchParams\(\{ purchaseReceived: clientSubmissionId \}\)/);
  assert.match(actions, /new URLSearchParams\(\{ paymentRecorded: clientSubmissionId \}\)/);
  assert.match(actions, /purchaseCancelled=\$\{encodeURIComponent\(clientSubmissionId\)\}/);
  assert.match(actions, /params\.set\("purchaseVoided", clientSubmissionId\)/);
  assert.doesNotMatch(actions, /paymentRecorded: ["']1["']/);
});
