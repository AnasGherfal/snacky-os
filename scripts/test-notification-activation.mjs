import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const delivery = read("src/lib/notification-delivery.ts");
const center = read("src/components/NotificationCenter.tsx");
const card = read("src/components/NotificationActivationCard.tsx");
const topbar = read("src/components/Topbar.tsx");
const serviceWorker = read("public/sw.js");
const pushConfigApi = read("src/app/api/push-config/route.ts");
const statusApi = read("src/app/api/notifications/push-status/route.ts");
const testApi = read("src/app/api/notifications/test/route.ts");
const subscriptionApi = read("src/app/api/push-subscriptions/route.ts");
const routeApi = read("src/app/api/routes/route.ts");

test("service worker receives push and opens the notification route", () => {
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /addEventListener\("notificationclick"/);
  assert.match(serviceWorker, /clients\.openWindow/);
});

test("untagged test pushes never request renotify", () => {
  assert.match(serviceWorker, /const notificationTag/);
  assert.match(serviceWorker, /if \(notificationTag\)/);
  assert.match(serviceWorker, /options\.renotify = true/);
  assert.doesNotMatch(serviceWorker, /renotify:\s*true/);
  assert.match(serviceWorker, /Could not display rich notification/);
});

test("browser support is independent from a build-time VAPID value", () => {
  assert.match(center, /const browserSupportsPush/);
  assert.match(center, /fetch\("\/api\/push-config"/);
  assert.doesNotMatch(center, /process\.env\.NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.doesNotMatch(card, /process\.env\.NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.match(card, /status\?\.publicKey/);
});

test("server derives a stable VAPID pair without exposing the server secret", () => {
  assert.match(delivery, /createHmac\("sha256", serverSecret\)/);
  assert.match(delivery, /createECDH\("prime256v1"\)/);
  assert.match(delivery, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(delivery, /ensurePushNotificationConfig/);
  assert.match(delivery, /webpush\.setVapidDetails/);
  assert.doesNotMatch(pushConfigApi, /privateKey|private_key|SUPABASE_SERVICE_ROLE_KEY/);
});

test("public configuration endpoints return only the public key", () => {
  assert.match(pushConfigApi, /publicKey: result\.publicKey/);
  assert.match(statusApi, /publicKey:/);
  assert.doesNotMatch(pushConfigApi, /privateKey|private_key/);
  assert.doesNotMatch(statusApi, /privateKey|private_key/);
});

test("stale subscriptions are replaced when the public key changes", () => {
  assert.match(center, /subscriptionMatchesPublicKey/);
  assert.match(center, /await existing\.unsubscribe\(\)/);
  assert.match(card, /subscriptionMatchesPublicKey/);
  assert.match(card, /await existing\.unsubscribe\(\)/);
});

test("device subscriptions and test delivery are wired", () => {
  assert.match(center, /pushManager\.subscribe/);
  assert.match(center, /fetch\("\/api\/push-subscriptions"/);
  assert.match(center, /fetch\("\/api\/notifications\/test"/);
  assert.match(testApi, /sendTestPushNotification/);
  assert.match(delivery, /export async function sendTestPushNotification/);
  assert.match(subscriptionApi, /savePushSubscription/);
});

test("route assignment still creates the operator notification", () => {
  assert.match(routeApi, /notifyRouteAssigned/);
  assert.match(routeApi, /operatorTeamMemberId:\s*operatorId/);
  assert.match(delivery, /type:\s*"route_assigned"/);
});

test("notification bell is visible on desktop and mobile", () => {
  assert.match(topbar, /<NotificationCenter compact \/>/);
  const index = topbar.indexOf("<NotificationCenter compact />");
  const nearby = topbar.slice(Math.max(0, index - 100), index + 100);
  assert.doesNotMatch(nearby, /md:hidden/);
});

test("private material is never browser-exposed", () => {
  for (const browserFile of [center, card, serviceWorker, pushConfigApi, statusApi]) {
    assert.doesNotMatch(browserFile, /VAPID_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|privateKey|private_key/);
  }
});
