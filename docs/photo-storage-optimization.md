# Photo storage: reduce uploads first, preserve evidence when archiving

## Implemented in this change

The machine quick-photo and compressor-photo cards previously uploaded original camera files. Both now call `prepareRefillPhoto` before the existing authenticated upload and persistence workflow. The main route-stop screen already has its own 850 KiB target preparation; this change preserves that existing implementation. Quantity screenshots, cash evidence, receipts and issue photos are not passed through the new lossy camera encoder.

The new camera encoder targets 400 KiB and accepts at most 900 KiB after preparation. It preserves the full frame/aspect ratio, never enlarges a photo, starts at a 2,000-pixel long edge and does not reduce a large input below 1,600 pixels just to hit a target. WebP is preferred; browsers without that encoder use JPEG. Quality is never lower than 0.78. A detailed photo can exceed the 400 KiB target, but not the 900 KiB hard preparation limit. An unsupported or oversized result produces a visible retry message rather than quietly uploading the original.

Small files can retain their original bytes. Same-file retries reuse the exact prepared File; the existing server-side SHA filename, route authorization, private bucket, and confirmed-save requirements remain unchanged. No automatic deletion is added. Older clients and the separate main-screen preparation retain their previous server allowance: this is not a bucket-wide hard cap.

No new application dependency, database migration, storage policy or production setting is required for this upload-only change. Normal app deployment is still required. Local unit tests and a synthetic-image real Chromium test do not establish camera legibility for every operator's phone. Verify a real machine overview and readable compressor controls on representative phones in preview before release.

## What the live read-only audit found

29 October 2026: the refill bucket had 1,058 files, 1,204,769,539 bytes. Of these, 787 files / 879,047,593 bytes were created more than 30 days ago. That is an age inventory, not an authorization to delete them.

The reference-aware triage identified:

| Category | Files | Bytes |
| --- | ---: | ---: |
| Safety, quantity or issue proof | 517 | 818,108,310 |
| Hold for route, issue or legacy review | 190 | 136,356,838 |
| Routine old photos to review for archival | 155 | 98,138,859 |
| Recent ordinary photos | 110 | 82,278,950 |
| No link found in primary photo tables; needs investigation | 85 | 69,855,827 |
| Latest machine photo retained | 1 | 30,755 |

`scripts/sql/refill-photo-retention-report.sql` reproduces this READ-ONLY triage. It also considers `updated_at`: an old object recently replaced is not treated as stale. This is intentionally not a complete orphan detector. References in audit logs, serialized completion receipts, free-text notes or encoded legacy URLs can exist beyond these primary tables. Never delete the 85 unlinked candidates merely because this report did not find a primary link.

## Recommended archival policy — reader and copy-only stage implemented; not activated

Use private Cloudflare R2 **Standard** object storage for historical photos, not a public bucket, and not a second Supabase bucket (which shares the same quota). Keep the latest 30 days and current/open operational evidence in the fast path. Archive older ordinary photographs without destroying history; safety/quantity evidence may only move bit-for-bit with authenticated retrieval and audit links preserved. Cash evidence, receipts, issue/dispute proof and documents remain outside any routine automatic deletion policy.

Archive sequence must be resumable and fail closed:

1. Produce an owner-reviewed manifest with bucket/path, source version, original byte length, SHA-256, proof type, all references and holds. Missing information blocks removal.
2. Copy to the private archive; download the archive copy and verify its byte length and SHA-256 against the source. An ETag alone is not sufficient proof of identical bytes.
3. Verify the existing authenticated `/api/storage/...` route can retrieve archived objects without widening permissions. Preserve old record IDs/URLs; do not erase completed-route records or audit events. The archive-aware reader and permission tests are now included, but must be deployed and verified with a private canary before any removal.
4. Recheck the source version and holds, write a durable archive receipt, and only then remove the Supabase copy through the Storage API. Never use SQL DELETE on `storage.objects`.
5. A failed copy, hash check, read test or reference check leaves the Supabase object untouched. No automatic permanent archive deletion is proposed.

Do not overwrite digest-named evidence files with different image bytes: that would invalidate the meaning of the existing fingerprint. Existing evidence is either copied bit-for-bit or transformed as a separately identified derivative with a retained source and explicit audit metadata.

Cloudflare's current Standard free tier includes 10 GB-month plus operation allowances; source-provider egress and operation usage must be checked before bulk copying. No archive account, bucket, billing change, scheduled transfer, or removal has been set up by this change. The copy-only implementation below is inactive until configured.

## Verification and release

Run the focused tests, photo-persistence/stop regressions and typecheck. The photo CI job also runs a synthetic encoder test in Chromium and WebKit, without live credentials. Full application CI and a real-phone preview check remain release gates. This code reduces *new uploads after deployment*; it does not reclaim the existing 1.48 GB automatically. Database disk usage is a separate capacity issue and is unaffected by photo compression.

Official references checked 29 October 2026:
- https://supabase.com/docs/guides/storage/management/delete-objects
- https://supabase.com/docs/guides/storage/schema/design
- https://developers.cloudflare.com/r2/pricing/


## Second implementation stage: private archive reader and copy rehearsal

Added a server-only R2 reader behind the existing `/api/storage/[bucket]/[...path]` authorization. It is **off by default** and restricted to `refill-photos`; cash evidence, receipts, issues and documents are not redirected. Normal available photos keep their existing Supabase signed URL flow. Archive fallback runs only for definite object-not-found errors, not authorization failures or provider outages.

An authorized user can append `?archive=verify` to the existing photo URL to rehearse an archived read while the original still exists. This uses exactly the same authentication, active-user, role and route-assignment checks as normal photo access. It is read-only. The server returns the verified image bytes with private/no-store and nosniff headers; it never sends R2 credentials or a public R2 URL to the browser. Missing/corrupt receipts, wrong object identities, altered content and oversized responses fail closed.

### Storage layout and integrity

No schema migration or extra PostgreSQL table is needed. Immutable private JSON receipts live alongside content-addressed originals in R2, namespaced by Supabase project and source bucket. Each receipt binds original bucket/path, SHA-256, byte length, detected image MIME type, source ETag/Last-Modified and reviewed-manifest fingerprint. A previously archived path with a conflicting source version is rejected, not silently overwritten. The source database metadata/history is unchanged.

The minimal R2 adapter uses Node's crypto and fetch: no new dependencies. It supports only GET and conditional PUT, has a fixed validated Cloudflare endpoint, uses the R2 `auto` region, times out requests, refuses redirects and bounds download sizes. SigV4 is checked against AWS's complete published GET Object signature vector. A live private-bucket integration test is still required; offline tests are not evidence that account configuration works.

### Configuration, not yet performed

1. Create a private R2 Standard bucket named `snacky-photo-archive`. Leave `r2.dev`, custom-domain public access and lifecycle expiration disabled. R2 data is not to be made public.
2. Make a bucket-scoped **Object Read** token for the app server; separately make a bucket-scoped **Object Read & Write** token for the copy runner. Do not put the writer token in Vercel/app environments.
3. Configure the variables from `deployment/photo-archive.env.example` in server settings, never in chat, repository files or client JavaScript. `SNACKY_PHOTO_ARCHIVE_PROJECT_REF` must match the existing Supabase URL. The reader is disabled unless `SNACKY_PHOTO_ARCHIVE_READ_ENABLED=true`.
4. Deploy to a protected preview, copy one approved old routine photo and open its existing URL with `?archive=verify` as an owner and an assigned operator. An unassigned operator/logged-out user must still be denied. Inspect actual legibility and verify downloaded hash/length. Then repeat the canary with the released app. No original should be removed during this rehearsal.

### Reviewed copy manifest and commands

The read-only retention report remains only triage, not automatic permission to remove anything. Review the source record, references, unresolved incidents and current/latest-photo use before building a manifest. Include at most 200 explicitly reviewed paths per manifest, with actual byte counts and source last-update timestamps. `generatedAt` must be within the last seven days. A recent/updated file (less than 30 days) is rejected by the copy tool. Inspect 10 at a time initially.

Manifest shape (replace examples with actual inspected values):

```json
{
  "version": 1,
  "projectRef": "<20-character project ref>",
  "generatedAt": "<current ISO timestamp>",
  "reviewedBy": "<reviewer>",
  "photos": [
    {
      "bucket": "refill-photos",
      "path": "<route UUID>/<exact object name>",
      "bytes": 123456,
      "sourceUpdatedAt": "<verified source timestamp>",
      "reviewed": true
    }
  ]
}
```

```sh
# No network access or credentials used in dry-run; validates manifest and prints its SHA.
node --experimental-strip-types scripts/photo-archive-copy.mjs --manifest reviewed.json --limit 10
# Run only in the controlled runner environment configured above.
node --experimental-strip-types scripts/photo-archive-copy.mjs --manifest reviewed.json --limit 10 --copy --approve-sha256 <exact-manifest-sha>
```

Copy mode checks current source size/Last-Modified/ETag, conditionally downloads that version, copies the exact bytes, downloads and hashes the R2 copy, rechecks the source version, and only then publishes an immutable receipt. Same-copy retries reuse verified archive objects. Partial copies do not create a usable receipt; a failed step leaves the Supabase original untouched. Reports contain `copy_verified_source_retained`, not `migrated` or `space_reclaimed`.

**There is deliberately no delete/release mode, cron, or blanket lifecycle expiration in this stage.** Copying without removing originals does not reduce Supabase usage. A separate controlled release stage still needs fresh holds/reference checks, verified deployed-reader canaries, an explicit exact removal manifest, concurrency safeguards against source changes, and removal through the Storage API. Until that exists and is approved, do not delete source objects manually merely because a copy receipt exists. Receipt integrity is not a deletion authorization.

### Local/CI verification for archive additions

`node --experimental-strip-types --test scripts/test-photo-archive.mjs` covers signing, project/path isolation, exact-byte copies, corrupt responses, source changes, idempotent retries, missing receipts, unsupported image content, conditional writes, bounded downloads, dry-run and manifest approval, and real storage-route authorization/fallback callbacks with controlled dependencies. The existing photo CI also runs these tests and full app typecheck; other repository CI remains required.

Additional official references checked 29 October 2026:
- https://developers.cloudflare.com/r2/api/s3/api/
- https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
- https://supabase.com/docs/guides/storage/serving/downloads


## Existing compressor ON proof images: low-resolution archive display (30 October 2026)

The owner requested minimizing size of existing compressor ON indicator photographs, with **no Supabase plan upgrade**.

Read-only live inventory: 53 compressor photos in `refill-photos` occupy 109,986,479 bytes. All are JPEG and linked to `route_stop_safety_checks` on completed route stops, 23 currently associated with machines with unresolved issues. All were uploaded within the last 30 days, so previous archive age/issue guards would block them.

This code adds a preview-only image transformer with a 60 KiB target and 120 KiB maximum: WebP at a declining 800–512 pixel long edge and quality 43–25. It never crops the image, enlarges a small one, or rewrites an original SHA-named file. A green ON indicator is checked in a synthetic-image test; **real operator camera readability is not established by that test**. The existing authenticated `/api/storage/refill-photos/.../compressor/...` URL supports `?preview=compact` while the original is still in Supabase. `?archive=verify` continues to return bit-identical original archive bytes for owner/authorized operator verification.

For original compressor files that have a verified private Blob archive copy, and **only after separately authorizing release**, the existing archive job can remove the Supabase original. The same authenticated URL then automatically serves a small WebP view rendered from the bit-identical private original. Neither route IDs nor the saved safety-check proof path change. Existing machine issue holds are bypassed **only for explicitly enabled compressor proof archiving**, which preserves original bytes and authenticated access, never for routine or quantity files.

Three independent production flags must be explicitly configured before any compressor original could be removed:
- `SNACKY_PHOTO_ARCHIVE_MIGRATION_ENABLED=true` (already used by archive worker);
- `SNACKY_PHOTO_ARCHIVE_RELEASE_ENABLED=true` (separate release switch, default off);
- `SNACKY_COMPRESSOR_SOURCE_RELEASE_ENABLED=true` (compressor-specific release switch, default off).

`SNACKY_COMPRESSOR_HISTORICAL_COMPACTION_ENABLED=true` must also be present to bypass recent-age and unresolved-issue checks **for compressor originals only**. Default off. All file size, ETag, object version, link, completed-stop and quantity-proof guards remain enforced. Copies are exact, hash verified and read back; operators never get a public Blob URL.

**No automated deletion, bulk job, cron, archive transfer or production flag was enabled here.** First compare real compact previews with original photos in an authenticated preview session; confirm that the ON switch/LED is legible on representative phones. Then perform an individually reviewed source-retained canary backup, verify its archive readback, and only after explicit separate approval perform a single source release and verify both historical URL and original archive still work. Do not estimate recovered bytes as an accomplished saving until the storage object count actually decreases.

Potential storage recovery from all 53 compressor source removals: up to 109,986,479 bytes (about 110 MB of Supabase Storage). This alone is insufficient to meet the 1 GB allowance; the broader review-only archive project remains necessary. Compacted responses save photo delivery bandwidth but full originals remain available privately for audit.

## Upload-side compressor cap (same change)

The authenticated `uploadRefillProofPhoto` server action now also converts any compressor-purpose upload into the low-resolution WebP before calculating its SHA filename or storing it. This ensures that operators running stale browser bundles cannot keep uploading multi-megabyte compressor proofs. The original upload name is preserved as metadata, while the stored file is a new content-hash-named WebP, capped at 120 KiB; normal machine overview photos and all quantity/cash/receipt evidence are not changed. If the image cannot be compacted while retaining the full frame, the upload fails visibly and asks the operator for a closer photo instead of silently saving a large original. 
