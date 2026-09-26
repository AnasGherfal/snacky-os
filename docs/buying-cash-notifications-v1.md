# Buying assignments and cash pickup notifications

## Scope
This release connects two existing workflows to the existing Snacky notification inbox and leased per-device delivery queue:

- An open shopping list is assigned/reassigned to an active employee: **Shopping list assigned / تم إسناد قائمة شراء إليك**. The alert opens that exact buying list.
- A labelled cash collection assigned to an authorized counter is recorded as deposited in storage: **Cash box ready for pickup / صندوق نقد جاهز للاستلام**. The alert opens the existing Cash handling record.

Assignment alone does not mean a cash box is in storage. The stored collection status, valid physical reference, recorded arrival time and uncounted/unvoided state must agree. Handover-first and collection-first save orders cannot send two alerts. Pickup, count (including zero), cancellation/void or reassignment makes obsolete queued notifications ineligible.

No new task list, cash/Finance writer, inventory writer, public API, app dependency or notification sender is introduced. Same-person purchasing/storage receipt remains unchanged. This slice does NOT add stocktake assignment/review alerts, recurring reminders, WhatsApp/SMS or overdue shopping reminders.

## Notification generation and privacy
Private generation metadata tracks each actual assignment/actionable-state transition, including while this integration is paused. A -> B -> A cannot revive A's original queued alert. No-op UPDATEs, routine checklist edits and enabling the feature do not backfill old work. Reopening a completed shopping list is a meaningful new assignment event.

Notification copy is fixed English/Arabic text. It contains no cash amount, box identifier, storage address, shopping title, product price, customer details or attachments. The record link remains protected by the destination workflow's existing authorization. Changing notification behavior grants no work or Finance permissions.

Current canonical profile/team links, operational role eligibility, current assignment and the counter's existing permission are rechecked when the existing worker claims and loads the delivery payload. The existing eligibility dispatcher receives a guarded branch for exactly these two source kinds; all other installed code, including urgent-escalation generation checks, remains verbatim. The database test verifies this preservation.

An employee with no registered device still receives an in-app inbox notification. No fake push receipt is created. Provider acceptance is not evidence the employee saw it. Old generic inbox messages may remain in history; their links never override current record access.

## Failures
Network wake errors retain already-persisted deliveries for the existing worker. Internal notification/state-write errors must not roll back buying, custody or Finance: the trigger pauses ONLY this new integration and stores a safe SQLSTATE plus timestamp in `snacky_notice_private.operational_settings`. The original notification worker remains enabled. Database warnings contain no source values or error-message detail. Investigate before re-enabling; failed events are not silently replayed as new assignments.

## Release and activation
The migration was generated with Supabase CLI 2.117.0:
`supabase/migrations/20260926153924_buying_cash_notifications_v1.sql`.

Default: **disabled**. No production installation or activation is performed by this build. Install the reviewed migration only after the isolated and cross-module checks pass. Verify the three triggers and four private helpers, existing notification worker heartbeat and staff device readiness. No old source rows are rewritten and no backfill is run.

Explicit activation is a separate database-administrator action:
```sql
update snacky_notice_private.operational_settings
set enabled=true, last_error_at=null, last_error_code=null
where singleton;
```
A pause uses `enabled=false` on the same row. It does not pause route/CRM notifications. Reverting the app is unnecessary because no app code changed. Do not remove source records or change stock/cash values to repair alerts.

Before broad use, the actual employee should verify a real assigned list and one actual recorded cash-box deposit, including notification tap destinations. Automated PostgreSQL trigger/payload tests are not a physical-phone test.

## Tests
The dedicated workflow installs the actual notification, urgent-escalation and hardened generation SQL in isolated PostgreSQL; adds minimal buying/cash source fixtures and the existing counter authorization definition; then applies this exact migration. It exercises both event hooks, duplicate saves, A/B/A reassignment, no-device recipients, claim-time revocation, pickup before transport, zero-count/reference/deposit exclusions, bilingual payloads, optional-write failure and private grants. Existing assignment and escalation behavior is rerun after this extension. TypeScript, existing critical workflow checks and the production build remain gates.

The source fixtures simulate the existing multi-statement deposit order; this is not a claim of a new live Auth/Storage/physical-handover trial. No synthetic business data is inserted in production.
