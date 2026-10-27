import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canReadOperatorPurchaseAvailability } from "../src/lib/operator-money-availability-auth.ts";

const active = role => ({
  active_status: "active",
  team_member_id: "c38d2f2a-5f4b-4444-a8c5-5fcd72b0df08",
  role,
  roles: [role],
});

test("internal linked and active Snacky staff can check personal-purchase stock", () => {
  for (const role of ["owner","admin","supervisor","crm","operator","warehouse","purchasing","finance"]) {
    assert.equal(canReadOperatorPurchaseAvailability(active(role)), true, role);
  }
  assert.equal(canReadOperatorPurchaseAvailability(active("procurement")), true, "Legacy procurement alias is purchasing");
});

test("investors, passive viewers, inactive and unlinked accounts cannot read service-role stock", () => {
  assert.equal(canReadOperatorPurchaseAvailability(null), false);
  assert.equal(canReadOperatorPurchaseAvailability(undefined), false);
  for (const role of ["investor","viewer","unknown"]) {
    assert.equal(canReadOperatorPurchaseAvailability(active(role)), false, role);
  }
  assert.equal(canReadOperatorPurchaseAvailability({...active("operator"),active_status:"inactive"}), false);
  assert.equal(canReadOperatorPurchaseAvailability({...active("owner"),active_status:null}), false);
  assert.equal(canReadOperatorPurchaseAvailability({...active("warehouse"),team_member_id:""}), false);
  assert.equal(canReadOperatorPurchaseAvailability({...active("operator"),team_member_id:null}), false);
  assert.equal(canReadOperatorPurchaseAvailability({...active("operator"),team_member_id:"  "}), false);
  assert.equal(canReadOperatorPurchaseAvailability({...active("viewer"),roles:["viewer","operator"]}), true);
});

test("operator-money API denies inactive sessions and gates service-role stock reads", () => {
  const api=readFileSync("src/app/api/operator-money/route.ts","utf8");
  const service=readFileSync("src/app/api/operator-money/availability.ts","utf8");
  const get=api.slice(api.indexOf("export async function GET("),api.indexOf("export async function POST("));
  const post=api.slice(api.indexOf("export async function POST("));
  assert.match(get,/profile\.active_status !== "active"/);
  assert.match(post,/profile\.active_status !== "active"/);
  assert.match(get,/if \(!manager && !canReadOperatorPurchaseAvailability\(profile\)\)/);
  assert.match(post,/if \(!manager && !canReadOperatorPurchaseAvailability\(profile\)\)/);
  const availability=post.indexOf('if (action === "availability")');
  const gate=post.indexOf("if (!canReadOperatorPurchaseAvailability(profile))",availability);
  const read=post.indexOf("await getOperatorPurchaseAvailability(productId)",availability);
  assert.ok(availability>=0 && gate>availability && read>gate,"Authorization must run before privileged availability read");
  assert.match(service,/getSupabaseAdminClient\(\)/);
  assert.doesNotMatch(service,/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  assert.match(api,/Only owner\/admin can perform this action/);
});

test("operator money API responses are private and non-cacheable", () => {
  const api=readFileSync("src/app/api/operator-money/route.ts","utf8");
  assert.match(api,/export const dynamic = "force-dynamic"/);
  assert.match(api,/headers\.set\("Cache-Control", "private, no-store, max-age=0"\)/);
  assert.match(api,/headers\.set\("Vary", "Cookie"\)/);
  assert.equal((api.match(/NextResponse\.json\(/g) ?? []).length, 1,
    "Only the protected response helper may call NextResponse.json");
  assert.ok((api.match(/operatorMoneyJson\(/g) ?? []).length > 30,
    "Every financial or purchase API result uses the private response helper");
});

test("purchase overview enforces active employee authorization before privileged movement proof", () => {
  const overview=readFileSync("src/app/api/operator-money/overview/route.ts","utf8");
  const guard=overview.indexOf('if (profile.active_status !== "active")');
  const staff=overview.indexOf('if (!isOwnerAdminRole(profile) && !canReadOperatorPurchaseAvailability(profile))');
  const read=overview.indexOf('getSupabaseAdminClient()',staff);
  assert.ok(guard>=0 && staff>guard && read>staff,
    "Inactive and unauthorized users must be denied before the admin inventory proof client is used");
  assert.match(overview,/Cache-Control": "private, no-store, max-age=0"/);
  assert.match(overview,/resolvePurchasePerson\(manager/);
  assert.match(overview,/verifyPurchaseStock\(/);
});
