# Core Workflow Checklist

Run this checklist before marking a Snacky OS task complete.

If any step is skipped, say `Not fully verified.` in the task report.

## 1. Authentication And Roles

- Owner/admin can open admin pages.
- Operator can open assigned operator routes.
- Operator cannot open payroll, profit, or other admin-only pages.

## 2. VMS Imports

- Upload the Detailed Order Details file.
- Upload the Monthly Commodity Profit file if the feature is supported.
- Upload the stock snapshot file.
- Confirm the import finalizes the batch.
- Confirm active imported files appear in dashboard/source coverage.
- Confirm failed, deleted, and inactive files show a clear next action.

## 3. Sales Dashboard

- Load the dashboard without a full-page crash.
- Switch the selected month successfully.
- Use a custom date range successfully.
- Use the all-time view successfully.
- Verify source status is visible.
- Verify missing dates are shown clearly.
- Verify debug UI is hidden from normal users.

## 4. Route Creation

- Load refill recommendations.
- Confirm products are grouped correctly.
- Confirm manual items are filtered by the selected machine.
- Create a route successfully.

## 5. Operator Route Workflow

- Assigned route loads.
- Pickup checklist loads.
- Confirm pickup works.
- Operator can choose which stop or machine to fill.
- Stop completion works.
- Route completion works.
- No `404` appears in the workflow.
- No `operator route could not load` error appears.

## 6. Inventory Movement

- Pickup deducts storage and adds operator bag stock.
- Fill deducts operator bag stock.
- Returned products go back to storage.
- Damaged products reduce available inventory.
- No double count happens on double click or retry.

## 7. Purchases

- Purchase creation works.
- Purchase item quantities save.
- Paid purchase creates the finance transaction, or records a sync failure without blocking the purchase.

## 8. Cash Collections

- Cash collection confirms successfully.
- Exactly one finance transaction is created per cash collection.
- No duplicate finance rows are created.

## 9. Payroll And Admin-Only Pages

- Owner/admin can open payroll.
- Operator cannot see payroll.
- Pay profile save works if the payroll module exists.
- Route pages do not load payroll data.

## 10. Locations

- Location leads load.
- Active locations load.
- Location edit saves.
- Payroll distance saves and survives a hard refresh.

## Manual Smoke Scenarios

### Two-stop route

1. Create a route with Machine A and Machine B.
2. Confirm pickup.
3. Start Machine B first.
4. Complete Machine B.
5. Complete Machine A.
6. Complete the route.
7. Refresh the completed route.
8. Confirm there is no `404` or broken workflow.

### Inventory movement

1. Start with Product X = 100 in storage.
2. Pick up 20 for the route.
3. Confirm storage becomes 80.
4. Confirm operator bag becomes 20.
5. Fill 15 to the machine.
6. Confirm operator bag becomes 5.
7. Return the remaining 5 to storage.
8. Confirm storage becomes 85.
9. Confirm the route balance reads: picked up 20 = filled 15 + returned 5.

Damaged variant:

1. Pick up 20.
2. Fill 15.
3. Mark 2 as damaged.
4. Return 3.
5. Confirm the balance reads: picked up 20 = filled 15 + damaged 2 + returned 3.

### VMS coverage

For each uploaded VMS file:

- File type detected.
- Report date range detected.
- Rows parsed.
- Rows imported.
- Batch status visible.
- Active in dashboard: yes or no.
- If no, show the reason and the action.
- Dashboard selected range shows data when the file is active.

Deleted batch case:

- A deleted batch does not block a new active import without a restore or reimport option.
