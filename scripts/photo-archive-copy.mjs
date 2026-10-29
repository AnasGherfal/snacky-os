#!/usr/bin/env node
// node --experimental-strip-types scripts/photo-archive-copy.mjs --manifest reviewed.json
// Copy requires --copy --approve-sha256 <exact SHA shown by dry-run>. No removal mode exists.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { copyReviewedPhoto } from '../src/lib/photo-archive-copy.ts';
import { PhotoArchiveError, photoSha256, validateReviewedPhoto } from '../src/lib/photo-archive-core.ts';
import { boundedResponseBytes, createR2PhotoStore, photoArchiveConfig } from '../src/lib/photo-archive-r2.ts';

export function parseArchiveArgs(argv) {
  const options = { manifest: '', copy: false, approval: '', limit: 10 };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new PhotoArchiveError('archive_arguments_invalid');
    seen.add(arg);
    if (arg === '--copy') { options.copy = true; continue; }
    if (!['--manifest', '--approve-sha256', '--limit'].includes(arg) || !argv[i+1] || argv[i+1].startsWith('--')) throw new PhotoArchiveError('archive_arguments_invalid');
    const value = argv[++i];
    if (arg === '--manifest') options.manifest = value;
    if (arg === '--approve-sha256') options.approval = value;
    if (arg === '--limit') {
      if (!/^[1-9][0-9]*$/.test(value)) throw new PhotoArchiveError('archive_arguments_invalid');
      options.limit = Number(value);
    }
  }
  if (!options.manifest || options.limit > 200 || (options.copy && !/^[a-f0-9]{64}$/.test(options.approval))) throw new PhotoArchiveError('archive_arguments_invalid');
  return options;
}
export function parseArchiveManifest(bytes, now = new Date()) {
  if (bytes.byteLength > 1024 * 1024) throw new PhotoArchiveError('archive_manifest_invalid');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new PhotoArchiveError('archive_manifest_invalid'); }
  if (manifest?.version !== 1 || typeof manifest.reviewedBy !== 'string' || !manifest.reviewedBy.trim()
    || manifest.reviewedBy === 'REVIEW_REQUIRED' || manifest.reviewedBy.length > 160
    || !Array.isArray(manifest.photos) || !manifest.photos.length || manifest.photos.length > 200
    || !Number.isFinite(Date.parse(manifest.generatedAt)) || Date.parse(manifest.generatedAt) > now.getTime()
    || Date.parse(manifest.generatedAt) < now.getTime() - 7 * 86400000) throw new PhotoArchiveError('archive_manifest_invalid');
  const paths = new Set();
  const photos = manifest.photos.map(row => {
    if (!row || typeof row !== 'object') throw new PhotoArchiveError('archive_manifest_invalid');
    const photo = validateReviewedPhoto({ ...row, projectRef: manifest.projectRef }, now);
    if (paths.has(photo.path)) throw new PhotoArchiveError('archive_duplicate_path');
    paths.add(photo.path);
    return photo;
  });
  return { ...manifest, photos, sha256: photoSha256(bytes) };
}

/** GET/HEAD only: even a mistaken --copy invocation cannot remove a Supabase original. */
export function readOnlySupabaseSource(env, projectRef, fetcher = fetch) {
  const base = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const token = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base !== `https://${projectRef}.supabase.co` || !token || /[\r\n]/.test(token)) throw new PhotoArchiveError('archive_source_config_invalid');
  const headers = { apikey: token, authorization: `Bearer ${token}` };
  const url = photo => `${base}/storage/v1/object/authenticated/${photo.bucket}/${photo.path.split('/').map(encodeURIComponent).join('/')}`;
  async function request(photo, method, extra = {}) {
    try {
      const response = await fetcher(url(photo), { method, headers: { ...headers, ...extra }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new PhotoArchiveError(response.status === 412 ? 'archive_source_changed' : 'archive_source_read_failed');
      }
      return response;
    } catch (error) {
      if (error instanceof PhotoArchiveError) throw error;
      throw new PhotoArchiveError('archive_source_read_failed');
    }
  }
  return {
    async stat(photo) {
      const response = await request(photo, 'HEAD');
      const length = response.headers.get('content-length'), etag = response.headers.get('etag'), date = response.headers.get('last-modified');
      await response.body?.cancel();
      if (!length || !/^\d+$/.test(length) || !etag || !date || !Number.isFinite(Date.parse(date))) throw new PhotoArchiveError('archive_source_metadata_missing');
      return { bytes: Number(length), etag, updatedAt: new Date(date).toISOString() };
    },
    async read(photo, etag) {
      const response = await request(photo, 'GET', { 'if-match': etag });
      if (response.headers.get('etag') !== etag) { await response.body?.cancel(); throw new PhotoArchiveError('archive_source_changed'); }
      return boundedResponseBytes(response, photo.bytes);
    },
  };
}
export async function runArchiveCopy(argv, env = process.env, io = {}) {
  const options = parseArchiveArgs(argv);
  const readFile = io.readFile ?? fs.readFile, output = io.output ?? (value => console.log(JSON.stringify(value)));
  const manifest = parseArchiveManifest(await readFile(options.manifest), io.now ?? new Date());
  const selected = manifest.photos.slice(0, options.limit);
  output({ mode: options.copy ? 'copy_only' : 'dry_run', manifestSha256: manifest.sha256,
    projectRef: manifest.projectRef, filesSelected: selected.length, filesInManifest: manifest.photos.length,
    bytesSelected: selected.reduce((n, p) => n + p.bytes, 0), originalDeletionEnabled: false });
  if (!options.copy) return { copied: 0, dryRun: true };
  if (options.approval !== manifest.sha256) throw new PhotoArchiveError('archive_manifest_approval_mismatch');
  const config = photoArchiveConfig(env, true);
  if (config.projectRef !== manifest.projectRef) throw new PhotoArchiveError('archive_project_mismatch');
  const source = io.source ?? readOnlySupabaseSource(env, manifest.projectRef);
  const archive = io.archive ?? createR2PhotoStore(config);
  let copied = 0;
  for (const photo of selected) {
    const result = await copyReviewedPhoto(photo, manifest.sha256, source, archive, io.now ?? new Date());
    copied++;
    // No keys, signed URLs, or image contents in output. Preserve this report privately.
    output({ path: photo.path, bytes: result.receipt.bytes, sha256: result.receipt.sha256,
      state: result.state, replayed: result.replayed });
  }
  return { copied, dryRun: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runArchiveCopy(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error instanceof PhotoArchiveError ? error.code : 'archive_operation_failed', originalsDeleted: 0 }));
    process.exitCode = 1;
  });
}
