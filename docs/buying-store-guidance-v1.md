# Store-guided buying — Release 2A

This is an isolated extension of existing shared buying lists, not another purchasing module.
It adds an owner/admin-selected supplier and optional alternative per product, a saved supplier-specific previous price, and exact shop/branch instructions. The buyer works through store groups in the same checklist. Unknown stores and unknown prices are explicit. The existing print view includes the guidance.

## Scope and limits

Create/assign the existing shared list, open a pending product, then use **Choose store & price reference**. Save the instructions before sending the private list link to the buyer. This release does not add a pre-assignment draft stage or automatically reuse store choices in future lists. It does not designate which four of the saved suppliers are current preferred stores.

Prices come only from received, non-voided LYD purchases for that supplier and product with positive received quantity. Latest is ordered by purchase date, receipt/creation timestamp, line position and ID. Unknown/missing LYD history stays unknown. USD history is deliberately not converted. Carton price is recalculated using the current list's units per carton, not the historical carton size. If multiple batches on a purchase have differing prices, the final line in that purchase supplies the reference; this is not a weighted average.

The owner saves a price snapshot. Later changes to purchase history do not silently rewrite instructions. Re-saving an unchecked item explicitly refreshes its reference. Completed/partly bought/unavailable item instructions cannot be edited unless the item's result is deliberately reset through the existing audited checklist workflow. A source save and an item-progress save share the existing list revision and parent lock. Conflicts require a reload, not silent overwrite.

Previous prices are guidance, not enforced spending approvals. Actual invoices, payments, receipt attachment and storage receipt still use the existing purchase workflow. Automatic receipt-to-list matching, budget approvals, stocktake approvals and CRM dispatch are later steps. Checklist progress still never posts money or inventory.

## Privacy and integrity

Only owner/admin may choose stores. Delegated buyers see the saved details on their visible assigned lists, not the global supplier price catalogue or Finance balances. Warehouse/purchasing planners retain their existing list visibility but do not gain permission to approve their own store instructions. Underlying existing Finance roles are unchanged. Snapshots expose supplier name and phone, not payment terms or unrelated notes.

New source and request-history tables are private, RLS-enabled and not directly granted to browser roles. Public RPCs are authenticated SECURITY INVOKER wrappers; privilege-bearing implementations live in buying_private and explicitly check active membership and list access. The raw price helper has no authenticated grant. Request IDs bind actor, payload and returned revision. Saves, list revision and audit entry commit atomically; failed responses reuse the existing saved-command recovery flow.

## Deployment prerequisites — do not equate a merge with a migration

Read-only production inspection on 2026-09-23 found **both existing shared buying RPCs missing**:
- `public.snacky_buying_workspace_v1(uuid,jsonb)`
- `public.snacky_buying_command_v1(jsonb)`

This release has not been applied to production. Review the existing `20260920133731_shared_buying_lists.sql` migration and its CRM/Company prerequisites first. The new migration `20260923130938_buying_store_guidance_v1.sql` fails before making changes if the shared-list functions are absent. Do not blindly replay the repository's historical migration chain against production.

Deploy the reviewed predecessor and new migration with the matching application after release approval. Verify one synthetic/controlled list with the intended buyer before expanding. No real supplier selections, account grants, cash counts or purchases have been performed by this development step.

When the new sourcing function has not been installed, the app keeps the old checklist and estimates working, with a setup notice for planners. A runtime failure or revision mismatch is shown as unavailable, not an empty source plan. The print view refuses to produce potentially stale instructions when the source lookup fails. The prior checklist command and workspace functions are not replaced.

## Rollback

Keep the compatible guidance UI available for lists that already have saved store instructions. Reverting to an older UI would hide those instructions; finish/cancel affected lists or supply a reviewed handover before reverting the app. Do not drop source or audit tables. The source metadata has no inventory/Finance effects to reverse.

## Verification

Local pure tests cover validation, source/receipt identity, supplier grouping, unit/carton calculations, unknown-history handling, old-estimate compatibility and no ledger-write SQL. The isolated CI replays original migrations and tests actual Auth/REST/PostgreSQL behavior, concurrent source requests, injected audit failure rollback, role revocation, reassignment, saved-price snapshots, old checklist progression, Arabic 390/320px layouts, existing print content and lost-response recovery. Review the actual CI result on the PR; the presence of these tests is not itself a passing result.
