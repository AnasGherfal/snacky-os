# Smart Work Part 3A: products for selected required stops

## Release boundary
This is an authenticated read-only product preview, not Start Trip and not authorization to collect goods. No duties, routes, reservations, stock movements, XY configuration, timestamps or staff settings are written by planning. The previously blocked operational route/stock claim is not recreated. Existing assigned routes continue to authorize pickup. This planner is deterministic; it neither calls a model nor depends on live transaction sales.

## Inputs and scope
One to six saved required duty IDs. Operators see only duties belonging to their current active linked operator identities. Active owner/admin accounts may preview all duties, including unassigned ones. Neither selecting nor previewing changes responsibility or deadlines. Other duties remain visible in the result. Existing open route stops cannot produce a duplicate pickup preview. In-progress or verification-pending duties are not new-trip candidates.

The server loads current XY rows and physical slot definitions, active products, the canonical warehouse balance view and unpicked active-route reservations. Invalid quantities are unknown, not invented availability. Reads are paginated and failures are explicit. Two input reads detect changes during planning; they are not a transactional stock claim. The result is a time-limited snapshot and must be revalidated by the future atomic dispatch path.

## Lane plan
Every active physical lane is accounted for. Missing rows, mapping gaps, duplicate aliases, stale timestamps and invalid quantities have explicit exceptions. Historical synthetic VMS entries and uniquely configured inactive slots are excluded. Existing current products use their fresh XY capacity. Replacements require a saved allowed rule and this product's verified capacity at that exact slot; category/name/old-slot history is not proof of fit. Cumulative prohibited rules always win.

Empty lanes receive capacity-aware seed coverage, including reassigning flexible approved choices to avoid unnecessary blanks. Subsequent allocation aims above low-stock thresholds, then toward full targets. Seed coverage alone is never labelled complete. Original products with insufficient warehouse stock may be replaced before empty when low; a nonempty lane replacement requires enough available stock for its whole verified capacity. Removed goods are not added to available warehouse stock and must use actual-count custody/return workflows at execution.

The preview reports empty-after, underfilled, unknown and replacement counts, combined products in Chips/Chocolate/Candy/Drinks/Water order, and all other saved duties. Complete means all known targets are covered in the proposal, NOT that physical service occurred.

## Capacity configuration
An additive nullable verified_capacity column on the existing slot-rule table; no inferred/default capacities, no rule rows seeded and no changes to table grants. The owner rule editor requires a whole capacity from 1 to 1000 for new Allowed saves. Historical allowed rows without capacity cannot authorize substitutions in this planner. Configure only physically tested combinations.

## Verification and rollout
58 local behavioural/API tests passed initially, including 250 randomized allocation trials in one invariant test. Real handler/loader tests use a database double rejecting writes. Dedicated CI tests the additive column/replay in isolated PostgreSQL, API/engine behaviour and full TypeScript. Branch build, production schema checks and logged-in UI operation are separate gates; do not claim them from unit tests.

Rollback: revert code/navigation; leave the harmless nullable capacity column and saved approved values. Never rollback by deleting routes or changing stock. No scheduler, handover, notification delivery or autonomous Start Trip is included.
