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
const pushConfig = read("src/lib/push-config.ts");
const migration = read("supabase/migrations/202607180003_push_notification_config.sql");

const browserSources = `${card}\n${worker}\n${statusApi}`;

test("push infrastructure remains connected", () => {
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /showNotification/);
  assert.match(delivery, /notifyRouteAssigned/);
  assert.match(delivery, /push_subscriptions/);
  assert.match(delivery, /await configureWebPush\(supabase\)/);
});

test("account exposes device activation and a real delivery test", () => {
  assert.match(account, /NotificationActivationCard/);
  assert.match(card, /Notification\.requestPermission/);
  assert.match(card, /pushManager\.subscribe/);
  assert.match(card, /\/api\/push-subscriptions/);
  assert.match(card, /\/api\/notifications\/test-push/);
  assert.match(card, /status\?\.publicKey/);
  assert.doesNotMatch(card, /process\.env\.NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
});

test("server securely creates or loads one VAPID key pair", () => {
  assert.match(pushConfig, /webpush\.generateVAPIDKeys\(\)/);
  assert.match(pushConfig, /from\("push_notification_config"\)/);
  assert.match(pushConfig, /return readStoredConfig\(client\)/);
  assert.match(pushConfig, /getSupabaseAdminClient/);
  assert.match(pushConfig, /webpush\.setVapidDetails/);
});

test("status endpoint returns only the public key and schema readiness", () => {
  assert.match(statusApi, /ensurePushConfig/);
  assert.match(statusApi, /publicKey:\s*config\.configured \? config\.config\.publicKey : null/);
  assert.match(statusApi, /push_subscriptions/);
  assert.doesNotMatch(statusApi, /privateKey|private_key|VAPID_PRIVATE_KEY/);
});

test("test endpoint only sends to the authenticated user's active subscriptions", () => {
  assert.match(testApi, /getCurrentProfile/);
  assert.match(testApi, /configureWebPush\(supabase\)/);
  assert.match(testApi, /\.eq\("user_id", profile\.id\)/);
  assert.match(testApi, /\.eq\("is_active", true\)/);
  assert.match(testApi, /webpush\.sendNotification/);
});

test("private key table is service-role only and migration is additive", () => {
  assert.match(migration, /create table if not exists public\.push_notification_config/);
  assert.match(migration, /grant all on public\.push_notification_config to service_role/);
  assert.match(migration, /revoke all on public\.push_notification_config from anon, authenticated/);
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|cascade|db reset)\b/i);
});

test("private VAPID material is never sent to browser code", () => {
  assert.doesNotMatch(browserSources, /privateKey|private_key|VAPID_PRIVATE_KEY/);
  assert.match(pushConfig, /privateKey/);
  assert.doesNotMatch(`${pushConfig}\n${migration}`, /BEGIN PRIVATE KEY|BEGIN EC PRIVATE KEY/);
});

test("activation change is isolated from routes and inventory writes", () => {
  const source = `${card}\n${statusApi}\n${testApi}\n${pushConfig}`;
  assert.doesNotMatch(source, /snacky_confirm_route_pickup|inventory_movements|route_stop_items/);
  assert.doesNotMatch(source, /\.delete\(|truncate|drop table/i);
});
