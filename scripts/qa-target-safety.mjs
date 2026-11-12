/** Fixture writes are permitted only on a disposable loopback app/database pair.
 * This is test infrastructure, not application authorization or a production bypass.
 */
import assert from 'node:assert/strict';
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function assertDisposableQaTarget({ appUrl, databaseUrl, deploymentEnvironment }) {
  assert.notEqual(deploymentEnvironment, 'production', 'Fixture writes must not run in production.');
  const app = new URL(appUrl), db = new URL(databaseUrl);
  for (const [name, url] of [['app', app], ['database', db]]) {
    assert.equal(url.protocol, 'http:', `${name} must be a local HTTP endpoint.`);
    assert.ok(loopback.has(url.hostname), `${name} must be an explicit loopback address.`);
    assert.equal(url.username + url.password + url.search + url.hash, '', `${name} must not contain credentials, query or fragment.`);
    assert.equal(url.pathname, '/', `${name} must be an origin, not a path.`);
  }
  assert.equal(db.port, '54321', 'Only the disposable local Supabase port is allowed.');
  assert.ok(['3000', '3001'].includes(app.port), 'Only the isolated test application ports are allowed.');
  return { appOrigin: app.origin, databaseOrigin: db.origin };
}
export async function fetchLocalQaPage(baseUrl, path, cookie, redirect = 'follow') {
  const base = new URL(baseUrl);
  assert.ok(loopback.has(base.hostname) && base.protocol === 'http:', 'Local QA requests only.');
  let url = new URL(path, base);
  for (let hop = 0; hop < 5; hop++) {
    assert.equal(url.origin, base.origin, 'A test redirect must not forward authentication outside the local app.');
    const response = await fetch(url, { redirect: 'manual', headers: { cookie }, signal: AbortSignal.timeout(30000) });
    if (redirect === 'manual' || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    assert.ok(location, 'Redirect response is missing Location.');
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error('QA navigation exceeded its redirect limit.');
}
export function assertRenderedQaPage({ status, finalUrl, contentType, body }, baseUrl, label) {
  const final = new URL(finalUrl), base = new URL(baseUrl);
  assert.equal(status, 200, `${label} must render successfully, not return an error or redirect.`);
  assert.equal(final.origin, base.origin, `${label} escaped the test origin.`);
  assert.doesNotMatch(final.pathname, /^\/(?:login|unauthorized|change-password)(?:\/|$)/, `${label} did not reach an authorized page.`);
  assert.match(contentType ?? '', /^text\/html\b/i, `${label} must return an HTML page.`);
  assert.match(body, /<main\b/i, `${label} did not render the application content.`);
  assert.doesNotMatch(body, /Application error|Server Components render|NEXT_HTTP_ERROR_FALLBACK;(?:403|404)|id=["']__next_error__/i, `${label} rendered an error document.`);
}
