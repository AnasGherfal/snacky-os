# Operator Workflow

Operators should only see assigned routes and execution screens. They should not see company profit, supplier costs, or all company cash.

## Start of Route

1. Operator logs in.
2. Operator sees today's assigned route.
3. Operator opens the route pick list.
4. Operator confirms products taken from storage.
5. System records `Storage → Operator Bag` inventory movements.
6. Route status changes from `Assigned` to `In Progress`.

## At Each Machine

1. Operator opens the machine stop.
2. Operator sees machine details and refill lines.
3. Operator sees suggested quantity for each product.
4. Operator enters actual filled quantity.
5. System records `Operator Bag → Machine` inventory movements.
6. Operator collects cash.
7. Operator enters actual cash collected.
8. System calculates variance against VMS expected cash.
9. Operator completes cleaning checklist.
10. Operator uploads final machine photo.
11. Operator reports issues if needed.
12. Stop status changes to `Completed`.

## End of Route

1. Operator opens leftovers screen.
2. Operator enters remaining products.
3. System records `Operator Bag → Storage` inventory movements.
4. Operator submits route.
5. Route status changes to `Completed`.
6. Supervisor reviews cash variance, missing stock, and issues.

## Required Cleaning Checklist

- Wipe glass
- Remove trash
- Check payment system
- Check spirals / lift
- Check lights / screen
- Check machine exterior
- Upload final photo

## Issue Reporting

Issue form fields:

- Machine
- Issue type
- Priority
- Description
- Photo

Issue types:

- Machine not cooling
- Payment issue
- Product stuck
- Screen problem
- Dirty machine
- No electricity
- Lock issue
- Lift issue
- Other
