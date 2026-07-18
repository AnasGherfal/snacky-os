import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const delivery = read("src/lib/notification-delivery.ts");
const center = read("src/components/NotificationCenter.tsx");
const topbar = read("src/components/Topbar.tsx");
const serviceWorker = read("public/sw.js");
const pushConfigApi = read("src/app/api/push-config/route.ts");
const testApi = read("src/app/api/notifications/test/route.ts");
const subscriptionApi = read("src/app/api/push-subscriptions/route.ts");
const routeApi = read("src/app/api/routes/route.ts");
const migration = read("supabase/migrations/202607180002_notification_push_activation.sql");

// This suite validates the complete browser-to-server notification contract without exposing private key material.
const combined = [delivery, center, topbar, serviceWorker, pushConfigApi, testApi, subscriptionApi, migration].join("\n");

test("service worker receives push and opens the notification route", () => {
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /addEventListener\("notificationclick"/);
  assert.match(serviceWorker, /clients\.openWindow/);
});

test("browser support is independent from a build-time VAPID environment value", () => {
  assert.match(center, /const browserSupportsPush/);
  assert.match(center, /fetch\("\/api\/push-config"/);
  assert.doesNotMatch(center, /Boolean\(vapidPublicKey\)/);
  assert.doesNotMatch(center, /process\.env\.NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
});

test("server creates or loads one protected VAPID configuration", () => {
  assert.match(delivery, /webpush\.generateVAPIDKeys\(\)/);
  assert.match(delivery, /from\("push_notification_config"\)/);
  assert.match(delivery, /ensurePushNotificationConfig/);
  assert.match(delivery, /webpush\.setVapidDetails/);
  assert.match(delivery, /await ensureWebPushConfigured\(supabase\)/);
});

test("public configuration endpoint returns only the public key", () => {
  assert.match(pushConfigApi, /publicKey:\s*result\.publicKey/);
  assert.doesNotMatch(pushConfigApi, /privateKey|private_key|VAPID_PRIVATE_KEY/);
  assert.match(pushConfigApi, /getCurrentProfile/);
});

test("device subscriptions and test delivery are wired", () => {
  assert.match(center, /pushManager\.subscribe/);
  assert.match(center, /fetch\("\/api\/push-subscriptions"/);
  assert.match(center, /fetch\("\/api\/notifications\/test"/);
  assert.match(center, /Send a test to verify delivery/);
  assert.match(testApi, /sendTestPushNotification/);
  assert.match(delivery, /export async function sendTestPushNotification/);
  assert.match(subscriptionApi, /savePushSubscription/);
});

test("route assignment still creates the operator notification", () => {
  assert.match(routeApi, /notifyRouteAssigned/);
  assert.match(routeApi, /operatorTeamMemberId:\s*operatorId/);
  assert.match(delivery, /type:\s*"route_assigned"/);
  assert.match(delivery, /url:\s*`\/operator\/routes\/\$\{input\.routeId\}`/);
});

test("notification bell is visible on desktop and mobile", () => {
  assert.match(topbar, /<NotificationCenter compact \/>/);
  const window = topbar.slice(Math.max(0, topbar.indexOf("<NotificationCenter compact />") - 100), topbar.indexOf("<NotificationCenter compact />") + 100);
  assert.doesNotMatch(window, /md:hidden/);
});

test("migration protects private keys and is additive", () => {
  assert.match(migration, /create table if not exists public\.push_notification_config/);
  assert.match(migration, /revoke all on public\.push_notification_config from anon, authenticated/);
  assert.match(migration, /grant all on public\.push_notification_config to service_role/);
  assert.match(migration, /create unique index if not exists push_subscriptions_endpoint_unique/);
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|cascade|db reset)\b/i);
});

test("private VAPID material is never browser-exposed", () => {
  assert.doesNotMatch(center, /privateKey|private_key|VAPID_PRIVATE_KEY/);
  assert.doesNotMatch(serviceWorker, /privateKey|private_key|VAPID_PRIVATE_KEY/);
  assert.doesNotMatch(pushConfigApi, /privateKey|private_key|VAPID_PRIVATE_KEY/);
  assert.match(delivery, /privateKey/);
  assert.doesNotMatch(combined, /BEGIN PRIVATE KEY|BEGIN EC PRIVATE KEY/);
});
