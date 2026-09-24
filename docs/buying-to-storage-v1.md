# Buying list → purchase → storage — Release 2B

## Current operating model

For now, the **same assigned employee buys the products and places them into Snacky storage**. This release deliberately does not introduce a second warehouse handoff or witness.

The buying checklist remains planning/progress. The existing Purchase module remains the only system that creates a purchase and receives stock.

## Flow

1. Owner/admin prepares the shared buying list and selects the required store plus optional approved alternative.
2. The assigned buyer records the result for every item:
   - Bought
   - Partly bought
   - Unavailable
3. For Bought / Partly bought, the buyer records the **store actually used**. It must be the required store or the approved alternative.
4. After every item is checked, the buying list is completed.
5. Snacky groups purchased items by the store actually used. Each store becomes one real purchase.
6. The assigned buyer opens **Record & receive** for that store.
7. The existing Purchase form is prefilled with the exact checked products and quantities.
8. The previous supplier-specific price is a reference only. The buyer must enter the **actual price paid**, attach/record the receipt as appropriate, and choose the receiving storage location.
9. **Save and receive** uses the existing atomic purchase RPC. That operation creates the purchase, purchase lines, inventory movements, cost memory and received status together.
10. The new bridge links that exact purchase back to the completed buying-list store group.

## Same-person rule

For a linked buying-list purchase:
- the purchase must have been created by the assigned buyer;
- if already received, it must also have been received by that same buyer;
- another employee cannot attach their purchase to the buyer's checklist;
- owner/admin retains rescue visibility but the normal operational path is the assigned buyer.

## Quantity safety

The checked buying list is the source for physical quantities.

Before creating a linked purchase, the server compares the submitted purchase lines with:
- the actual products marked Bought / Partly bought,
- the actual store used,
- bought boxes × units per box.

If any product or quantity differs, no purchase is created. The buyer must correct the buying-list result first.

The database link repeats this comparison before accepting the link, so browser changes cannot bypass it.

## Price safety

Supplier-specific historical price remains visible as a reference on the buying list. It is **not treated as the actual new purchase price**.

Buying-list purchases start with blank actual cost fields. The buyer must enter a positive actual unit price or line total before saving/receiving. Existing generic product cost memory cannot silently turn the old price into the new buying-list receipt price.

## Inventory and Finance boundaries

This bridge does not write inventory or Finance directly.

Inventory changes only through the existing atomic purchase receive workflow (`snacky_create_purchase_with_lines_v2` when submitted as Received, or the existing receive workflow for a draft).

New purchases still start **Unpaid**. Supplier payment remains a separate existing purchase-payment action. Receiving stock does not mean the supplier has been paid.

## Store grouping

If a list has:
- products bought from Store A,
- another product bought from approved Store B,

Snacky creates two purchase actions. It does not combine two suppliers into one purchase.

A store group may link to only one purchase. Exact retries return the existing link instead of creating a replacement.

## Permissions

The checklist can still be viewed/updated by its existing authorized roles.

Creating and receiving the actual purchase requires existing Snacky purchase permissions (owner/admin/supervisor/warehouse/purchasing). This release does not grant Finance visibility or purchase authority to CRM/operator accounts.

## Scope limits

This release does not:
- create a second warehouse receipt system,
- require a second person to accept goods,
- modify cash handling,
- alter Finance balances,
- mark purchases paid,
- replace purchase receipts,
- overwrite storage quantities,
- merge multiple suppliers into one purchase.

## Pilot

After deployment, pilot with one completed buying list and one supplier group:
1. buyer records actual boxes and store;
2. completes list;
3. opens Record & receive;
4. enters actual prices and receipt;
5. chooses storage;
6. presses Save and receive;
7. confirm exactly one purchase and the expected inventory movements;
8. confirm the linked store group now opens that same purchase.
