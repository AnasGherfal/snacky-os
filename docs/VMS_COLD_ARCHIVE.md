# VMS Cold Archive (copy-only, no production deletion)

## Why

Snacky OS is close to the Supabase Free PostgreSQL database allowance. As of 7 November 2026, the table public.vms_import_rows occupied about 109 MiB including indexes. It holds historical raw import copies; canonical sales, cash, inventory and active VMS batches must remain in PostgreSQL.

A read-only live audit found **66,572 rows** older than 60 days across all statuses, including old active, draft, failed and deleted batches. **Never archive-delete all 66,572 by age alone.** The first approved source category is batches already marked **status=deleted**, **is_active=false**, with both imported_at and deleted_at older than 60 full days and every contained row old enough. That category was about 16k rows in 8 batches at audit time. These values are only historical estimates, not a deletion instruction.

This change implements a *private, resumable copy-only export*. It does not contain any SQL DELETE, truncate, source mutation, archive-to-live restore, cron job, public API, or source-release feature.

## Phase 0: Create a separate full database backup

Supabase Free does not provide the same managed backup retention as Pro. Before applying any future retention or destructive change, use the [official Supabase database dump](https://supabase.com/docs/guides/platform/backups) process to create and validate a full offsite backup including schema, functions, roles, policies, and app data as applicable. The VMS copy-only export below **does not replace a full database backup**. Do not remove any existing data before testing a restore.

Keep backup credentials and dump files off this public GitHub repository and do not paste them into chat or support tickets.

## Phase 1: Create a private R2 Standard bucket (one-time owner action)

1. Go to https://dash.cloudflare.com/ and open **Storage & databases > R2**.
2. Create private **Standard** bucket named **snacky-vms-archive**. Do not expose a public r2.dev URL or custom-domain public access. Leave automatic object expiration disabled.
3. Create an R2 **Object Read & Write** API credential scoped **only to this bucket**. Copy Account ID, Access Key ID and Secret Access Key directly into a private environment on the trusted machine that will run the export. Do not put the write key in Vercel production/preview environments, commit it to GitHub, or share it in ChatGPT.
4. R2 Standard has a free allocation of 10 GB-month, 1 million Class A writes and 10 million Class B reads monthly; billing may require adding a payment method. Review https://developers.cloudflare.com/r2/pricing/.

This repository does not have permission to create your Cloudflare bucket or save its credentials. It is not configured yet.

## Phase 2: Preview exact export; export one batch at a time

Install Snacky OS dependencies on a trusted machine (using the existing package-lock): npm ci. The runner uses the existing @supabase/supabase-js package, the already-tested internal R2 SigV4 signer and Node 22+. It does not need a new package.

Use the secure variable names in deployment/vms-cold-archive.env.example. Enter the real values only into the runner's process environment. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to Snacky's existing Supabase project; these secrets are never printed by the runner.

Read-only candidate query:

    scripts/sql/vms-cold-archive-candidates.sql

Pick **one explicit UUID** returned by the query (begin with the smallest safe batch). Run:

    node --experimental-strip-types scripts/vms-cold-archive.mjs --batch-id <BATCH_UUID>

This uses SELECT-only reads of the source, checks *every row*, and prints a stable approvalSha256 fingerprint, row count and byte count. It does not connect to R2 and does not export any data to stdout.

Review the row count and hash. To copy that **exact source snapshot**:

    node --experimental-strip-types scripts/vms-cold-archive.mjs --batch-id <BATCH_UUID> --copy --approve-sha256 <EXACT_SHA_FROM_INSPECT>

The command requires private R2 environment credentials and performs:

- A verified deleted/inactive source-batch check, and 60-day age check for batch and every row.
- Full paginated source read, including original raw_data, normalized_data, validation fields, stable IDs and batch metadata.
- Stable NDJSON chunks of <=250 rows each; <=4 MiB per chunk and <=64 MiB per batch.
- SHA-256 digest per immutable chunk, server-side conditional write to the private bucket, full R2 readback of each chunk, and JSON parse/row-count verification.
- A second full source read and hash check to detect source changes during copying.
- Creation of one immutable manifest only after all checks pass.
- Zero source deletions. Failed checks leave Supabase unchanged; partial R2 chunks have no valid manifest and can be inspected safely.

To independently test that **an archive can be reconstructed from R2**:

    node --experimental-strip-types scripts/vms-cold-archive.mjs --batch-id <BATCH_UUID> --verify

This verifies the manifest and every stored chunk, checksums, row order and counts. It performs no DB writes.

Idempotent retries do not overwrite existing objects. Changes to an archived batch after backup will force re-approval or reject an existing conflicting manifest, rather than silently replacing history.

Run the focused tests with:

    node --experimental-strip-types --test scripts/test-vms-cold-archive.mjs

## Phase 3: No deletion until a separate release design is approved

Even when the command prints archiveVerified=true, the original rows stay untouched.

A future release stage must have ALL of these prerequisites:

- An independent complete PostgreSQL backup with a successful restore rehearsal.
- At least one real private R2 copy and a tested reconstruction of its exact original rows.
- Verified source keys / hashes / row counts, including a fresh source-state check at release time.
- A documented check that no active dashboards, sales, finance, cash reconciliation, stock, mapping, audit, or historical reporting requires those exact import-row records.
- An owner-approved deletion manifest and a bounded transaction/migration with guardrails; no CASCADE or blanket table deletion.
- An actual measured decrease in PostgreSQL database size after safe maintenance (ordinary DELETE/VACUUM does not always shrink physical storage).

Only then should deletion be separately implemented and deployed. This PR deliberately does not implement it.

## Photo archive is separate

The photo-archive reader/copy runner uses different keys and authorization and is **not** connected to this VMS tool. Cash photos, compressor safety evidence, machine quantity screenshots, invoices and issue photos remain untouched. Never treat a photo's age as permission to remove it.

## Security and cost

The runner is not deployed as a browser-accessible API and prints no row data, source secrets, signed URLs or archive contents. Run locally in a protected terminal, not through a public CI log with exposed secrets. The write token should be restricted to the dedicated archive bucket and rotated after initial transfer if not needed.

Backup costs may exceed R2's free tier if it grows past included storage or request limits. Monitor both providers and keep a local recovery copy.

At this stage, **data was not deleted and Supabase usage will not fall** simply because a tool or manifest exists. This is a reversible first step toward a safe $0 plan.
