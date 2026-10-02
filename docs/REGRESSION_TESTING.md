# Regression Testing And Stability Gate

Snacky OS is used in live operations, so no Codex task is complete unless the core workflows still work.

## Done Means Tested

Every task report should include:

- Files changed.
- Migrations needed.
- Exact SQL if production needs one.
- TypeScript result.
- Lint result.
- Core workflow impact.
- What was tested.
- What was not tested.

If something could not be tested, say `Not fully verified.`

## Recommended Commands

Run the lightest relevant checks first:

```bash
npm run smoke
```

If a task touches a specific area, also run the matching checks:

- Authentication or permissions: `npm run test:authz-permissions`
- Route workflow: `npm run test:route-workflow`
- Route inventory stability: `npm run test:route-inventory-regression`
- VMS imports: `npm run test:vms-import-validation` and `npm run test:vms-sales-import-parser`
- Finance flows: `npm run test:finance-ledger`, `npm run test:purchase-finance-sync`, and `npm run test:purchase-unit-cost-memory`
- Purchase history or finance sync: `npm run test:critical-workflows`
- Authenticated page smoke: `npm run smoke:auth-pages`

## Current Helper Coverage

- `src/lib/route-pickup-checklist.ts` is covered by the existing route workflow tests and the extra product-grouping regression test.
- `src/lib/inventory-movement.ts` is covered by the new inventory helper regression test.
- `src/lib/route-inventory-summary.ts` is covered by the new route inventory balance regression test.

## Manual Smoke Requirements

Use the checklist in `docs/CORE_WORKFLOW_CHECKLIST.md` for:

- Two-stop route workflow.
- Inventory movement balance.
- VMS batch coverage.
- Dashboard no-debug verification.

## Code Review Rule

Do not mark a task complete if it fixes one thing but breaks routes, VMS imports, inventory, finance, or dashboard loading.
