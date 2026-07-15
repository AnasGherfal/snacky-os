import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const migrationPath = path.join(
  repoRoot,
  "supabase/migrations/202607150005_route_pickup_acknowledgement_canonicalization.sql",
);
const pagePath = path.join(repoRoot, "src/app/operator/routes/[id]/pick-list/page.tsx");

const migration = fs.readFileSync(migrationPath, "utf8");
const page = fs.readFileSync(pagePath, "utf8");

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function validateCanonicalAcknowledgements({
  checked,
  acknowledged,
  required,
  existing,
}) {
  const checkedIds = unique(checked);
  let acknowledgedIds = unique(acknowledged);
  const requiredIds = unique(required);
  const existingIds = new Set(unique(existing));

  if (!acknowledgedIds.length && checkedIds.length) acknowledgedIds = checkedIds;

  const checkedSet = new Set(checkedIds);
  const acknowledgedSet = new Set(acknowledgedIds);
  const checkedExisting = checkedIds.filter((id) => existingIds.has(id));

  if (requiredIds.some((id) => !checkedSet.has(id))) {
    return "required-not-checked";
  }
  if (requiredIds.some((id) => !acknowledgedSet.has(id))) {
    return "required-not-acknowledged";
  }
  if (checkedExisting.some((id) => !acknowledgedSet.has(id))) {
    return "checked-existing-not-acknowledged";
  }
  return "ok";
}

test("migration removes raw acknowledgement-array length equality", () => {
  assert.match(migration, /v_checked_existing_pickup_line_ids/);
  assert.match(migration, /coalesce\(rsi\.planned_quantity, 0\) > 0/);
  assert.match(migration, /Harmless extra acknowledgement IDs are ignored/);
  assert.doesNotMatch(
    migration,
    /array_length\(v_checked_pickup_line_ids[^;]+<>[^;]+array_length\(v_acknowledged_pickup_line_ids/s,
  );
  assert.match(migration, /select pg_notify\('pgrst', 'reload schema'\);/);
});

test("valid existing lines pass when zero-quantity acknowledgement IDs are also submitted", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1"],
      acknowledged: ["required-1", "zero-qty-line"],
      required: ["required-1"],
      existing: ["required-1", "zero-qty-line"],
    }),
    "ok",
  );
});

test("server-generated manual line IDs do not cause a false mismatch", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1", "server-generated-manual-line"],
      acknowledged: ["required-1"],
      required: ["required-1"],
      existing: ["required-1"],
    }),
    "ok",
  );
});

test("duplicate acknowledgement IDs are normalized", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1"],
      acknowledged: ["required-1", "required-1"],
      required: ["required-1"],
      existing: ["required-1"],
    }),
    "ok",
  );
});

test("older clients with no explicit acknowledgement array use checked rows", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1", "required-2"],
      acknowledged: [],
      required: ["required-1", "required-2"],
      existing: ["required-1", "required-2"],
    }),
    "ok",
  );
});

test("a required line missing from checked rows is rejected", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1"],
      acknowledged: ["required-1", "required-2"],
      required: ["required-1", "required-2"],
      existing: ["required-1", "required-2"],
    }),
    "required-not-checked",
  );
});

test("a required line missing from acknowledgements is rejected", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1", "required-2"],
      acknowledged: ["required-1"],
      required: ["required-1", "required-2"],
      existing: ["required-1", "required-2"],
    }),
    "required-not-acknowledged",
  );
});

test("an existing checked line missing from acknowledgements is rejected", () => {
  assert.equal(
    validateCanonicalAcknowledgements({
      checked: ["required-1", "existing-manual-line"],
      acknowledged: ["required-1"],
      required: ["required-1"],
      existing: ["required-1", "existing-manual-line"],
    }),
    "checked-existing-not-acknowledged",
  );
});

test("pickup page sends explicit acknowledgement IDs in prepare and confirm stages", () => {
  assert.match(page, /const acknowledgedPickupLineIds = useMemo/);
  assert.match(page, /acknowledgedPickupLineIds,[\s\S]*stage: "prepare"/);
  assert.match(page, /acknowledgedPickupLineIds,[\s\S]*stage: "confirm"/);
});
