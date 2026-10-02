# VMS Import Specification

Snacky OS must support VMS import by CSV now and API later.

## Required Import Types

1. Stock snapshot import
2. Sales snapshot import
3. Cash/collection expected amount import, if available from VMS
4. Machine status import, if available from VMS

## VMS Stock CSV Fields

The system should support mapping CSV columns to internal fields.

Minimum fields:

- vms_machine_id
- machine_name
- slot_code
- vms_product_id or vms_product_name
- current_qty
- capacity, optional if machine_slots already has capacity
- last_updated

## VMS Sales CSV Fields

Minimum fields:

- vms_machine_id
- machine_name
- vms_product_id or vms_product_name
- sold_qty
- total_sales
- cash_sales, optional
- card_sales, optional
- date

## Import Flow

1. Admin uploads CSV.
2. System creates `vms_import_batches` row.
3. System parses CSV.
4. System detects unknown machines.
5. System detects unknown products.
6. System uses `vms_product_mappings` to connect VMS products to Snacky products.
7. System saves valid rows into `vms_stock_snapshots` or `vms_sales_snapshots`.
8. System shows import summary:
   - imported rows
   - skipped rows
   - machines needing mapping
   - products needing mapping
9. Refill recommendations update automatically.

## Mapping Rule

VMS product names are not trusted as internal product names.

Always map:

```text
VMS product → Snacky product
```

Mapping statuses:

- Confirmed
- Needs Review
- Ignored

## Future API Rule

Do not design import as CSV-only. Build an import service that accepts normalized rows. CSV parser and future API sync should both feed the same normalization logic.
