import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
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

// Execute the actual Topbar and authorization code with framework boundaries stubbed.
// Do not lock the test to a specific JSX spelling or remove role restrictions.
function loadModule(source, imports = {}, globals = {}) {
  const exports = {};
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(output, { ...globals, exports, require(name) {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }});
  return exports;
}

function renderTopbar(role, enabled = true, locale = "en", roles = [role]) {
  const authz = loadModule(read("src/lib/authz.ts"));
  // Exercise the real feature expression with a controlled environment, not source replacement.
  const domain = loadModule(read("src/lib/company-hub.ts"), {}, {
    process: { env: { NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED: enabled ? "true" : "false" } },
  });
  const navigation = loadModule(read("src/components/app-navigation.ts"));
  const jsx = (type, props) => ({ type, props });
  const NotificationCenter = () => null;
  const dictionary = { nav: {}, app: { name: "Snacky", subtitle: "Operations" }, language: { arabic: "العربية", english: "English" }, shell: {} };
  const imports = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react": { useState: initial => [initial, () => {}] },
    "next/image": { default: "img" }, "next/link": { default: "a" },
    "next/navigation": { usePathname: () => "/company", useRouter: () => ({}) },
    "lucide-react": { Menu: "menu-icon", UserCircle: "user-icon" },
    "@/components/I18nProvider": { useLanguage: () => ({ locale, dictionary, setLocale() {} }) },
    "@/components/NotificationCenter": { NotificationCenter },
    "@/components/app-navigation": navigation,
    "@/lib/company-hub": domain, "@/lib/authz": authz,
  };
  const { Topbar } = loadModule(topbar, imports);
  const tree = Topbar({ profile: { id: "fixture", full_name: "Fixture", role, roles } });
  const bells = [];
  function walk(node, ancestors = []) {
    if (Array.isArray(node)) return node.forEach(child => walk(child, ancestors));
    if (!node || typeof node !== "object") return;
    if (node.type === NotificationCenter) bells.push({ node, ancestors });
    walk(node.props?.children, [...ancestors, node]);
  }
  walk(tree);
  return bells;
}

test("actual bell remains visible on desktop and mobile in either language", () => {
  for (const locale of ["ar", "en"]) {
    const bells = renderTopbar("operator", true, locale);
    assert.equal(bells.length, 1);
    assert.equal(bells[0].node.props.compact, true);
    for (const ancestor of bells[0].ancestors) {
      assert.doesNotMatch(ancestor.props?.className ?? "", /(?:^|\s)(?:[a-z]+:)?hidden(?:\s|$)/);
    }
  }
});

test("relations and other staff receive Company updates without route privileges", () => {
  for (const role of ["crm", "finance", "warehouse", "purchasing"]) {
    const bells = renderTopbar(role);
    assert.equal(bells.length, 1);
    assert.equal(bells[0].node.props.companyUpdates, true);
    assert.equal(bells[0].node.props.routeAlerts, false);
    assert.equal(renderTopbar(role, false).length, 0);
  }
});

test("existing route alerts survive Company being disabled and multi-role staff retain access", () => {
  for (const role of ["owner", "admin", "supervisor", "operator"]) {
    for (const enabled of [false, true]) {
      const bells = renderTopbar(role, enabled);
      assert.equal(bells.length, 1);
      assert.equal(bells[0].node.props.routeAlerts, true);
      assert.equal(bells[0].node.props.companyUpdates, enabled);
    }
  }
  for (const role of ["investor", "viewer"]) assert.equal(renderTopbar(role).length, 0);
  const mixed = renderTopbar("investor", true, "en", ["investor", "crm"]);
  assert.equal(mixed[0].node.props.companyUpdates, true);
  assert.equal(mixed[0].node.props.routeAlerts, false);
});

test("private material is never browser-exposed", () => {
  for (const browserFile of [center, card, serviceWorker, pushConfigApi, statusApi]) {
    assert.doesNotMatch(browserFile, /VAPID_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|privateKey|private_key/);
  }
});

// Production activated Company separately; explicit false must remain a reliable off switch.
test("Company activation defaults on while the emergency false switch remains effective", () => {
  for (const [value, expected] of [[undefined, true], ["true", true], ["false", false]]) {
    const domain = loadModule(read("src/lib/company-hub.ts"), {}, {process:{env:{NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:value}}});
    assert.equal(domain.companyHubEnabled, expected);
  }
});
