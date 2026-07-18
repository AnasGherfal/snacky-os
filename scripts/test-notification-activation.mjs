import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const card = read("src/components/NotificationActivationCard.tsx");
const statusApi = read("src/app/api/notifications/push-status/route.ts");
const testApi = read("src/app/api/notifications/test-push/route.ts");
const account = read("src/app/account/page.tsx");
const worker = read("public/sw.js");
const delivery = read("src/lib/notification-delivery.ts");
const env = read(".env.example");

test("push infrastructure remains connected", () => {
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /showNotification/);
  assert.match(delivery, /notifyRouteAssigned/);
  assert.match(delivery, /push_subscriptions/);
});

test("account exposes device activation and a real delivery test", () => {
  assert.match(account, /NotificationActivationCard/);
  assert.match(card, /Notification\.requestPermission/);
  assert.match(card, /pushManager\.subscribe/);
  assert.match(card, /\/api\/push-subscriptions/);
  assert.match(card, /\/api\/notifications\/test-push/);
});

test("status endpoint checks secrets and database readiness without exposing the private key", () => {
  assert.match(statusApi, /VAPID_SUBJECT/);
  assert.match(statusApi, /NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.match(statusApi, /VAPID_PRIVATE_KEY/);
  assert.match(statusApi, /push_subscriptions/);
  assert.doesNotMatch(statusApi, /privateKey\s*:/);
});

test("test endpoint only sends to the authenticated user's active subscriptions", () => {
  assert.match(testApi, /getCurrentProfile/);
  assert.match(testApi, /\.eq\("user_id", profile\.id\)/);
  assert.match(testApi, /\.eq\("is_active", true\)/);
  assert.match(testApi, /webpush\.sendNotification/);
});

test("VAPID environment contract is documented", () => {
  for (const key of ["VAPID_SUBJECT", "NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) assert.match(env, new RegExp(key));
});

test("activation change is isolated from routes and inventory writes", () => {
  const source = `${card}\n${statusApi}\n${testApi}`;
  assert.doesNotMatch(source, /snacky_confirm_route_pickup|inventory_movements|route_stop_items/);
  assert.doesNotMatch(source, /\.delete\(|\.update\(/);
});
