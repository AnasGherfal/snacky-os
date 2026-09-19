# Lead focus, assignments and outcomes

## Working model

Assigned to / الموظف المسؤول means the Snacky employee responsible for a lead. It is not the owner of the physical place. Contact at the place is recorded separately. A new lead needs only its name and an employee assignment (the current employee is the default); unknown phone, contact and address fields can remain blank. Hiding optional fields is not a substitute for later research.

A stage records what actually happened. Focus records what management wants worked on now. Neither a focus mark nor a completed introduction is an agreement or an installation.

## Choose places for an employee

In Leads & Visits, management can select between one and twenty eligible places from the current result page. Choose the assigned employee, a focus-through date, and optionally one next action for the selection. Review the confirmation and select Assign & set focus. The default end is six days after today, inclusive: seven calendar days in Africa/Tripoli. A custom end up to 90 days ahead is supported. Filter changes clear an unsaved selection; a pending saved request is preserved for recovery.

The existing audited lead-save command assigns each selected original lead. Existing next-action dates are retained, even when already overdue. Undated leads use the focus end date. An empty optional action retains each lead's existing action; if that too is empty, a research action is supplied. Unknown contact facts remain unknown. All selected changes are one transaction: a stale or invalid record rolls the entire selection back. No follow-up task, calendar appointment, message, recurring schedule, financial entry or duplicate lead is created by focusing.

The employee sees the focused leads first in the permission-filtered list, a Focus through label, a Focused places filter, and original-record links at the top of My Work. Management controls are not shown or allowed to ordinary CRM/operator accounts. Eligible assignees must be active, linked login accounts with the existing relations/management roles.

Focus expires after its end date without needing a background cleanup job. Expiry and Remove focus retain the assigned employee, dates, source and activity history. A terminal or archived lead no longer receives an effective focus boost. Later ordinary reassignment uses the existing record and does not create a second focus record.

## Outcomes and ordering

The list has distinct all/open/agreed/installed/declined views. The default ordering is applied in the database before pagination: active focus, overdue open work, agreed awaiting placement, other due/high-priority/open opportunities, installed, declined, then archived/practice records. Closed prospecting records are not labeled overdue merely because an old follow-up date exists.

Agreed — awaiting placement retains the existing accepted status. Installed / operating retains machine_placed. Declined retains rejected. No historic records are reclassified automatically from a name match, signed document, linked location or guess about machine placement. After a real agreement, management uses the original conversion/linking flow. Linking a location alone does not prove installation. The native edit form offers Installed only for an already-linked location; mark it only after actual placement. Declines and their reasons should be recorded in the original activity history. Closed leads remain searchable; ongoing operating-location work stays in Existing Locations.

## Where to record an introduction

Employee onboarding: My Work or Follow-ups -> open the assigned introduction task -> Edit record -> Work performed / result -> Completed -> Save changes. Complete only when the session occurred; write what was covered, the next agreed action and any unanswered question. Do not record a fabricated visit or customer complaint for training.

Introducing Snacky to a place: open that lead -> Add interaction -> choose the actual channel (call, visit, meeting, etc.) -> record the contact and outcome -> Save activity. Update the lead's stage and next action/date separately as appropriate. Completing one action does not close the ongoing relationship. Any linked assigned follow-up can be completed with its actual result through the original task workflow.

## Installation and rollback

The new migration filename `20260919162204_crm_lead_focus.sql` was created by Supabase CLI 2.117.0. Review and test the exact candidate before deployment. Apply only this additive migration after the existing CRM/Company releases; it adds private focus metadata/receipts and two checked public wrappers. It does not replace the native CRM read or command functions. The known CRM API guard allowlist gains only the two new RPC paths; installation stops if its expected anchor is absent instead of replacing an unfamiliar guard.

The application defaults to attempting the focus read. A genuinely absent focus RPC falls back to the original standard list only when no new filter was requested. A requested focus/outcome filter is never silently ignored; errors offer the standard list. Network/permission errors are not treated as empty data. The explicit NEXT_PUBLIC_SNACKY_LEAD_FOCUS_ENABLED=false switch restores the standard application list after a rebuild. Turning off the UI does not remove database history or revoke installed permissions. Keep data during rollback; do not drop the private schema. No production installation, focus assignment or policy publication is performed by the PR itself.

## Verification

The focused workflow runs command/render tests and actual migration/atomicity/access/order/expiry checks in isolated PostgreSQL, then real browser authentication, source editing, three-lead assignment, lost-response retry, native activity history, stage separation and Arabic/mobile layout checks on a disposable loopback backend. The original lead-table browser suite runs with focus disabled to exercise rollback compatibility. Existing CRM, native integration and ledger suites remain in place. No production credentials or real staff/lead fixtures are used. Consult the PR for completed exact-head results; this document is not a claim of a production staff walkthrough.
