# Assignment and important-work notifications

## Connected events

| Source | Recipient / event |
| --- | --- |
| Routes | Assigned operator on ready assignment/reassignment, route-date change, removal or cancellation; creator on completion |
| Leads | Assigned customer-relations employee on assignment, next-action deadline changes or priority escalation |
| Customer issues | Assigned employee on assignment/escalation; owner/admin for newly urgent unassigned issues |
| Follow-ups, meetings and field actions | Assigned employee on assignment/deadline/escalation; creator on completion |
| Field action completion | The customer issue owner, without a second task-result alert when they are also the task creator |
| Location relationships and payment follow-ups | Assigned relationship/obligation employee; no amounts or payment details on the lock screen |
| Recurring routines | Responsible employee on assignment; generated occurrences use the same existing crm_tasks trigger |
| Company updates | Active members in the current published audience, only when publication explicitly requests notification |

The optional operator_instructions table is connected only where that older module is installed. It was absent in the production preflight; this change does not install its unrelated pricing workflow. Tasks/field actions remain the supported live way to assign operator work.

## Delivery and privacy

Events and per-device jobs are written with the existing work-record transaction. No old records are backfilled, no event is generated for an unchanged save, and practice/archived/closed work is excluded. Subscribers receive only their own currently accessible assignments. Reassignment suppresses queued alerts to the old assignee and sends a removal notice instead. Delivery rechecks current membership, roles, assignment, subscription ownership and activation immediately before transport. Company alerts never use unpublished drafts.

The inbox belongs to the signed-in account for every role; showing a bell does not grant routes, customer records or Finance access. Push text contains the short work label, not customer phone numbers, private notes, attachments, costs or financial amounts. Device language is stored at registration (Arabic default, English selectable by enabling in the English interface).

Each device has its own leased delivery record. Transport failures retry up to five attempts; unfinished leases expire after two minutes; stale work expires after 24 hours. Provider acceptance is stored as accepted, never as proof of physical display/read. Stable notification IDs replace uncertain duplicate deliveries on the phone. No mechanism can guarantee exact-once display after an ambiguous network response. The existing immediate and delayed test controls remain diagnostics.

## Activation order

1. Apply only `20260919220000_assignment_notifications.sql` to the correct project after review/testing. It starts disabled.
2. Apply `20260919220100_assignment_notification_scheduler.sql`. Requires Supabase pg_cron, pg_net and Vault. It creates/reuses a token entirely inside Vault, stores only its hash in private settings, and schedules a once-per-minute authenticated callback. Assignment writes also request a coalesced immediate callback. Never print the token, send it to the client, or commit it.
3. Deploy the matching reviewed app. The first valid callback to `/api/notifications/dispatch` activates the worker; before that, old code keeps its legacy route sender. Later manual pauses are not undone by the handshake. This avoids requiring a new manually copied Vercel secret.
4. Read private settings enabled/activated_at/last_worker_at and cron job status without selecting token_hash or Vault secret values. Confirm worker heartbeat and inspect only response status codes, not request headers.
5. Staff open the installed PWA and use Account > Device notifications > Enable. Each phone must grant permission. Close the app without logging out, then perform an actual permitted assignment and verify receipt and tap destination. Automated tests are not a physical-device acceptance test.

The scheduler targets the production origin intentionally; deploying a feature preview cannot activate this production dispatcher. Never install the scheduler migration in a shared preview database. Disposable scheduler tests replace transport/Vault/cron boundaries and cannot contact production.

## Safe pause and rollback

Set `snacky_notice_private.settings.enabled=false` as database administrator to stop new work alerts and dispatch. The activated flag remains set so the legacy route sender cannot duplicate alerts. Disable the `snacky-assignment-notifications` cron job when retiring the endpoint. Do not drop source records or rewrite inventory, cash or Finance to repair notifications. A rollback to app code predating this worker requires pausing its database feature first. Reapplying the core migration preserves the installed networking function; scheduler retries reuse the existing Vault token.

## Limits and verification

This release covers assignment/change/completion events, not every possible business alert. It does not add timed overdue/SLA reminders, sales/stock alerts, supplier-payment alerts, SMS or WhatsApp. A recurring task emits an assignment notification when the existing routine system creates that task. Queue diagnostics appear on Account. Workers do not require an open browser, but OS permission, Focus mode, connectivity and push-provider acceptance still affect phone display.

CI executes actual PostgreSQL trigger/outbox/lease/access functions on synthetic records, plus scheduler function bodies with simulated network/Vault/cron services. Node tests execute actual HTTP handlers, sender integration and service-worker click/display code with external boundaries stubbed. Existing mobile dialog viewport tests, TypeScript, production build, ledger and role tests remain enabled. No production fixture users, assignments, purchases or money movements are created by these tests.
