# CRM → operator field dispatch — Release 3A

## Purpose

Connect a customer/machine issue to a real operator field visit without creating a second CRM task system.

This release extends the existing `crm_tasks` field-action workflow and existing Snacky assignment notifications. It does not replace customer issues, push notifications, issue SLA, documents, or CRM history.

## Flow

1. Customer Relations records or opens a customer issue.
2. From the issue, CRM creates an **Operator field action**, selects an operator, urgency, due date/time, and instructions.
3. The existing assignment notification system alerts the assigned operator.
4. New field actions use this physical-work state machine:
   - **Assigned** — waiting for operator acknowledgement.
   - **Accepted**
   - **On the way**
   - **Working**
   - **Blocked** — operator records the blocker; work can later resume.
   - **Fixed** — operator records what was fixed and must have at least one image attached to that field task.
5. When Fixed is recorded, the existing task becomes Completed. The existing CRM audit integration marks the parent issue as field-work completed, schedules customer follow-up, and alerts the issue owner.
6. **The customer issue stays open.** CRM confirms the outcome with the customer/location and explicitly closes the issue with a resolution.

## Acknowledgement target

The acknowledgement deadline is visible to CRM:

| Urgency | Acceptance target |
| --- | ---: |
| Urgent | 10 minutes |
| High | 20 minutes |
| Normal | 30 minutes |
| Low | 60 minutes |

This release does not introduce a new scheduled escalation notification. Existing assignment push is reused. CRM can see that an Assigned task is overdue for acknowledgement.

## Reassignment

Reassignment is treated as a new physical handoff. The new assignee receives the existing assignment-change notification and the task returns to Assigned with a fresh acknowledgement deadline.

The prior state changes remain in CRM activity history. Completed/Fixed work cannot be reassigned.

## Operator boundaries

For a dispatch-managed field action:
- Only the assigned employee can Accept, mark On the way, Start/resume, Block, or Fixed.
- Operators cannot use the generic task form to jump directly to Completed.
- Blocked requires a reason.
- Fixed requires a result note and an image attached to the task.
- A lost response can retry the exact saved action without creating a duplicate physical event.
- A stale browser version must reload before reporting another state.

## CRM boundaries

Customer Relations continues to own the complaint and customer relationship.

The field action result is evidence for CRM; it is not issue closure. Existing issue resolution validation remains authoritative, including pending-field-work checks.

## Privacy

The operator works from their assigned field task. Customer complaint ownership, Finance, purchasing, cash, and inventory permissions are not expanded.

The dispatch receipt table lives in a private schema with RLS and no direct authenticated table grants. The browser calls a security-invoker public wrapper; the private command validates the authenticated user and canonical team-member assignment.

## Existing notification transport

No second notification/outbox system is created. Existing `snacky_notice_private.assignment_changed('task')` handles assignment/reassignment and the existing field-completion notification tells the issue owner that field work finished.

Phone push still requires that employee's PWA/device notification permission.

## Legacy field actions

Existing field actions created before this release retain the old workflow with `dispatch_state = null`. The migration does not backfill or reinterpret historical work.

Every new field action created after this release initializes the dispatch lifecycle automatically.

## Scope limits

This release does not:
- close complaints automatically,
- send WhatsApp/SMS,
- modify routes,
- alter cash/Finance,
- alter purchasing or inventory,
- install a separate maintenance ticket system,
- create automatic overdue escalation push reminders.

## Deployment gate

Keep the release draft until:
- focused dispatch contracts pass,
- existing connected-CRM and notification tests pass,
- full migration replay succeeds on disposable Supabase,
- real synthetic CRM/operator lifecycle passes,
- private-table / wrapper / trigger checks pass,
- existing critical workflows pass,
- production build passes.

Production deployment must not fabricate customer issues, operator visits, photos, or issue resolution.
