# Snacky OS Staging Pilot Test Plan

Use this plan to validate one real machine before pilot operations. Run it in staging first, then repeat only the approved pilot steps in production.

## Prerequisites

- Staging deploy is live over HTTPS.
- Staging Supabase migrations are applied.
- Owner/admin and operator accounts exist.
- One real machine, one storage location, one supplier, and at least one real product are available or ready to create.
- Do not use fake/demo data. Use pilot-safe real Snacky records.

## Exact Test Steps

1. Login as owner.
   Expected: owner lands on the main Snacky OS app and can access Admin, Inventory, Purchases, Routes, Finance, and Activity.

2. Add/check product.
   Go to `/products`. Add a real pilot product if missing, or open the existing product and confirm SKU/name/category/selling price are correct.
   Expected: product is active and available for purchases/routes.

3. Add/check machine.
   Go to `/machines`. Add the pilot machine if missing, or open/edit the existing machine and confirm name, code, VMS machine ID, and status.
   Expected: pilot machine is active and visible in machine lists.

4. Add/check storage inventory.
   Go to `/storage-locations` and confirm the pilot storage location exists. Go to `/inventory` and note current product quantity.
   Expected: storage location is active; current quantity is known before purchase.

5. Create purchase.
   Go to `/purchases/new`. Create a draft purchase for the pilot product with boxes/cases, units per box, loose units if needed, unit cost or line total, supplier, receipt number, and payment status.
   Expected: purchase saves and opens its detail page.

6. Receive purchase.
   On the purchase detail page, receive the purchase.
   Expected: purchase status becomes received and purchase receipt movements are created.

7. Confirm storage increases.
   Go to `/inventory` or `/inventory/movements` and filter by the product/purchase.
   Expected: storage quantity increased by the received units and movement reason is `purchase_received`.

8. Create route.
   Go to `/routes/new`. Select the operator, pilot date, pilot machine, and planned products/quantities.
   Expected: route saves and redirects to the created route detail page.

9. Login as operator.
   Sign out, then login as the assigned operator.
   Expected: operator lands on operator routes and cannot access admin/finance/team/settings.

10. Confirm pick list.
    Open the assigned route, go to the pick list, verify planned products, then confirm pick list.
    Expected: route starts/in progress and storage-to-operator-bag movements are created.

11. Confirm storage decreases.
    Login as owner in another browser/session or after operator completes pick confirmation. Check `/inventory/movements`.
    Expected: storage decreased by picked quantity with movement reason `storage_to_operator_bag`.

12. Fill machine stop.
    As operator, open the route stop for the pilot machine. Enter actual filled quantities.
    Expected: stop accepts quantities without horizontal scrolling or runtime errors.

13. Mark cash collected.
    On the stop flow, mark cash collected yes/no and enter bag/envelope ID and notes if applicable.
    Expected: cash collection is saved as pending count when cash is collected.

14. Return leftovers.
    Open leftovers for the route and return remaining operator-bag stock to storage.
    Expected: leftovers save and operator-bag-to-storage movements are created.

15. Complete route.
    Complete the route after all stops and leftovers are done.
    Expected: route status becomes completed.

16. Login as owner.
    Sign out of operator account and login as owner.
    Expected: owner can access route detail, inventory, cash, finance, and activity.

17. Review route.
    Open `/routes`, then the completed route.
    Expected: route detail shows summary, operator, stops, pick list, inventory movements, cash collections, issues, and status timeline.

18. Confirm inventory movements.
    Open `/inventory/movements` and filter by route/product/machine.
    Expected: route has storage-to-operator-bag, operator-bag-to-machine, and any operator-bag-to-storage movements.

19. Confirm cash collection.
    Open `/cash-collections`. Find the route/machine cash collection.
    Expected: collection is pending count if operator marked cash collected and did not count amount.

20. Confirm finance transaction after cash count.
    Open the cash collection detail as owner/admin/finance. Enter counted amount and confirm count.
    Expected: cash collection status becomes counted confirmed or variance review, and a money-in finance transaction is created/updated.

21. Confirm activity logs.
    Open `/activity` and filter by route, cash collection, inventory movement, purchase, product, or user.
    Expected: create/receive route/purchase, pick confirmation, stop completion, cash count, finance, and inventory actions appear with before/after details where available.

22. Import VMS Product List.
    Open `/vms-import`. Upload a real Product List XLS/XLSX/CSV, select sheet/header row/report type, map columns, preview, validate, and confirm import.
    Expected: products and VMS product mappings are created/updated; unmapped rows are marked for review.

23. Import VMS Stock/Machine Goods.
    Upload a real Machine Goods / Stock report with machine, product, current stock, capacity, and out-of-stock fields.
    Expected: stock snapshots save, unknown machines are clearly shown, and refill recommendations use latest stock import.

24. Import VMS Sales.
    Upload a real Sales Statistics report.
    Expected: sales snapshots save without fake data; row-level errors are visible for invalid rows.

25. Confirm dashboards/refill recommendations update.
    Open dashboard, sales/product/machine dashboards, routes/new, and refill-related screens.
    Expected: dashboards reflect imported VMS sales/stock data and refill recommendations update from latest stock snapshots.

## Pilot Exit Criteria

- Owner can complete setup, purchase receiving, route review, cash count, finance review, VMS imports, and activity review.
- Operator can complete the assigned route on a phone-width screen.
- Inventory movement ledger is complete for the route.
- Cash count creates or updates a finance transaction.
- No visible navigation reaches a broken page or raw error.
- `/admin/diagnostics` shows Supabase connected and non-error counts for products, machines, routes, and inventory movements.

## Record During Test

- Product SKU/name used.
- Machine code/name used.
- Route ID and date.
- Purchase receipt number.
- Cash bag/envelope ID.
- VMS import batch IDs.
- Any runtime error message, screenshot, and exact URL.
