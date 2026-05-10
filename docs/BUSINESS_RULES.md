# Snacky OS Business Rules

## Refill Rules

A product needs refill when:

1. Current VMS quantity is 0.
2. Current VMS quantity is less than or equal to min quantity.
3. Current VMS quantity is below par quantity and the machine is already scheduled for refill.
4. Current VMS quantity is projected to run out before the next planned visit, once sales velocity exists.

Suggested quantity:

```text
suggested_qty = par_qty - current_qty
```

Final quantity:

```text
final_qty_to_take = min(suggested_qty, available_storage_qty)
```

Priority:

- Critical: current_qty = 0
- High: current_qty <= min_qty
- Medium: current_qty < par_qty
- Low: no immediate action

## Inventory Rules

Inventory is never edited directly as a final business action. All stock changes must create inventory movements.

Movement types:

- Purchase Received
- Storage to Operator Bag
- Operator Bag to Machine
- Operator Bag to Storage
- Machine to Storage
- Expired
- Damaged
- Stock Count Adjustment
- Missing / Theft

Stock flow:

```text
Supplier → Storage → Operator Bag → Machine → Sale
```

Return flow:

```text
Operator Bag → Storage
Machine → Storage
Machine → Damaged / Expired / Waste
```

## Cash Rules

Cash variance:

```text
variance = actual_cash_collected - vms_expected_cash
```

Variance status:

- OK: absolute variance <= allowed threshold
- Review Required: absolute variance > allowed threshold

Initial allowed threshold:

```text
10 LYD or 1% of expected cash, whichever is higher
```

## Issue SLA Rules

- Critical issues due in 24 hours.
- High priority issues due in 24 hours.
- Normal issues due in 72 hours.
- Cosmetic/low issues due in 72 hours.

## Dashboard Rules

The dashboard should prioritize decisions, not decoration. It should show:

- Machines needing refill
- Critical stockouts
- Open issues
- Overdue issues
- Cash variances requiring review
- Low storage products
- Machine sales ranking
- Machine profit ranking
- Operator route completion
