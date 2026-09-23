# Assigned storage stocktake — Release 2B

## Purpose

Give Snacky a simple physical storage recount that can be assigned to an employee without giving that employee authority to rewrite inventory.

The counter sees product identity and case size, but not Snacky OS's expected quantity. The owner/admin reviews the submitted physical count before any inventory movement is created.

## Workflow

1. Owner/admin creates a stocktake for one active storage location and assigns one active operator, warehouse, purchasing, or supervisor account.
2. The assignment snapshots the products currently visible in that storage for count scope only. It does not alter stock.
3. The assignee performs a **blind count** and records cases plus loose units. A physically found product not on the starting list can be added.
4. Each saved product records its own count timestamp. Submitting the stocktake still creates no inventory movement.
5. Owner/admin review shows:
   - ledger quantity at the time that product was counted,
   - physical quantity,
   - variance,
   - current ledger quantity now.
6. On approval, Snacky OS applies only the variance measured at count time. It uses the existing owner/admin-only `snacky_create_storage_adjustment_v1` RPC, so later purchases/transfers remain intact and active route reservations still protect stock.
7. Zero-variance lines create no movement. Any failing adjustment rolls back the entire approval.

Example: ledger at count = 10, physical = 8, then 5 units are received before review. Current ledger = 15. Approval posts **-2**, resulting in 13. It never resets current stock to the stale physical count of 8.

## Recount and cancellation

Owner/admin can return a submitted stocktake for a full recount. All previous count values/timestamps are cleared so the second count is independent.

An unapproved stocktake can be cancelled. Approved adjustments remain normal immutable inventory movements and are not deleted by cancelling UI state.

## Access boundaries

- Assignee: only assigned stocktakes, product identity/case size, their own saved counts and status.
- Owner/admin: all stocktakes, expected/current quantities, variances, approval/recount/cancel controls.
- No supplier costs, profit, Finance balances, or purchase payment data are exposed by this feature.
- Private stocktake tables use RLS and have no direct browser table grants.
- Public API wrappers are security invokers; private definer helpers perform explicit stored-profile authorization.

## Inventory safety

This release does not edit `current_inventory_by_location` or any balance column. Inventory remains ledger-derived from `inventory_movements`.

Approval delegates each non-zero variance to the existing protected storage-adjustment RPC. That RPC already provides idempotency, prevents negative storage, and rejects removals that would leave total storage below active route reservations.

Physical counts should still be performed during a quiet storage window when possible. The count timestamps let review preserve movements recorded after each saved count, but operational movement during physical counting should be minimized.

## Scope limits

This release is storage-only. It does not count machine stock or operator bags, replace advanced monthly reconciliation, receive purchases, create buying lists, change Finance, or dispatch CRM issues.

The existing advanced reconciliation page remains available for company-wide missing-stock investigations.

## Release gate

Keep the PR draft until:
- migration replay succeeds on a disposable Supabase backend,
- focused contracts, TypeScript, lint, existing reconciliation, critical workflows and route-ledger tests pass,
- production build passes,
- the owner reviews the mobile count UX and approval wording.

Do not create a live stocktake during deployment. After merge and migration, pilot with one storage assignment before expanding.
