# Stocktake assignment and review notifications

## Scope
Connect the existing assigned storage count workflow to the existing notification inbox and per-device leased outbox. No new task system, sender, scheduler, application screen, public RPC, stocktake command, ledger writer or employee permission is introduced.

## Events
- A count assigned to an employee: **Storage count assigned / تم إسناد جرد مخزن إليك**.
- An owner requests a recount: **Storage recount requested / مطلوب إعادة جرد المخزن**.
- The employee submits: **Storage count ready for review / جرد المخزن جاهز للمراجعة** goes to the active owner/admin account that created the assignment, not every manager and not an employee who lacks review permission.
- Links open `/inventory/stocktake?id=<assignment UUID>` using existing destination access checks.

Notifications use fixed Arabic/English copy. Titles, notes, warehouse addresses, actual counts, expected quantities, variances, prices, photos and financial data are not copied into notifications. The due date/instructions remain inside the authenticated stocktake record.

Saving counts does not notify repeatedly. Submission does not approve a count or adjust stock. Approval and cancellation invalidate stale alerts without generating more alerts in this slice. A record already being counted does not receive another start alert from ordinary count saves.

## Identity and access
Stocktake `assigned_to` and `created_by` reference profile/Auth IDs. Notification recipients reference canonical linked team-member IDs; the extension explicitly resolves that difference and verifies current active profile/team links.

Employee alerts require access to the existing stocktake page (owner/admin/supervisor/warehouse through effective profile/team roles). An assignment to a pure operator or purchasing account does not bypass the existing destination restriction. Review alerts require the creator to remain an active owner/admin. When the creator is unavailable, no notification is broadcast to unrelated staff; existing Owner Operations review queues remain authoritative.

Private source/eligibility helpers are not browser APIs. New notification-state tables use RLS with no raw anon/authenticated grants. Original stocktake access and approval controls remain unchanged.

## Stale alerts and failure isolation
A current generation records the stocktake's assignee, creator and workflow state. Each meaningful transition invalidates the prior notification, including transitions performed while notifications are paused. Claim and pre-transport checks revalidate source state, recipient identity, role, event generation and enabled settings.

Reassign-away-and-back and submit/recount/resubmit cycles cannot revive obsolete alerts. Repeated no-op saves are ignored. A real recipient with no registered device still receives an inbox alert; no fake push-delivery row is created.

An optional notification fault preserves the stocktake business transaction, pauses only this integration, and records only SQLSTATE and timestamp. It also rotates an epoch to invalidate prior notifications after a partially observed transition. The shared route/CRM notification system stays enabled. Network-wake errors retain the persisted outbox event for its existing worker.

## Rollout
Build/review only until exact-head checks pass. The CLI-generated migration is `20260926161303_stocktake_notifications_v1.sql`.

1. Confirm the existing stocktake tables, notification schema/worker, and current eligibility function exist. Review the exact committed migration.
2. Install this migration through the normal reviewed production-migration path. It starts OFF, creates no business records and does not backfill old counts.
3. Confirm original source functions/commands and notification eligibility branches are preserved; run security advisors and inspect only safe metadata.
4. Explicitly enable `snacky_notice_private.stocktake_notice_settings.enabled` after review. Do not change global notification settings or staff permissions for this feature.
5. Using actual employee accounts/devices and real activity, confirm assignment, recount and submitted-for-review alerts open the correct record. Push-provider acceptance is not proof a phone displayed or a person read the alert.

The extension is designed to coexist with PR #231's buying/cash notification integration in either installation order. Neither change implicitly activates the other. No production migration or settings change is part of this build.

## Pause and recovery
Disable the stocktake settings row to stop this slice; existing stocktake work and shared route/CRM alerts continue. After an internal fault, inspect the safe error code and fix the cause before re-enabling. Do not reset the epoch to an old value, fabricate assignments to provoke alerts, or replay historical notifications. Use the existing task/Owner Operations pages for missed work.

## Test boundary
Dedicated CI uses the actual stocktake migration/command functions and actual notification queue/claim/payload functions in isolated PostgreSQL with minimal surrounding role/product/storage fixtures. It checks real create/submit/recount/zero-variance approve commands, duplicate requests, unauthorized approval, reassignment, inactivity, canonical identity, role revocation, pause, missing devices, Arabic packets and failure isolation. An inventory-write sentinel rejects unexpected movement writes. It is not a complete production-schema replay or physical-phone test.

Compatibility tests install the exact reviewed #231 migration before and after this extension, execute that PR's existing behavioral tests, and rerun the original route/CRM/urgent-escalation/generation regressions. Source contracts, TypeScript, critical workflows and a production build run separately. There is no new UI to validate in this slice; existing PWA release checks remain applicable.
