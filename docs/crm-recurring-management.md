# Recurring responsibilities and management overview

This release extends Customer Relations. It does not replace CRM tasks or write money, inventory, rent obligations, payroll or routes. There are no real employee IDs or predefined live schedules in the migration. The previously empty, CLI-generated migration is now implemented.

## Staff workflow

Managers configure routines at **My Work → Team Work → Recurring responsibilities**. Choose a real active owner, a general responsibility or existing record, a first due date, an interval in days/weeks/months, an optional end date, and how many days early to create the follow-up. New routines are paused. Review dates and ownership before activation. Future tasks appear with the existing All/This week filters; Today does not misleadingly display future work as due now.

Tasks are generated in the existing `crm_tasks` table. Staff complete them through the original task workflow, including its result requirement, version checks, audit history and access rules. A recurring relationship task cannot move cash, verify a payment, create rent expense, or complete a route. Operator repair work is not repeated automatically; it stays with the existing issue/field-action handoff.

A routine holds at most one unfinished, non-archived task. Delays do not erase the overdue task or produce a backlog flood. Once it is completed, the next worker run creates the most recent due cycle, records how many cycles were combined, and retains the original schedule anchor. January 31 → February 28 → March 31. Pausing does not cancel, complete, move or delete existing tasks. Changes to instructions/owner affect future tasks only; use the normal task record to reassign an existing task. After generation starts, pause and create a new routine to change its cadence/start/source. Ended schedules and closed/archived sources do not generate new work.

The worker processes at most 200 eligible routines per run, fairly ordered by last check. A global advisory lock and per-routine row locks prevent concurrent generation. Each task and its unique routine/date occurrence are saved atomically. A per-routine error rolls back the task and occurrence and is surfaced for management review; the worker does not report that failed work was completed.

## Management overview

The enhanced `/my-work/team` shows recorded results over today/7/30 calendar days in Africa/Tripoli, with an employee filter: distinct leads contacted, visits, actual task completions, and customer issue resolutions. Completion metrics use completion/resolution timestamps, not arbitrary last edits. Practice records are excluded.

Current attention categories are overdue work, missing ownership/next step, waiting reviews due, field results awaiting customer follow-up, location payments due/awaiting verification, and tasks assigned to management. Categories may overlap and are not a summed company KPI. Management-assigned tasks are not automatically commercial or financial approvals. Latest 20 activity entries link to the existing record history. Queue pagination is 30 records; routine pagination is 20.

This is in-app visibility, not email/WhatsApp/push delivery or scheduled summary messages. Explicit approval routing, configurable escalation SLAs, automatic rent-obligation creation and onboarding packages are not included here.

## Access and release gates

The management UI, public RPCs and command API require an active owner/admin/supervisor and active linked team member. Owner/admin alone can pause/resume global generation. Pure CRM and operator accounts cannot configure routines or read management metrics. They use existing assigned task views. Rules cannot assign an unrelated employee to a private source. Generation checks the current assignee and source again at each run.

Private configuration/occurrence/receipt tables have RLS and no direct browser grants. Privileged functions have fixed search paths. Only the small checked public wrappers are exposed. The worker has no anonymous/authenticated/service-role EXECUTE grant and is intended for a database-admin cron job. Existing CRM API guards, command/read functions, storage boundaries and route/financial writers are not replaced.

Deploy in this order:
1. Test the exact code/schema in an isolated environment and review backup/restore readiness. Do not run fixture scripts on production.
2. Apply only the reviewed `20260916214951_crm_recurring_management.sql` after the existing CRM/Company releases. Do not apply every unrelated pending migration. No job or active routine is created by the migration.
3. Build/deploy with `NEXT_PUBLIC_SNACKY_CRM_RECURRING_ENABLED=true`. Default is off; the legacy management workspace remains the fallback. A missing new read RPC displays an unavailable notice and the legacy view, not an empty task list. Opening pages never generates tasks.
4. Configure the named job using `scripts/crm-recurring/install-job.sql` after reviewing pg_cron availability. The database job is every 15 minutes; due dates use Tripoli time inside the function. The UI explicitly reports absent scheduling and the last successful run.
5. Create a real reviewed routine, activate it, then enable generation as owner/admin. Verify one real task, owner access, completion, next due cycle and no duplicate task. Do not use invented staff accounts or financial transactions for live testing.

Rollback is separate for the app and worker: disable the build flag and rebuild; pause the worker or unschedule its named job. Keep history. A feature flag alone does not revoke DB execution permissions or stop cron.

## Tests

`node --experimental-strip-types --test scripts/test-crm-recurring.mjs scripts/test-connected-relations.mjs scripts/test-authz-permissions.mjs`

The `CRM recurring work and management` workflow applies the actual CRM, Company and recurrence migrations to disposable PostgreSQL 17, then tests generation, ownership, dates, history, native task completion and no financial effects, followed by TypeScript and an enabled production build. These checks are not a production rollout or a claim of observed staff browser sessions.
