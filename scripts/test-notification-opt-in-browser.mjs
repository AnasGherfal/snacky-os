// Isolated component tests: no production credentials, DB writes, or real pushes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const output = resolve('artifacts/notification-opt-in');
await mkdir(output, { recursive: true });
const bundled = await build({
  stdin: {
    contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {NotificationOptInPrompt} from './src/components/NotificationOptInPrompt';
      import {NotificationActivationCard} from './src/components/NotificationActivationCard';
      const root = createRoot(document.getElementById('root'));
      window.mountInvite = userId => root.render(React.createElement(NotificationOptInPrompt, {userId}));
      window.mountSettings = () => root.render(React.createElement(NotificationActivationCard));
      window.mountInvite(new URLSearchParams(location.search).get('user') || 'test-user');`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'isolated-context',
    setup(b) {
      b.onResolve({ filter: /^@\/components\/I18nProvider$/ }, () => ({ path: 'language', namespace: 'mock' }));
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
        contents: path === 'language'
          ? `export const useLanguage = () => ({locale: new URLSearchParams(location.search).get('lang') || 'en'});`
          : `export const usePathname = () => new URLSearchParams(location.search).get('path') || '/my-work';`,
        loader: 'js',
      }));
    },
  }],
});
const css = (await postcss([tailwind()]).process(await readFile('src/app/globals.css', 'utf8'), { from: resolve('src/app/globals.css') })).css;
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundled.outputFiles[0].text); return; }
  if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main style="padding:12px;max-width:900px;margin:auto"><div id="root"></div><button class="btn-secondary" id="work" onclick="window.workClicked=true">Continue work</button></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let count = 0;

async function scenario(name, options, action) {
  const context = await browser.newContext({ viewport: { width: options.width || 390, height: 844 }, ...(options.ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1' } : {}) });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(initial => {
    window.mockPush = { permission: initial.permission || 'default', requests: 0, subscribes: 0, subscription: Boolean(initial.subscription) };
    const state = window.mockPush;
    const subscription = {
      endpoint: 'https://example.com/push/test',
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      toJSON: () => ({ endpoint: 'https://example.com/push/test', keys: { p256dh: 'mock', auth: 'mock' } }),
      unsubscribe: async () => { state.subscription = false; return true; },
    };
    const registration = { pushManager: {
      getSubscription: async () => state.subscription ? subscription : null,
      subscribe: async () => { state.subscribes++; state.subscription = true; return subscription; },
    } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration) } });
    Object.defineProperty(window, 'Notification', { configurable: true, value: {
      get permission() { return state.permission; },
      requestPermission: async () => { state.requests++; state.permission = initial.answer || 'granted'; return state.permission; },
    } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    if (initial.unsupported) delete window.PushManager;
    if (initial.standalone) Object.defineProperty(navigator, 'standalone', { value: true });
    if (initial.ipad) {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    }
  }, options);
  let registered = Boolean(options.registered);
  let saves = 0;
  let statusChecks = 0;
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    let body = {};
    let status = 200;
    if (url.pathname.endsWith('/push-status')) {
      statusChecks++;
      if (options.statusError) { status = 503; body = { error: 'Unavailable' }; }
      else body = { configured: options.configured !== false, schemaReady: true, publicKey: 'AQID', activeSubscriptions: 9, deviceRegistered: req.method() === 'POST' && registered };
    } else if (url.pathname === '/api/push-subscriptions' && req.method() === 'POST') {
      saves++;
      if (options.saveError) { status = 503; body = { error: 'Test save failed' }; }
      else if (options.conflict && saves === 1) { status = 409; body = { error: 'Owned by previous session' }; }
      else { registered = true; body = { saved: true }; }
    } else if (url.pathname === '/api/push-subscriptions' && req.method() === 'DELETE') {
      registered = false; body = { disabled: true };
    } else if (url.pathname === '/api/notifications/test') body = { sent: true, acceptedCount: 1 };
    else { status = 404; body = { error: 'Unknown test endpoint' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(`${base}/?lang=${options.lang || 'en'}&path=${encodeURIComponent(options.path || '/my-work')}`);
    await action(page, { saves: () => saves, checks: () => statusChecks });
    assert.deepEqual(pageErrors, []);
    console.log(`PASS: ${name}`); count++;
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${name.replaceAll(/[^a-z0-9]/gi, '-')}.png`, fullPage: true });
    throw error;
  } finally { await context.close(); }
}
const invite = page => page.getByTestId('notification-opt-in');
const visible = page => invite(page).waitFor({ state: 'visible', timeout: 10000 });
async function hidden(page) { await page.waitForTimeout(1900); assert.equal(await invite(page).count(), 0); }
const requests = page => page.evaluate(() => window.mockPush.requests);

try {
  await scenario('tap required then server-confirmed success and test', {}, async (page, stats) => {
    await visible(page);
    assert.equal(await requests(page), 0);
    assert.equal(stats.saves(), 0);
    await page.getByRole('button', { name: 'Continue work', exact: true }).click();
    assert.equal(await page.evaluate(() => window.workClicked), true);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Test notification', exact: true }).waitFor();
    assert.equal(await requests(page), 1);
    assert.equal(stats.saves(), 1);
    await page.getByRole('button', { name: 'Test notification', exact: true }).click();
    await page.getByText('The push service accepted the test.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await hidden(page);
    await page.reload(); await hidden(page);
  });
  await scenario('registered device never prompted', { permission: 'granted', subscription: true, registered: true }, async page => {
    await hidden(page); assert.equal(await requests(page), 0);
  });
  await scenario('granted but unregistered device reconnects', { permission: 'granted', subscription: true }, async (page, stats) => {
    await visible(page);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Test notification', exact: true }).waitFor();
    assert.equal(await requests(page), 0); assert.equal(stats.saves(), 1);
  });
  await scenario('Later survives reload; different user gets own invitation', {}, async page => {
    await visible(page);
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    await hidden(page); await page.reload(); await hidden(page);
    assert.equal(await requests(page), 0);
    await page.evaluate(() => window.mountInvite('second-user'));
    await visible(page);
  });
  await scenario('denied permission only offers settings guidance', { permission: 'denied' }, async page => {
    await visible(page);
    await page.getByRole('button', { name: 'How to allow', exact: true }).click();
    await page.getByRole('button', { name: 'Recheck', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Enable notifications', exact: true }).count(), 0);
    assert.equal(await requests(page), 0);
  });
  await scenario('declining the native prompt never registers device', { answer: 'denied' }, async (page, stats) => {
    await visible(page);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'How to allow', exact: true }).waitFor();
    assert.equal(await requests(page), 1); assert.equal(stats.saves(), 0);
    await page.getByRole('button', { name: 'Continue work', exact: true }).click();
  });
  await scenario('failed server registration cannot show success', { saveError: true }, async (page, stats) => {
    await visible(page);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByText('Test save failed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Test notification', exact: true }).count(), 0);
    assert.equal(stats.saves(), 1);
  });
  await scenario('subscription ownership conflict safely retries', { conflict: true }, async (page, stats) => {
    await visible(page);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Test notification', exact: true }).waitFor();
    assert.equal(stats.saves(), 2);
  });
  for (const options of [{ ios: true }, { ipad: true }]) {
    await scenario(options.ios ? 'iPhone browser offers installation guidance' : 'desktop-mode iPad offers installation guidance', options, async page => {
      await visible(page);
      await page.getByRole('button', { name: 'How to install', exact: true }).click();
      await page.getByText('From your browser', { exact: false }).waitFor();
      assert.equal(await requests(page), 0);
    });
  }
  await scenario('installed iPhone can opt in', { ios: true, standalone: true }, async page => {
    await visible(page);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Test notification', exact: true }).waitFor();
    assert.equal(await requests(page), 1);
  });
  for (const options of [{ unsupported: true }, { configured: false }, { statusError: true }]) {
    await scenario(`unavailable ${Object.keys(options)[0]} is unobtrusive`, options, async page => {
      await hidden(page); assert.equal(await requests(page), 0);
      await page.getByRole('button', { name: 'Continue work', exact: true }).click();
    });
  }
  for (const path of ['/login', '/account', '/notifications']) {
    await scenario(`no duplicate invitation on ${path}`, { path }, async (page, stats) => {
      await hidden(page); assert.equal(stats.checks(), 0);
    });
  }
  await scenario('manual device disable is respected', { permission: 'granted', subscription: true, registered: true }, async page => {
    await hidden(page);
    await page.evaluate(() => window.mountSettings());
    await page.getByRole('button', { name: 'Disable this device', exact: true }).click();
    await page.getByText('Notifications are disabled for this device only.', { exact: true }).waitFor();
    await page.evaluate(() => window.mountInvite('test-user'));
    await hidden(page);
    await page.reload(); await hidden(page);
  });
  for (const width of [320, 390, 1280]) {
    await scenario(`Arabic RTL layout ${width}`, { lang: 'ar', width }, async page => {
      await visible(page);
      assert.equal(await invite(page).getAttribute('dir'), 'rtl');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      for (const button of await invite(page).getByRole('button').all()) {
        assert.ok((await button.boundingBox()).height >= 44);
      }
      await page.screenshot({ path: `${output}/arabic-${width}.png`, fullPage: true });
    });
  }
  console.log(`PASS: ${count} browser scenarios (mock APIs; physical notification display still requires a real device).`);
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
