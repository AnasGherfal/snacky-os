# Snacky VMS archival: remaining seven batches

## Goal and scope

This is the second phase of the tested private Cloudflare R2 archive. The 183-row original canary batch (ID 50e5063e-5595-4669-b8b1-34b0049bb6a7) was copied and independently verified on 7 November 2026 in GitHub Action runs #3 and #4.

A fresh READ-ONLY production audit on 7 November 2026 found seven other batches where:
- The import batch status is deleted and is_active is false.
- Batch import and deletion timestamps are older than 60 days.
- All contained source rows are older than 60 days.
- Row counts match the fixed reviewed allowlist.

The seven row counts total 15,951. Together with the 183-row canary, this gives 16,134. These are records being backed up, not records approved for permanent deletion.

## Why not automatically archive every old import?

Other historical VMS batches are still active, failed, draft, or imported but not deleted; they may be material to inventory counts, financial and sales disputes, or operational reprocessing. Merely being over 60 days old does not permit deleting or even treating them as safe cleanup targets. The tool uses exactly seven hardcoded UUIDs with row-count checks. A changed batch fails closed.

## Secure workflow

Workflow: .github/workflows/vms-cold-archive-bulk-manual.yml

- GitHub workflow_dispatch only, from master by owner AnasGherfal.
- Uses the GitHub Production environment secrets already tested in the first backup. No new keys or account connections.
- Shares a no-cancel concurrency group with the original single-batch workflow to avoid overlapping archives.
- It has three modes and zero deletion logic.

### 1. Inspect

In https://github.com/AnasGherfal/snacky-os/actions/workflows/vms-cold-archive-bulk-manual.yml choose Run workflow, master, mode inspect. Leave other inputs empty.

This reads all seven batches through the existing SELECT-only Supabase archive runner. It validates each source batch, checks all rows, and emits a final JSON line containing ok:true, rowCount:15951, and bundleApprovalSha256.

Do not use a hash from a different run or the earlier 183-row single-batch hash. The bundle is calculated from exact, deterministic SHA-256 content of seven source snapshots and IDs; changed data fails closed.

### 2. Copy

Select mode copy. Paste the exact bundleApprovalSha256 from the latest successful inspect into approval_sha256. In copy_confirmation type exactly COPY ONLY - RETAIN SOURCE.

The coordinator re-inspects all seven batches before attempting a single R2 write, checks the complete bundle fingerprint, and only then invokes the existing per-batch copy runner. Each copy checks the raw rows again, writes content-addressed objects without overwrites, reads each chunk back, checks hashes/row IDs/counts and a source reread, and commits a manifest last. Failed batches stop further work; earlier completed copies can be verified or retried idempotently.

### 3. Verify

Select mode verify with approval and confirmation fields empty. It uses R2-only credentials and independently checks the 183-row canary plus all seven newly archived batches. Expected totals: totalRowsVerified:16134, batchesVerified:8, originalsDeleted:0. It does not contact the Supabase database in this mode.

## Safety and recovery

There are deliberately:
- No SQL DELETE, TRUNCATE, migrations, storage deletion or source-file modifications.
- No scheduled copy and no automatic database cleanup.
- No public archive bucket, new production API route or R2 secret in client-side code.
- No new hosting fees necessary while archive stays within R2 included usage allowances.
- No release of the original source rows. A source deletion would require a separate tested full-database backup and restore, archived-data reconstruction, FK and reporting-dependency audit, explicit owner-approved deletion plan and bounded migration.

The archive is not a substitute for full PostgreSQL backups. This stage alone does not reduce Supabase database or storage usage. Never paste credentials into logs. Current production business records remain unchanged.
