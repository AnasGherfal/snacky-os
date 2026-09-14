// Browser component tests: actual Snacky shell, navigation, i18n and production CSS.
// Next routing is adapted to browser history; network/auth side effects are isolated.
// This is deliberately NOT a production route or an authentication bypass.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appRoles } from "../src/lib/authz.ts";
import { navigationForUser, navigationContextForUser } from "../src/components/module-tabs-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tools = process.env.NAVIGATION_TEST_TOOLS;
if (!tools) throw new Error("Set NAVIGATION_TEST_TOOLS to the isolated Playwright/esbuild installation.");
const requireTools = createRequire(join(resolve(tools), "package.json"));
const { build } = requireTools("esbuild");
const { chromium, expect } = requireTools("@playwright/test");
const artifacts = join(root, "artifacts/navigation");
mkdirSync(artifacts, { recursive: true });

const routing = `
import { useSyncExternalStore } from 'react';
const subscribe = (notify) => { window.addEventListener('popstate', notify); window.addEventListener('navigation-test', notify); return () => { window.removeEventListener('popstate', notify); window.removeEventListener('navigation-test', notify); }; };
export const router = { push(href) { history.pushState(null, '', href); window.dispatchEvent(new Event('navigation-test')); }, replace(href) { history.replaceState(null, '', href); window.dispatchEvent(new Event('navigation-test')); }, refresh() {} };
export function useRouter() { return router; }
export function usePathname() { return useSyncExternalStore(subscribe, () => location.pathname, () => '/'); }
export function useSearchParams() { return new URLSearchParams(useSyncExternalStore(subscribe, () => location.search, () => '')); }
`;
const stubs = {
  "next/navigation": routing,
  "next/link": `import React from 'react'; import { router } from 'next/navigation'; export function useLinkStatus() { return { pending: false }; } export default React.forwardRef(function Link({href, onClick, children, prefetch, replace, scroll, ...props}, ref) { return <a {...props} ref={ref} href={href} onClick={(event) => { onClick?.(event); if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); router.push(href); } }}>{children}</a>; });`,
  "next/image": `import React from 'react'; export default function Image({fill, sizes, priority, ...props}) { return <img {...props} style={fill ? {position:'absolute',inset:0,width:'100%',height:'100%'} : undefined}/>; }`,
  "@/components/SessionGuard": "export function SessionGuard() { return null; }",
  "@/components/XyBackgroundSync": "export function XyBackgroundSync() { return null; }",
  "@/components/NotificationCenter": `import React from 'react'; export function NotificationCenter() { return <button className="h-11 w-11 rounded-lg border border-slate-200" aria-label="Notifications">♧</button>; }`,
};
const bundle = await build({
  absWorkingDir: root,
  stdin: { resolveDir: root, sourcefile: "navigation-fixture.tsx", loader: "tsx", contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShellChrome } from './src/components/ShellChrome';
import { I18nProvider, useLanguage } from './src/components/I18nProvider';
import { NavigationBreadcrumbs } from './src/components/NavigationBreadcrumbs';
import { useAppNavigation } from './src/components/NavigationProvider';
const initial = window.__NAVIGATION_TEST__;
const profile = { id:'navigation-test', full_name:'Snacky team', email:null, phone:null, role:initial.role, roles:[initial.role], active_status:'active', team_member_id:'self-member', can_add_products:false };
function Content() {
 const { location } = useAppNavigation(); const { locale } = useLanguage();
 const title = location ? locale === 'ar' ? location.tab.labelAr : location.tab.label : 'Page';
 return <div className="space-y-5"><NavigationBreadcrumbs items={[{label:'Machines',href:'/machines'},{label:title || 'Record'}]}/><div className="border-b border-slate-200 pb-5"><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-2 text-sm text-slate-500">{locale === 'ar' ? 'اختبار تنظيم التنقل — بدون بيانات تشغيلية' : 'Navigation component preview — no operational data'}</p></div><section className="surface-card"><label className="block space-y-2"><span>{locale === 'ar' ? 'ملاحظات' : 'Notes'}</span><input data-testid="draft" className="field-input" placeholder={locale === 'ar' ? 'ملاحظات العمل' : 'Work notes'} /></label></section><section className="surface-card"><h2 className="font-semibold">{locale === 'ar' ? 'العمل اليومي' : 'Daily work'}</h2><p className="mt-2 text-sm text-slate-500">{locale === 'ar' ? 'اختر القسم من القائمة. تظهر الصفحات المرتبطة في الأعلى.' : 'Choose a workspace from the sidebar. Related pages stay together above.'}</p></section></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider initialLocale={initial.locale}><ShellChrome profile={profile} pathname={location.pathname}><Content/></ShellChrome></I18nProvider>);
` },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  tsconfig: join(root, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "isolated-navigation-boundaries", setup(bundler) {
    bundler.onResolve({ filter: /^(next\/(navigation|link|image)|@\/components\/(SessionGuard|XyBackgroundSync|NotificationCenter))$/ }, (args) => ({ path: args.path, namespace: "navigation-test" }));
    bundler.onLoad({ filter: /.*/, namespace: "navigation-test" }, (args) => ({ contents: stubs[args.path], loader: "jsx", resolveDir: root }));
  } }],
});
function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const cssFiles = filesBelow(join(root, ".next/static")).filter((file) => file.endsWith(".css"));
assert.ok(cssFiles.length, "Build Snacky OS first so browser tests use its actual production CSS.");
const css = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/fixture.js") { response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].text); return; }
  if (path === "/fixture.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
  if (path === "/brand/snacky-logo.png") {
    const file = join(root, "public/brand/snacky-logo.png");
    if (existsSync(file)) { response.setHeader("content-type", "image/png"); response.end(readFileSync(file)); return; }
    response.statusCode = 204; response.end(); return;
  }
  if (path === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const results = [];
const pages = [];
const errors = [];
async function pageFor(role = "owner", locale = "en", viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(({ role, locale }) => { window.__NAVIGATION_TEST__ = { role, locale }; }, { role, locale });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  pages.push(page);
  return page;
}
async function at(page, path, workspace) {
  await page.goto(origin + path);
  await expect(page.locator("[data-navigation-context]")).toHaveAttribute("data-navigation-context", workspace);
}
async function noHorizontalOverflow(page) {
  const values = await page.evaluate(() => {
    const header = document.querySelector("header");
    return { document: document.documentElement.scrollWidth, viewport: innerWidth, header: header.scrollWidth, headerWidth: header.clientWidth };
  });
  assert.ok(values.document <= values.viewport + 1, JSON.stringify(values));
  assert.ok(values.header <= values.headerWidth + 1, JSON.stringify(values));
}
async function check(name, fn) {
  await fn(); results.push({ name, status: "passed" }); console.log(`PASS: ${name}`);
}
try {
  await check("CRM transitions and browser back/forward keep the same sidebar and top-level menu", async () => {
    const page = await pageFor();
    await at(page, "/locations-pipeline", "crm");
    await page.locator('main [data-navigation-tabs="primary"] a[href="/issues"]').click();
    await expect(page).toHaveURL(origin + "/issues");
    await expect(page.locator('[data-navigation-module="crm"][aria-current="page"]:visible')).toHaveCount(1);
    await expect(page.locator("[data-navigation-context]")).toHaveAttribute("data-navigation-context", "crm");
    await page.goBack(); await expect(page).toHaveURL(origin + "/locations-pipeline");
    await page.goForward(); await expect(page).toHaveURL(origin + "/issues");
    await page.screenshot({ path: join(artifacts, "desktop-crm.png") });
    await noHorizontalOverflow(page);
  });
  await check("every visible destination for every role resolves to one active workspace in the browser", async () => {
    for (const role of appRoles) {
      const user = { id: "navigation-test", role, roles: [role], activeStatus: "active", teamMemberId: "self-member" };
      const modules = navigationForUser(user);
      const page = await pageFor(role);
      await at(page, modules[0].href, modules[0].id);
      const actual = await page.locator("[data-navigation-module]:visible").evaluateAll((links) => links.map((link) => link.dataset.navigationModule));
      assert.deepEqual(actual, modules.map((module) => module.id), role);
      for (const module of modules) for (const group of module.sections) for (const tab of group.tabs) {
        await page.evaluate((href) => { history.pushState(null, "", href); window.dispatchEvent(new PopStateEvent("popstate")); }, tab.href);
        const expected = navigationContextForUser(user, tab.href).location;
        await expect(page.locator("[data-navigation-context]")).toHaveAttribute("data-navigation-context", expected.module.id);
        await expect(page.locator("[data-navigation-module][aria-current=page]:visible")).toHaveCount(1);
        await expect(page.locator(`[data-navigation-module="${expected.module.id}"][aria-current=page]:visible`)).toHaveCount(1);
        for (const strip of await page.locator("[data-navigation-tabs]:visible").all()) await expect(strip.locator("[aria-current=page]")).toHaveCount(1);
      }
      await page.context().close();
    }
  });
  await check("legacy Finance purchase links stay in Inventory and Purchasing", async () => {
    const page = await pageFor("finance");
    await at(page, "/purchases/invoice?module=finance", "inventory");
    await expect(page.locator("[data-navigation-breadcrumbs]")).toContainText("Inventory & Purchasing");
    await expect(page.locator('[data-navigation-breadcrumbs] a[href="/inventory"]')).toHaveCount(0);
    await page.screenshot({ path: join(artifacts, "finance-purchases.png") });
  });
  await check("mobile drawer contains focus, closes on Escape, restores focus and navigates", async () => {
    const page = await pageFor("owner", "en", { width: 390, height: 844 });
    await at(page, "/locations-pipeline", "crm");
    await page.locator("main select").selectOption("/issues");
    await expect(page.locator("[data-navigation-context]")).toHaveAttribute("data-navigation-context", "crm");
    const toggle = page.locator("header button[aria-expanded]");
    await toggle.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    assert.equal(await page.locator("main").evaluate((element) => Boolean(element.closest("[inert]"))), true);
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press("Tab");
      assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0); await expect(toggle).toBeFocused();
    await toggle.click();
    await page.locator('[role=dialog] [data-navigation-module="inventory"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-navigation-context]")).toHaveAttribute("data-navigation-context", "inventory");
    await page.screenshot({ path: join(artifacts, "mobile-inventory.png") });
    await noHorizontalOverflow(page);
  });
  await check("Arabic RTL places the drawer on the right and switching language preserves entered notes", async () => {
    const page = await pageFor("owner", "en", { width: 360, height: 800 });
    await at(page, "/locations-pipeline", "crm");
    await page.getByTestId("draft").fill("Unsaved work stays here");
    await page.locator("header button").filter({ hasText: "عربي" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("draft")).toHaveValue("Unsaved work stays here");
    await page.locator("header button[aria-expanded]").click();
    const drawer = page.locator('[role=dialog] aside');
    const bounds = await drawer.boundingBox();
    assert.ok(bounds && Math.abs(bounds.x + bounds.width - 360) < 2);
    await page.screenshot({ path: join(artifacts, "mobile-arabic-drawer.png") });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: join(artifacts, "mobile-arabic-crm.png") });
    await noHorizontalOverflow(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(artifacts, "desktop-arabic.png") });
  });
  await check("small phones and tablets keep the header and menus within the viewport", async () => {
    for (const width of [320, 375, 768, 1024]) {
      const page = await pageFor("owner", "ar", { width, height: 850 });
      await at(page, "/admin/vms-api", "admin");
      await noHorizontalOverflow(page);
      await page.context().close();
    }
  });
  await check("sidebar collapse persists across reloads", async () => {
    const page = await pageFor();
    await at(page, "/finance", "finance");
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
    assert.ok((await page.locator("aside.app-sidebar:visible").boundingBox()).width <= 81);
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifacts, "desktop-collapsed.png") });
  });
  assert.deepEqual(errors, [], "No React/runtime errors should occur while navigating.");
  writeFileSync(join(artifacts, "results.json"), JSON.stringify({ scope: "Actual shell/i18n/CSS; isolated Next router and network boundaries", results, runtimeErrors: errors }, null, 2));
} catch (error) {
  for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: join(artifacts, `failure-${index}.png`) }).catch(() => {});
  writeFileSync(join(artifacts, "results.json"), JSON.stringify({ results, error: String(error), runtimeErrors: errors }, null, 2));
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
