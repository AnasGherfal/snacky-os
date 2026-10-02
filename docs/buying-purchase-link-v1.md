# Buying list → purchase receipt → same-person storage confirmation

## Operational workflow

The same assigned employee may buy the goods and place them in storage. No independent receiver or witness is required by this feature.

From a shared buying list, open **Purchase receipts / place goods in storage**. The owner first chooses the primary and optional alternative supplier for each product. The buyer records actual bought quantities in the existing checklist, then records a receipt from an approved store.

The receipt screen shows only bought or partly bought quantities not already invoiced. It supports separate receipts per store and splits across an approved alternative store. Unavailable products do not create purchases or stock.

Actual product line totals must be entered. Supplier-specific historical prices are reference information, not current quotations or an automatic paid amount. A higher price requires an explanation. A private JPG, PNG, WebP or PDF receipt (maximum 5 MB) is required.

### At the shop

Leave **I have physically placed all entered quantities in storage** unchecked. Saving creates an existing purchase-order draft linked to the list, with real bought quantities, prices and receipt. It creates no inventory movement. The linked receipt page labels this **Bought — not yet stored**, not received stock.

### When goods reach storage

The same buyer reviews the receipt quantities, chooses the actual storage location, and confirms placement. The existing atomic purchase-receipt writer adds the goods to the inventory ledger. No second person is requested.

When the goods are already physically in storage at entry time, checking the explicit placement confirmation records the purchase and receives it in one transaction.

## Accounting boundary

A purchase receipt and a physical stock receipt are not evidence of a supplier payment. The existing system requires new purchases to start unpaid. This feature does not invent or duplicate payments, change account balances, or give the buyer the Finance dashboard.

Actual supplier payments stay in Snacky's existing purchase-payment workflow, subject to its existing roles. The linked original purchase remains accessible from the receipt page. Delegated purchasing cash advances and buyer payment posting are not added here.

## Exceptions and corrections

For shortages, damaged goods or quantities not actually placed in storage, do not confirm full receipt. This version holds the purchase for owner review; it does not automatically post damaged or missing quantities or support partial receiving of a single purchase.

New linked receipt contents are immutable: do not silently replace bought quantities, product identity, supplier, date, price or proof through an unrelated draft editor. Cancel an incorrect unreceived draft through the existing protected workflow and record a corrected receipt. Cancellation retains the original link and receipt history, retires its duplicate-check reservation and frees its quantities for the corrected entry. Cancelled linked purchases cannot be restored by changing their status directly.

Existing ordinary unlinked purchase creation and editing are unaffected by the scoped guards. Payments and normal received-quantity/status transitions remain available through their original protected writers.

## Authorization

The receipt page requires existing purchase-authorized roles: owner, admin, supervisor, warehouse or purchasing. Recording or receiving additionally requires being the current assigned buyer. Later receiving also requires the original recorded buyer. Planners may review accessible lists, but cannot claim another person's physical storage placement.

A plain Operator or CRM role does not gain invoice-writing, product-cost catalogue or Finance permissions. Ahmed's existing Warehouse role is sufficient without adding Finance. No employee roles are modified by the migration.

All new receipt-link and command-receipt tables are private, RLS-enabled and have no direct browser table grants. Public RPC wrappers use SECURITY INVOKER and call private functions with active stored-profile and list-assignment checks. No service-role key is sent to the browser.

The server uses privileged Storage upload only after verifying the authenticated list scope. Paths are fixed to the authenticated user, list and SHA-256 hash. File signatures, type and size are verified, existing evidence is not overwritten, and the database independently checks the matching Storage object before recording a purchase.

## Duplicate and concurrency safeguards

- Exact request IDs are bound to the actor and entire submitted payload.
- A lost response retries the same persistent request; it does not create another purchase.
- Buying-list revisions and list locks serialize updates across devices.
- Only checklist-bought units not already invoiced may be recorded.
- The same active store receipt hash or receipt number cannot be linked twice to a list.
- A checklist edit cannot reduce bought units below already-invoiced quantities.
- The canonical purchase writer protects per-line receiving against duplicate stock movements.
- Purchase creation, link creation, list revision and saved command result are one database transaction. Any failure rolls back the whole transaction.

## Inventory architecture

This is a source link into existing `purchase_orders` and `purchase_order_lines`, not a second purchasing ledger. It calls `snacky_create_purchase_with_lines_v2` and `snacky_receive_purchase_v1`. It never writes an inventory balance directly, bypasses storage/product locks, or changes route reservations.

## Verification and rollout

The branch includes executable command validation tests plus actual Auth/Storage/PostgreSQL/Next.js/phone-browser acceptance on a disposable loopback Supabase environment. Test results must be read from the current CI run; the existence of a test file is not a passing result.

No production migration, purchase, list, payment, stock movement or employee change is performed by this implementation work. Keep the pull request draft until current checks pass and the deployment migration is reviewed. Deploy matching app and migration before a one-list real pilot. This feature does not require merging the pending stocktake or CRM-dispatch PRs.
