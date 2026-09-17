# Recurring-work activation — 17 September 2026

The owner explicitly requested live installation and activation after PR #174 passed its code, database and real isolated browser checks.

The reviewed migration is being installed before the matching application rollout. This activation changes application visibility to default-on; `NEXT_PUBLIC_SNACKY_CRM_RECURRING_ENABLED=false` remains an emergency app rollback switch. This supersedes the earlier default-off description in the original rollout guide. Database generation and individual routines retain separate controls. A new routine still starts paused, and installing the SQL still does not schedule a job or generate tasks.

Deploy the reviewed application only after its final checks pass. Configure only the named `snacky-crm-recurring` database job using the existing installation script while generation is paused. Verify owner reads, non-management denial, exact job command and permissions, then explicitly enable generation. Retain tasks and occurrence history on rollback; do not drop the new schema to roll back the interface.

Staff rollout remains distinct from publishing Company guidance. Existing draft policies must not be auto-published. Use actual active staff accounts; no placeholder account or invented email. Start with an owner-controlled review responsibility and a small documented onboarding queue, then assign location-specific schedules when the intended employee account and approved cadence are available. Do not change rent terms or financial records to create reminders.

The final PR deployment comment records the actual installed state, application commit, scheduler status and verification results. This file alone is not evidence of a completed deployment.
