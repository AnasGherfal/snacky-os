import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("quota review query only identifies exact immutable archive candidates", () => {
  const sql=fs.readFileSync("scripts/sql/refill-photo-safe-archive-batch.sql","utf8");
  assert.match(sql,/BEGIN TRANSACTION READ ONLY/);
  assert.match(sql,/source_release_approved',false/);
  assert.match(sql,/'release',false/);
  assert.match(sql,/REVIEW_REQUIRED_NOT_APPROVED/);
  assert.match(sql,/expected_etag/);
  assert.match(sql,/source_updated_at/);
  assert.match(sql,/expected_size/);
  assert.match(sql,/photoPath/);
  assert.match(sql,/photoUrl/);
  assert.match(sql,/route_stop_safety_checks/);
  assert.match(sql,/machine_refill_history/);
  assert.match(sql,/resolved_at IS NULL AND i\.archived_at IS NULL/);
  assert.match(sql,/greatest\(o\.created_at,o\.updated_at\)/);
  assert.match(sql,/LIMIT 10/);
  assert.doesNotMatch(sql,/(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE)\b/im);
});

test("the source-release gate stays independent of the copy-only canary report",()=>{
  const handler=fs.readFileSync("src/app/api/ops/archive-refill-photo/route.ts","utf8");
  assert.match(handler,/SNACKY_PHOTO_ARCHIVE_RELEASE_ENABLED/);
  assert.match(handler,/source_release_not_approved/);
  assert.match(handler,/job\.source_release_approved!==true/);
  assert.match(handler,/quantity_screenshot_protected/);
});
