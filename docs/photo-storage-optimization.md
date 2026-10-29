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

## Recommended archival policy — NOT implemented or activated yet

Use private Cloudflare R2 **Standard** object storage for historical photos, not a public bucket, and not a second Supabase bucket (which shares the same quota). Keep the latest 30 days and current/open operational evidence in the fast path. Archive older ordinary photographs without destroying history; safety/quantity evidence may only move bit-for-bit with authenticated retrieval and audit links preserved. Cash evidence, receipts, issue/dispute proof and documents remain outside any routine automatic deletion policy.

Archive sequence must be resumable and fail closed:

1. Produce an owner-reviewed manifest with bucket/path, source version, original byte length, SHA-256, proof type, all references and holds. Missing information blocks removal.
2. Copy to the private archive; download the archive copy and verify its byte length and SHA-256 against the source. An ETag alone is not sufficient proof of identical bytes.
3. Verify the existing authenticated `/api/storage/...` route can retrieve archived objects without widening permissions. Preserve old record IDs/URLs; do not erase completed-route records or audit events. This archive-aware reader is a required future implementation, not present in this PR.
4. Recheck the source version and holds, write a durable archive receipt, and only then remove the Supabase copy through the Storage API. Never use SQL DELETE on `storage.objects`.
5. A failed copy, hash check, read test or reference check leaves the Supabase object untouched. No automatic permanent archive deletion is proposed.

Do not overwrite digest-named evidence files with different image bytes: that would invalidate the meaning of the existing fingerprint. Existing evidence is either copied bit-for-bit or transformed as a separately identified derivative with a retained source and explicit audit metadata.

Cloudflare's current Standard free tier includes 10 GB-month plus operation allowances; source-provider egress and operation usage must be checked before bulk copying. No archive account, bucket, billing change, scheduled transfer, or removal has been set up by this change.

## Verification and release

Run the focused tests, photo-persistence/stop regressions and typecheck. The photo CI job also runs a synthetic encoder test in Chromium and WebKit, without live credentials. Full application CI and a real-phone preview check remain release gates. This code reduces *new uploads after deployment*; it does not reclaim the existing 1.48 GB automatically. Database disk usage is a separate capacity issue and is unaffected by photo compression.

Official references checked 29 October 2026:
- https://supabase.com/docs/guides/storage/management/delete-objects
- https://supabase.com/docs/guides/storage/schema/design
- https://developers.cloudflare.com/r2/pricing/
