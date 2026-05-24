# Snacky OS Codex Instructions

You are working on Snacky OS, an operations system for vending machines.

## Main rule
Do not fix bugs narrowly. Always test the full workflow around the bug.

## Important business logic
- Roles are additive. If a user has operator + warehouse, they receive both permissions.
- Warehouse users can view inventory, add products, add purchases, and create inventory movements.
- Operators can view assigned/available routes, start routes, adjust pickup, fill stops, complete stops, and end routes.
- Owner/admin can create, edit, assign, cancel, and delete routes.

## Route logic
Storage inventory → operator carried inventory → machine fill → leftover/return/end route.

- Warehouse stock validation may group by product across the route.
- Route display and route_stop_items must stay separated by machine/stop.
- Picklist is only a recommendation, not a closed list.
- Operator can add products not originally in the picklist.
- No substitute product flow is needed. Operator can set original item qty to 0 and add another product.

## Form reliability
Every form with user-entered data should use local autosave/draft recovery.
Never clear form data unless the server save succeeds.

## Error handling
Never allow production Server Components crash pages as the user experience.
Catch errors and show clear messages.
Log exact database/query/action failures.

## Required validation before completion
Run typecheck, lint, build, and available tests.
For workflow changes, manually verify the related flow.