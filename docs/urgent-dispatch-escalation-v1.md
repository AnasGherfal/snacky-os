# Urgent field-action acknowledgement escalation — Release 3B

## Purpose

Make urgent CRM-to-operator delegation safer when nobody is watching the screen.

This release extends the existing CRM dispatch and assignment-notification system. It does not create a second task system, sender, cron job, SMS flow or WhatsApp integration.

## Initial scope

Only **urgent** field actions are automatically escalated in this release. The dispatch database also accepts the existing `critical` compatibility value. High, normal and low work still shows its acknowledgement deadline but does not create automatic escalation notifications here.

Flow:

1. CRM assigns an urgent field action.
2. Existing assignment notification goes to the assigned operator.
3. The task stays **Assigned** until the operator accepts it.
4. If `ack_due_at` passes while it is still Assigned, the existing once-per-minute worker creates one escalation for the **current CRM owner of the parent issue**.
5. CRM is told to contact or reassign the operator.
6. A fresh reassignment creates a fresh acknowledgement deadline and may produce one new escalation if that new deadline is later missed.

## Delivery safety

The reminder is persisted in the same `public.notifications` / `snacky_notice_private.deliveries` system already used for Snacky work notifications.

Immediately before a push is claimed/delivered, eligibility is rechecked. A queued reminder is skipped when:
- the operator accepted,
- the field action was reassigned,
- the task was cancelled/completed/archived,
- the parent issue was resolved/closed/archived,
- the work is practice data,
- the CRM recipient is no longer the current issue owner or is inactive.

The feature has its own settings row and starts **disabled**. Installing the migration does not activate timed escalation.

## Deduplication

A private receipt is keyed by:
- field task,
- assignee,
- exact acknowledgement deadline,
- escalation stage,
- CRM recipient.

Repeated minute scans therefore do not spam the same handoff. A real reassignment gets a new assignee/deadline and is a new handoff.

## Notification readiness

The CRM issue screen shows the assigned operator's **active registered-device count only**.

It never exposes subscription endpoint, P-256 key or auth secret.

States:
- one or more active devices: push is ready, but provider acceptance is explicitly **not** described as proof the operator saw it;
- zero active devices: CRM sees **No active notification device — contact the operator directly**;
- readiness lookup unavailable: CRM is told the status is unknown and to contact directly for urgent work.

The in-app escalation still exists when CRM has no registered push device. The system does not manufacture a fake push-delivery receipt.

## Privacy

Push copy uses only the short task/work label and a generic instruction to open Snacky OS. It does not include:
- customer phone or WhatsApp,
- private notes,
- attachments,
- purchase cost,
- Finance amounts.

## Boundaries

This release does not:
- notify the owner after a second delay,
- remind on Blocked work,
- remind CRM to verify a Fixed issue,
- alter inventory, routes, cash, purchasing or Finance,
- change operator assignment deadlines,
- grant notification permission on an employee's device.

Those are separate future slices.

## Verification gate

Before activation:
- source/security contracts must pass;
- existing assignment notification and CRM dispatch regressions must pass;
- isolated PostgreSQL acceptance must pass deadline crossing, dedupe, acceptance-before-delivery, reassignment, issue closure, practice/inactive exclusion, no-device behavior and pause;
- TypeScript, focused lint, critical workflow regressions and production build must pass;
- Arabic/English CRM readiness presentation must receive real browser acceptance.

Rollout remains disabled until those checks are reviewed. Device permission remains a physical employee action.
