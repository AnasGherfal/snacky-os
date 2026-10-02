# Owner Operations / متابعة العمليات

A read-only owner/admin workspace at `/admin/operations`, linked from Admin. It combines five independently loaded snapshots of existing records. It does not create a parallel task system or add write actions.

## What it shows

- Cash: physically removed cash without a confirmed count, grouped by storage drop-off, pickup, and counting stage. Earlier records without physical box references remain a separately labelled review category, excluded from the main outstanding-box metric. Pending-collection placeholders, voided collections, and counted totals including zero are excluded.
- Buying: open shared lists, completed lists reporting partial/unavailable items, and active linked purchase receipts still in draft and not physically received. Unlinked manual drafts are not represented as completed shopping. The buyer remains responsible for the storage confirmation and may perform it himself.
- Stocktakes: assigned/in-progress/recount requests and submitted counts. The headline number is specifically submitted counts waiting for owner approval; the detailed list includes all unfinished assignments.
- Issues: open non-practice, non-historical customer issues. Each issue appears once; a blocked or overdue-unaccepted field action takes priority. A finished field action requires CRM verification rather than automatic closure.
- Notifications: active operational employees (operator, warehouse, purchasing, CRM), with registered-device presence only. The main metric counts missing registered devices. Registration is not delivery/read confirmation. Service and escalation switches and the last escalation scan time are informational.

## Actions and permissions

This page has refresh, per-section retry, pagination, and links only. Cash count, purchase receipt/storage confirmation, inventory adjustment approval, role/device settings, and CRM closure remain in their existing controlled pages. No amounts, profits, supplier prices, customer phones, push endpoints, or device secrets are returned in the new projection.

Owner/admin authorization is checked at the page, API, and database boundary. API reads use the owner's authenticated Supabase client, not a service-role client. The public RPC is a security invoker; its private stable reader checks the authenticated identity against stored role records before executing any source query. Existing table grants and RLS policies are unchanged.

## Freshness and errors

Every section has its own eight-second read deadline, last-successful-check time, exact matching-record total, grouped counts, and 25-row page. Parallel failures do not hide successful sections. Unknown, malformed, timed-out, or missing data is displayed as unavailable, never zero. After a refresh fails, the old result is not retained as a current success. Waiting times use the section's verified snapshot time, not an invented live timer.

Day-only buying/stocktake deadlines end at the following midnight in Africa/Tripoli. Cash wait ages derive from actual deposit/pickup/collection times. Missing reference records have no invented wait-start time.

## Links

Cash and buying use existing record URLs. The stocktake page accepts a validated optional `id` parameter, passes it to its existing client workspace, and retains the existing backend access checks. No stocktake action was changed.

## Validation

The dedicated CI runs unit/error/access tests; a disposable PostgreSQL fixture with actual migration and rejected-write triggers; TypeScript and focused lint; real bilingual React component browser tests at 320 and 390 pixels; per-section failure/retry and pagination; and the production build after removing the temporary browser fixture. Browser fixture data and mocked refresh responses are synthetic; this is not a login on an employee's phone or a live business handover.

## Deployment

Build/review separately from the already installed escalation update. The new overview requires `20260926104413_owner_operations_overview_v1.sql` plus matching app code. Do not broadly replay unrelated migrations or create live assignments to make the overview nonempty. Before releasing, verify the selected source schemas and actual permission boundaries. Install this new reader only after review/merge. A missing migration produces unavailable sections, not a false empty dashboard.

Rollback: revert the new page/navigation/app code; the stable read-only functions can remain unused. This migration has no business-data backfill, table data, writes, role grants, or irreversible financial/stock changes.
