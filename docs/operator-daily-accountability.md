# Snacky: required daily service, flexible individual trips

## Approved operating principle
An operator chooses how many stops to undertake on the next trip, not which required machines disappear from the day's workload. Daily responsibility, the next trip, and physical stock custody are three separate records.

Example (illustrative, not production assignments): Noury is responsible for A, B and C today. Taking A now leaves B and C on his required list with their original deadlines. If he can cover only A during his entire shift, the remaining duties need an eligible backup; they are not treated as deferred optional suggestions.

Routine work within approved rules must not require Anas to approve each trip. Owner involvement is for roster setup, policy exceptions or genuine uncovered staffing—not a routine start gate.

## Required day coordinator behaviour
- Detect all machines due from the verified XY urgency calculation, irrespective of current trip checkboxes.
- Persist one outstanding service obligation per machine, with a stable ID, original required time, Libya business date, priority, latest completion time, and named responsible operator.
- Obtain primary/backup eligibility, work availability and deadlines from approved configuration; never infer them from names or previous incidental assignments.
- Allocate the whole due workload by urgency, deadline, remaining travel/service time and operator availability. A machine count alone is not a capacity model.
- Prefer the primary operator where feasible. Use an approved backup when the primary cannot meet the duty before its deadline. Exceeding both operators' capacity is an explicit uncovered exception, not a successful day plan.
- Account for existing obligations before promising new work. Re-evaluation must not silently switch an existing owner or relax a deadline.
- A later trip time is allowed only while enough time remains to complete the duty before its deadline. It does not reserve warehouse products.
- A missing, stale or healthier XY snapshot alone cannot delete a previously required obligation. A trusted completed service, or a separately audited supervisor exception, is needed.

## Operator controls
1. My required work: all outstanding duties, including later visits, blockers and handover requests.
2. My next trip: highest-priority feasible duties first. One-stop selection does not cancel the remainder.
3. Cannot do this now: record a reason and request coverage. The duty remains unresolved and visible; safe other work can continue.
4. Handover: offer to an eligible backup; original operator remains responsible until the backup explicitly accepts against the current revision.
5. Already picked up/started: use the existing audited route/custody transfer flow. A duty-only acceptance cannot move or free goods.
6. Completed: derive from trusted route-stop verification. A visit, skipped stop, pending XY verification or partial refill does not count as complete coverage.

The app must not force a person to continue working merely to hide an uncovered machine. Shift end with unfinished work is a staffing exception for backup coverage and management, not fabricated completion or an automatically extended shift.

## Owner visibility and escalation
Show total required, actually completed, still assigned, uncovered, blocked and overdue separately. "All assigned" must not mean "all completed."

Warn before the latest safe departure time, using service/travel duration and the deadline. Send initial reminders to the responsible operator; request approved backup coverage early enough to act. If no feasible backup accepts, surface an owner exception. No response must never be treated as acceptance.

Unfinished duties carry their original deadline into the next business day. A new calendar day does not reset overdue history or operator responsibility. An overdue unowned duty can still be assigned for recovery while keeping the missed deadline visible.

Stock shortages, invalid product mapping, a broken machine and site-access problems must remain distinguishable from an operator not attending. No automatic wage penalties are implemented.

## Implementation in PR #321
- `self-dispatch-duties.ts`: pure, typed allocation and duty transition functions. They return decisions only; no routes, stock reservations, database writes, notifications or shift changes occur here.
- Includes whole-day allocation, highest-priority next-trip selection, later-time validation, explicit blockers, two-party handover, trusted service evidence, original-deadline carryover, and uncovered/overdue summaries.
- Revision checks express the persistence contract; they are NOT a substitute for database compare-and-swap/transactions.
- Work-board GET now includes `dailyCoverage`, independent of selected preview machines.
- Bilingual `DailyCoveragePanel` displays every currently required or assigned machine. Confirmed route operator names are shown where present; an unassigned draft is not counted as human coverage.
- The preview intentionally uses current route responsibility only. It shows no invented daily owner or deadline. `coordinatorEnabled` and `dispatchEnabled` remain false.

## Not yet implemented / not released
The persistent duty ledger, owner-managed primary/backup roster and work windows, authenticated duty-event write API, unattended coordinator/reminder delivery, accepted-handover persistence and real Start Trip are not wired into production.

The earlier route-claim migration was blocked. This change does not recreate that operation through another path. There is no alternate operational route/stock write path in this change.

Current UI remains preview-only. It does not enforce pure duty transitions against live staff, grant pickup authority or reserve goods. Existing production routes and inventory remain unchanged.

## Verification and release gates
Local planning/workflow/API suite: 83 tests passed, zero failures or skips. The API tests run the real handler/loader against a read-only database test double; they do not prove production concurrency. Standalone strict type checks passed for the pure planning modules. TSX syntax transpilation passed; this is not browser visual or authenticated end-to-end verification.

Before release, require:
- Actual durable duty creation and reload across two authenticated operator sessions.
- One machine now, all remaining duties still assigned with original deadlines.
- Primary/backup eligibility and availability enforced server-side.
- Concurrent backup acceptances produce one owner, an audit event, and no lost update.
- Unaccepted/declined backup request keeps the original owner and is escalated.
- Whole-day capacity shortages and imminent missed deadlines generate tested notifications.
- No loss of old obligations on snapshot changes, skipped stops, page reload or midnight.
- Safe atomic integration with the existing route/stock reservation path; no credentials or stock claims supplied by clients.
- Accepted route custody handoffs tested separately from daily responsibility handoffs.
- Current production routes preserved and Arabic/English mobile screens visually reviewed.
