# Snacky production database: recovery gate before VMS raw-row cleanup

**Status: PREPARATION ONLY. Nothing here deletes production data.**

## Snapshot / why this matters

The Supabase Free plan does not include automatic daily database backups. Our project PostgreSQL version is 17.6. The production database was 488,737,939 bytes during a read-only audit on 2026-11-07. That is close to the organization Free-plan 500 MB database allowance. The quota tracks billing-period average, and physical size may not immediately decrease after row removal.

Exactly eight previously deleted/inactive imported VMS batches (16,134 rows, about 25.4 MB of their heap payload, plus indexes/overhead) were copied into private Cloudflare R2 and independently verified with SHA-256 on 2026-11-07. GitHub run:
https://github.com/AnasGherfal/snacky-os/actions/runs/42389080523

A fresh read-only preflight verifies those rows are still present. It also found 10,163 linked VMS transaction records, 3,436 preview rows, 183 monthly profit rows, and 8 preview headers. Those tables must be retained; do not remove the linked VMS import batch headers. The SQL preflight checks no foreign keys refer directly to public.vms_import_rows, but that alone does not establish application-level deletion safety.

Read-only preflight SQL:
scripts/sql/vms-archived-cleanup-preflight.sql

**Critical application dependency discovered in code review:** Snacky OS currently exposes a "Restore deleted batch" control in src/app/vms-import/[batchId]/page.tsx and an action handler in src/lib/vms-import-actions.ts. For Order Details, the handler uses retained vms_transactions_raw summaries; for other report types it can reactivate a deleted batch even if its raw import rows were removed. Preserving batch headers alone does not prove full historical restoration. Therefore raw-row deletion is BLOCKED until an archive-aware restore/replay flow is implemented, exercised against these exact archived batches, and regression-tested for all affected report types. This is in addition to the full database recovery gate.

## Full PostgreSQL logical backup (new manual workflow)

Workflow: .github/workflows/snacky-postgres-full-backup-manual.yml

The new workflow is manual, master-only, and GitHub actor AnasGherfal-only. It uses the existing GitHub Production environment and private R2 bucket snacky-vms-archive. It never runs automatically or modifies source business records.

One new GitHub Production environment secret is required:

SNACKY_DB_BACKUP_URL

Its value must be the complete Supabase Connect > Session pooler PostgreSQL connection URI with the actual database password, host aws-<number>-<region>.pooler.supabase.com, port 5432, username postgres.thrthmeyhuhxnmizjhqx, database postgres. GitHub-hosted runners are IPv4-based, so DO NOT use the direct IPv6 URL or the transaction pooler at port 6543. Never use a service-role key here (it is not a PostgreSQL password).

Get the connection string from:
https://supabase.com/dashboard/project/thrthmeyhuhxnmizjhqx
and add the secret under GitHub repository Settings > Environments > Production > Environment secrets.

Do not paste the database connection URI in chat, PRs, GitHub files, issue comments or workflow inputs. If the original database password is unknown, do not reset it casually: a password change could disrupt applications relying on it. First audit existing configuration.

After the secret is securely saved, open:
https://github.com/AnasGherfal/snacky-os/actions/workflows/snacky-postgres-full-backup-manual.yml

Choose Run workflow > master and enter the exact confirmation:
BACKUP ONLY - DO NOT CHANGE DATABASE

Actions takes a consistent read-only custom-format pg_dump of Postgres 17, checks its catalog includes key public and auth tables, uploads one uniquely named private R2 object, independently downloads it and verifies bytes and a second pg_restore --list, and finally creates a private JSON manifest containing the SHA-256 checksum and restore-drill flag. No GitHub artifacts containing business data are published. Temporary copies are removed from the runner even on failure.

The new dump captures PostgreSQL logical database objects/data accessible to the postgres role, including auth and storage metadata; it does not include bytes of Supabase Storage objects (photos and documents). It is not yet a tested full disaster recovery restore. The SHA and pg_restore --list alone cannot prove clean restoration on a fresh instance. Independent complete restoration and separate Storage objects backups must be covered before any destructive cleanup.

## Hard conditions before considering source-row removal

1. GitHub run confirms full DB backup and private R2 byte-for-byte readback.
2. Restore a full snapshot into an isolated nonproduction PostgreSQL/Supabase environment and compare critical counts; test restoring from the original 8 VMS archives too.
3. Re-run the exact source-row count/age/status/dependency preflight immediately before any mutation. All eight must still match the expected 16,134 rows. Investigate application/report queries against vms_import_rows and row recreation/redo workflows.
4. Explicit owner authorization for a new separate, bounded, logged cleanup procedure that touches ONLY approved old public.vms_import_rows and never removes batch headers, financial transactions, preview/profit rows, storage files or photos.
5. Have rollback/recovery process and operating-hour plan. VACUUM FULL may take an exclusive lock and is not part of the backup workflow. Verify DB size by reading pg_database_size after maintenance; do not promise a fixed space reduction.
6. Keep long-term encrypted backup/access control and audit logs private. Consider separate backups for financial records, photo evidence and receipt images.

Until these conditions pass, no production data cleanup is authorized or implemented.

## Related current Supabase storage

The image optimization released in PR #436 reduces future oversized ordinary machine-overview uploads while preserving compressor, cash, receipt and quantity evidence. It does not remove existing files. Full DB dumps do not replace photos or cash evidence archives. Removing any of these files requires a separate reference-checking backup and restore.

## Relevant official guidance

Supabase Database Backups: https://supabase.com/docs/guides/platform/backups

Supabase Connecting to Postgres: https://supabase.com/docs/guides/database/connecting-to-postgres

Supabase Database/Disk Size: https://supabase.com/docs/guides/platform/database-size
