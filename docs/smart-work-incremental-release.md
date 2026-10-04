# Smart Work: small, independently verified releases

The user requested small parts instead of one large change. PR #321 remains the unreleased integration draft. Do not merge it wholesale or treat pure tests as deployed operations.

## Part 1 — priorities and current assignment visibility (this change)

Isolated read-only `/operator/today-work`, linked from operator navigation. Shows current XY empty/low lanes, urgency, real route owners, ownerless work, inactive operators, duplicate open assignments and older outstanding routes. Invalid/missing/stale readings never become zero or healthy stock. A visible warning appears if the open page is more than five minutes old.

Uses existing tables only. No schema changes, model calls, external XY calls, sales work, notifications, product suggestions, duty creation, route mutations, stock reservations or pickup authorization. It is a current snapshot, not a persistent daily obligation list. No invented staff availability/deadlines. Existing assigned routes stay the execution workflow.

Independent checks: pure urgency tests, server loader tests with a write-rejecting database double, TypeScript and branch build. These do not prove production browser operation or any future write/concurrency behavior. The page catches failed reads and shows an explicit unavailable state.

Rollback: revert this one part and its navigation link. No database rollback needed.

## Part 2 — saved daily duties and coverage setup

Approved primary/backup coverage, access/working hours, persistent due duties and deadlines. One stop now must leave the rest required. Unknown availability is a setup issue, not a guessed shift. Test persistence across reloads/midnight and carryover before enabling coordination.

## Part 3 — safe trip creation and product plan

Current XY plus verified available stock; every usable lane accounted for; explicitly approved substitute fit and capacity. Start Trip atomically claims only selected stops and stock. Test two operators competing for the same stop/products. Routine valid trips do not require Anas's approval. Do not replace, bypass or recreate a previously blocked operational write through an alternate tool/path.

## Part 4 — later visits, accepted backup handovers and escalation

Later visits do not reserve uncollected goods. Remaining duties keep their owner/deadline until verified service or accepted transfer. Handover of picked goods uses separately verified custody flow. Test reminder delivery and uncovered/overdue alerts; never interpret silence as acceptance or inflate operator capacity.

Each part must state: implemented, tested, merged, deployed and not yet verified separately. No background promises, no automatic wage penalties, and no changes to existing operational records merely to demonstrate the feature.
