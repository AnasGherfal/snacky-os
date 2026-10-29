import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/lib/photo-archive-core.ts';
import { copyReviewedPhoto } from '../src/lib/photo-archive-copy.ts';
import { signedS3Headers, r2ObjectUrl, photoArchiveConfig, createR2PhotoStore, boundedResponseBytes } from '../src/lib/photo-archive-r2.ts';
import { parseArchiveArgs, parseArchiveManifest, readOnlySupabaseSource, runArchiveCopy } from './photo-archive-copy.mjs';

const now = new Date('2026-10-29T15:00:00Z');
const project = 'abcdefghijklmnopqrst';
const path = '10000000-0000-4000-8000-000000000001/old machine.jpg';
const photo = { projectRef: project, bucket: 'refill-photos', path, reviewed: true, sourceUpdatedAt: '2026-09-01T12:00:00.000Z', bytes: 8 };
const image = new Uint8Array([255,216,255,224,1,2,3,4]);
const snapshot = { bytes: 8, updatedAt: photo.sourceUpdatedAt, etag: '"source-1"' };
const manifestHash = 'a'.repeat(64);
const config = { accountId: 'a'.repeat(32), archiveBucket: 'snacky-photo-archive', projectRef: project, accessKeyId: 'reader', secretAccessKey: 'test-only-secret' };
function memory(options = {}) {
  const entries = new Map(), calls = [];
  let stats = 0;
  const source = {
    async stat() { stats++; calls.push('stat'); return options.changed && stats > 1 ? { ...snapshot, etag: '"changed"' } : { ...snapshot }; },
    async read(_p, etag) { calls.push('source-read'); assert.equal(etag, snapshot.etag); return image.slice(); },
  };
  const store = {
    async get(key) { calls.push(`get:${key.includes('/receipts/') ? 'receipt' : 'image'}`); const bytes = entries.get(key); return bytes ? bytes.slice() : null; },
    async putIfAbsent(key, bytes) {
      calls.push(`put:${key.includes('/receipts/') ? 'receipt' : 'image'}`);
      if (options.failPut) throw Error('write failed');
      if (entries.has(key)) return false;
      const stored = bytes.slice(); if (options.corrupt && key.includes('/objects/')) stored[4] ^= 1;
      entries.set(key, stored); return true;
    },
  };
  return { source, store, entries, calls };
}

test('S3 signing matches the complete published AWS GET Object test vector', () => {
  const headers = signedS3Headers('GET', new URL('https://examplebucket.s3.amazonaws.com/test.txt'), {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }, new Uint8Array(), { range: 'bytes=0-9' }, new Date('2013-05-24T00:00:00Z'), 'us-east-1');
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});
test('path traversal, encoded paths, other buckets and projects cannot select arbitrary archive content', () => {
  for (const p of ['/leading/a.jpg', '../file.jpg', path + '/..', path + '//file', path + '/%2e%2e', path + '?x', path + '\\bad', path + '\n', path + '/ ']) {
    assert.throws(() => core.receiptKey({ ...photo, path: p }));
  }
  assert.throws(() => core.receiptKey({ ...photo, bucket: 'cash-evidence' }));
  assert.throws(() => core.receiptKey({ ...photo, projectRef: '../' }));
  assert.ok(core.receiptKey({ ...photo, path: path.replace('old machine', 'صورة الماكينة') }).endsWith('.json'));
});
test('configuration is off by default, validates the Supabase project and prevents arbitrary R2 endpoints', () => {
  assert.equal(photoArchiveConfig({}), null);
  const env = { SNACKY_PHOTO_ARCHIVE_READ_ENABLED: 'true', SNACKY_PHOTO_ARCHIVE_ACCOUNT_ID: config.accountId, SNACKY_PHOTO_ARCHIVE_BUCKET: config.archiveBucket,
    SNACKY_PHOTO_ARCHIVE_PROJECT_REF: project, SNACKY_PHOTO_ARCHIVE_ACCESS_KEY_ID: 'read', SNACKY_PHOTO_ARCHIVE_SECRET_ACCESS_KEY: 'secret', NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co` };
  assert.equal(photoArchiveConfig(env).projectRef, project);
  assert.throws(() => photoArchiveConfig({ ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://another.invalid' }), /project_mismatch/);
  assert.throws(() => photoArchiveConfig({ ...env, SNACKY_PHOTO_ARCHIVE_ACCOUNT_ID: 'attacker.example.com' }));
  assert.throws(() => photoArchiveConfig(env, true), /config_invalid/, 'Reader credentials cannot silently become writer credentials');
  const url = r2ObjectUrl(config, `snacky-photo-archive/v1/${project}/refill-photos/receipts/a b!'().json`);
  assert.match(url.pathname, /a%20b%21%27%28%29.json$/);
  assert.throws(() => r2ObjectUrl(config, `snacky-photo-archive/v1/${project}/refill-photos/../cash`));
});
test('source stays read-only and receipt is committed only after copy readback and source recheck', async () => {
  const h = memory();
  const result = await copyReviewedPhoto(photo, manifestHash, h.source, h.store, now);
  assert.equal(result.state, 'copy_verified_source_retained'); assert.equal(result.replayed, false);
  assert.equal(h.entries.size, 2);
  assert.ok(h.calls.indexOf('put:receipt') > h.calls.indexOf('get:image'));
  assert.ok(h.calls.lastIndexOf('stat') < h.calls.indexOf('put:receipt'));
  assert.deepEqual((await core.readVerifiedArchivedPhoto(h.store, photo)).bytes, image);
});
test('rerunning the exact same copy is idempotent and does not overwrite image or receipt', async () => {
  const h = memory();
  await copyReviewedPhoto(photo, manifestHash, h.source, h.store, now);
  const writes = h.calls.filter(x => x.startsWith('put:')).length;
  assert.equal((await copyReviewedPhoto(photo, manifestHash, h.source, h.store, now)).replayed, true);
  assert.equal(h.calls.filter(x => x.startsWith('put:')).length, writes);
});
test('archive corruption or source changes never publish a verified receipt', async () => {
  for (const options of [{ corrupt: true }, { changed: true }, { failPut: true }]) {
    const h = memory(options);
    await assert.rejects(copyReviewedPhoto(photo, manifestHash, h.source, h.store, now));
    assert.equal(h.entries.has(core.receiptKey(photo)), false);
    assert.equal('remove' in h.source, false);
  }
});
test('changed source on a reused path cannot replace an old immutable receipt', async () => {
  const h = memory(); await copyReviewedPhoto(photo, manifestHash, h.source, h.store, now);
  const before = h.entries.get(core.receiptKey(photo)).slice();
  h.source.read = async () => new Uint8Array([255,216,255,224,9,9,9,9]);
  await assert.rejects(copyReviewedPhoto(photo, manifestHash, h.source, h.store, now), /version_conflict/);
  assert.deepEqual(h.entries.get(core.receiptKey(photo)), before);
});
test('unreviewed, recent, wrong-sized or oversized source is rejected before copying', async () => {
  for (const changed of [{ reviewed: false }, { sourceUpdatedAt: now.toISOString() }, { bytes: 0 }, { bytes: 11e6 }, { sourceUpdatedAt: 'bad' }]) {
    const h = memory(); await assert.rejects(copyReviewedPhoto({ ...photo, ...changed }, manifestHash, h.source, h.store, now)); assert.equal(h.calls.length, 0);
  }
  const h = memory(); await assert.rejects(copyReviewedPhoto({ ...photo, bytes: 9 }, manifestHash, h.source, h.store, now), /source_changed/);
});
test('malformed receipt, wrong path/project, missing data and hash mismatches fail closed', async () => {
  const h = memory(); await copyReviewedPhoto(photo, manifestHash, h.source, h.store, now);
  const raw = h.entries.get(core.receiptKey(photo)), receipt = JSON.parse(new TextDecoder().decode(raw));
  for (const delta of [{ projectRef: 'z'.repeat(20) }, { path: path + 'x' }, { bytes: 10e9 }, { contentType: 'text/html' }, { sha256: 'bad' }, { contentKey: 'other' }, { version: 2 }, { sourceEtag: null }]) {
    assert.throws(() => core.decodeArchiveReceipt(new TextEncoder().encode(JSON.stringify({ ...receipt, ...delta })), photo));
  }
  h.entries.delete(receipt.contentKey);
  await assert.rejects(core.readVerifiedArchivedPhoto(h.store, photo), /content_missing/);
  h.entries.set(receipt.contentKey, new Uint8Array(8));
  await assert.rejects(core.readVerifiedArchivedPhoto(h.store, photo), /integrity_failed/);
  assert.equal(await core.readVerifiedArchivedPhoto(h.store, { ...photo, path: path + 'x' }), null);
});
test('active HTML, SVG and mismatched MIME data cannot be served from the archive', () => {
  for (const value of ['<html>private</html>', '<svg onload="alert(1)"/>']) assert.throws(() => core.photoContentType(new TextEncoder().encode(value)));
  assert.equal(core.photoContentType(image), 'image/jpeg');
  assert.equal(core.photoContentType(new Uint8Array([137,80,78,71,13,10,26,10])), 'image/png');
  assert.equal(core.photoContentType(new TextEncoder().encode('RIFF0000WEBP0000')), 'image/webp');
});
test('archive fallback only recognizes definite object-not-found, never auth or network errors', () => {
  for (const error of [{ statusCode: '404', message: 'Object not found' }, { statusCode: 400, code: 'NoSuchKey' }]) assert.equal(core.isMissingStorageObject(error), true);
  for (const error of [null, { statusCode: 403, message: 'Object not found' }, { statusCode: 500, code: 'NoSuchKey' }, { statusCode: 404, message: 'Bucket not found' }, { message: 'fetch failed' }]) assert.equal(core.isMissingStorageObject(error), false);
});
test('bounded downloads reject oversized headers, oversized streams and truncated bodies', async () => {
  assert.deepEqual(await boundedResponseBytes(new Response(image), 8), image);
  await assert.rejects(boundedResponseBytes(new Response(image, { headers: { 'content-length': '99999999' } }), 8));
  await assert.rejects(boundedResponseBytes(new Response(image), 4));
  await assert.rejects(boundedResponseBytes(new Response(image, { headers: { 'content-length': '9' } }), 10), /truncated/);
});
test('R2 adapter uses conditional create, signed payloads, no redirects and no delete method', async () => {
  const requests = [], h = createR2PhotoStore(config, async (url, init) => { requests.push({ url, init }); return new Response(null, { status: init.method === 'GET' ? 404 : 412 }); });
  const key = core.receiptKey(photo);
  assert.equal(await h.get(key, 100), null);
  assert.equal(await h.putIfAbsent(key, image, 'image/jpeg'), false);
  assert.equal(requests[1].init.headers['if-none-match'], '*');
  assert.equal(requests[1].init.headers['x-amz-content-sha256'], core.photoSha256(image));
  assert.ok(requests.every(x => x.init.redirect === 'error' && x.init.signal));
  assert.equal('remove' in h, false);
  const denied = createR2PhotoStore(config, async () => new Response('secret provider diagnostic', { status: 403 }));
  await assert.rejects(denied.get(key, 100), error => error.message === 'archive_read_failed');
});
test('copy command rejects delete flags and defaults to a bounded dry run without network or credentials', async () => {
  assert.equal(parseArchiveArgs(['--manifest','test.json']).copy, false);
  for (const flags of [['--delete'], ['--copy'], ['--limit','1000'], ['--limit','0'], ['--manifest','another']]) assert.throws(() => parseArchiveArgs(['--manifest','a', ...flags]));
  const raw = new TextEncoder().encode(JSON.stringify({ version: 1, projectRef: project, generatedAt: now.toISOString(), reviewedBy: 'Owner', photos: [photo] }));
  const lines = [];
  const result = await runArchiveCopy(['--manifest','test'], {}, { readFile: async () => raw, now, output: x => lines.push(x) });
  assert.equal(result.dryRun, true); assert.equal(result.copied, 0); assert.equal(lines[0].originalDeletionEnabled, false);
  await assert.rejects(runArchiveCopy(['--manifest','test','--copy','--approve-sha256','f'.repeat(64)], {}, { readFile: async () => raw, now, output() {} }), /approval_mismatch/);
  const duplicate = JSON.parse(new TextDecoder().decode(raw)); duplicate.photos.push(photo);
  assert.throws(() => parseArchiveManifest(new TextEncoder().encode(JSON.stringify(duplicate)), now), /duplicate_path/);
});
test('Supabase adapter supports only HEAD/GET, checks etag, and refuses source credentials on arbitrary hosts', async () => {
  assert.throws(() => readOnlySupabaseSource({ SUPABASE_URL: 'https://attacker.invalid', SUPABASE_SERVICE_ROLE_KEY: 'secret' }, project));
  const calls = [], source = readOnlySupabaseSource({ SUPABASE_URL: `https://${project}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'secret' }, project, async (_url, options) => {
    calls.push(options); return new Response(options.method === 'HEAD' ? null : image, { headers: { 'content-length': '8', etag: '"source-1"', 'last-modified': 'Tue, 01 Sep 2026 12:00:00 GMT' } });
  });
  assert.deepEqual(await source.stat(photo), snapshot);
  assert.deepEqual(await source.read(photo, snapshot.etag), image);
  assert.deepEqual(calls.map(c => c.method), ['HEAD','GET']); assert.equal(calls[1].headers['if-match'], snapshot.etag);
});

function routeHarness(options = {}) {
  const events = [];
  const compiled = ts.transpileModule(fs.readFileSync('src/app/api/storage/[bucket]/[...path]/route.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const profile = options.loggedOut ? null : { active_status: options.inactive ? 'inactive' : 'active', role: options.operator ? 'operator' : 'owner', team_member_id: 'member' };
  const imports = {
    'next/server': { NextResponse: { json: (body, opts) => new Response(JSON.stringify(body), { status: opts.status }), redirect: url => new Response(null, { status: 307, headers: { Location: url } }) } },
    '@/lib/auth': { getCurrentProfile: async () => { events.push('auth'); return profile; } },
    '@/lib/authz': { hasAnyRole: p => p?.role === 'owner', isOwnerAdminRole: p => p?.role === 'owner', isSupervisorRole: () => false, isOperatorRole: p => p?.role === 'operator', canAccessOperatorRoute: (_profile, operator) => operator === 'member', canViewVmsImports: () => false },
    '@/lib/operator-route-access': { buildOperatorRouteAccessContext: async (_s, p) => p },
    '@/lib/supabase-server': { getSupabaseAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { operator_id: options.otherRoute ? 'someone-else' : 'member' } }) }) }) }),
      storage: { from: () => ({ createSignedUrl: async () => { events.push('supabase'); return options.storage ?? { data: null, error: { statusCode: 404, message: 'Object not found' } }; } }) } }) },
    '@/lib/photo-archive-server': { archivedPhotoResponse: async () => { events.push('archive'); if (options.corrupt) throw Error('corrupt'); return options.noArchive ? null : new Response(image, { headers: { 'X-Snacky-Photo-Source': 'verified-private-archive' } }); } },
    '@/lib/photo-archive-core': { isMissingStorageObject: core.isMissingStorageObject },
    '@/lib/storage-buckets': { PRIVATE_STORAGE_BUCKETS: new Set(['refill-photos','receipt-images']), REFILL_PHOTO_BUCKET: 'refill-photos', ISSUE_PHOTO_BUCKET: 'issue-photos', CASH_EVIDENCE_BUCKET: 'cash-evidence', MACHINE_PHOTO_BUCKET: 'machine-photos', RECEIPT_IMAGE_BUCKET: 'receipt-images', VMS_IMPORT_BUCKET: 'vms-imports' },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, require: name => { assert.ok(imports[name],name); return imports[name]; } });
  return { events, get: (bucket = photo.bucket, query = '') => exports.GET(new Request(`https://snacky.invalid/api/storage/${bucket}/${path}${query}`), { params: Promise.resolve({ bucket, path: path.split('/') }) }) };
}
test('unauthenticated, inactive and unassigned operators cannot probe an archive even in verification mode', async () => {
  for (const options of [{ loggedOut: true }, { inactive: true }, { operator: true, otherRoute: true }]) {
    const h = routeHarness(options); assert.equal((await h.get(photo.bucket, '?archive=verify')).status, 403); assert.equal(h.events.includes('archive'), false);
  }
});
test('normal photo still uses Supabase; verified archive handles missing photo after original authorization', async () => {
  const normal = routeHarness({ storage: { data: { signedUrl: 'https://signed.invalid/photo' }, error: null } });
  assert.equal((await normal.get()).status, 307); assert.equal(normal.events.includes('archive'), false);
  const archived = routeHarness(); assert.equal((await archived.get()).status, 200);
  assert.ok(archived.events.indexOf('archive') > archived.events.indexOf('auth'));
});
test('archive errors are 503 not fake success; no fallback for unauthorized/upstream errors or protected buckets', async () => {
  assert.equal((await routeHarness({ corrupt: true }).get()).status, 503);
  assert.equal((await routeHarness({ noArchive: true }).get()).status, 404);
  for (const storage of [{ data: null, error: { statusCode: 403, message: 'Denied' } }, { data: null, error: { statusCode: 500, message: 'Network' } }]) {
    const h = routeHarness({ storage }); await h.get(); assert.equal(h.events.includes('archive'), false);
  }
  const receipts = routeHarness(); await receipts.get('receipt-images'); assert.equal(receipts.events.includes('archive'), false);
});
test('verification rehearsal tests the archive before deletion without changing or bypassing photo permissions', async () => {
  const h = routeHarness({ operator: true }); const result = await h.get(photo.bucket, '?archive=verify');
  assert.equal(result.status, 200); assert.equal(h.events.includes('supabase'), false); assert.equal(h.events.includes('archive'), true);
});
test('archive-serving wrapper is server-only and sends no-store/nosniff instead of a public redirect', () => {
  const s = fs.readFileSync('src/lib/photo-archive-server.ts','utf8');
  assert.match(s,/import "server-only"/); assert.match(s,/private, no-store/); assert.match(s,/nosniff/); assert.doesNotMatch(s,/redirect\(/);
});


test('concurrent identical copies retain one receipt and one immutable original', async () => {
  const h = memory();
  const result = await Promise.all([copyReviewedPhoto(photo, manifestHash, h.source, h.store, now), copyReviewedPhoto(photo, manifestHash, h.source, h.store, now)]);
  assert.equal(result.length, 2); assert.equal(h.entries.size, 2);
  assert.deepEqual((await core.readVerifiedArchivedPhoto(h.store, photo)).bytes, image);
});
test('approved CLI copy runs only the selected manifest and reports source retained', async () => {
  const h = memory(), outputs = [];
  const raw = new TextEncoder().encode(JSON.stringify({ version: 1, projectRef: project, generatedAt: now.toISOString(), reviewedBy: 'Owner', photos: [photo] }));
  const env = { SNACKY_PHOTO_ARCHIVE_ACCOUNT_ID: config.accountId, SNACKY_PHOTO_ARCHIVE_BUCKET: config.archiveBucket,
    SNACKY_PHOTO_ARCHIVE_PROJECT_REF: project, SNACKY_PHOTO_ARCHIVE_WRITE_ACCESS_KEY_ID: 'writer', SNACKY_PHOTO_ARCHIVE_WRITE_SECRET_ACCESS_KEY: 'test-secret',
    SUPABASE_URL: `https://${project}.supabase.co` };
  const result = await runArchiveCopy(['--manifest','private.json','--copy','--approve-sha256', core.photoSha256(raw)], env, {
    now, readFile: async () => raw, source: h.source, archive: h.store, output: x => outputs.push(x),
  });
  assert.equal(result.copied, 1); assert.equal(outputs[1].state, 'copy_verified_source_retained');
  assert.equal(JSON.stringify(outputs).includes('test-secret'), false);
});
