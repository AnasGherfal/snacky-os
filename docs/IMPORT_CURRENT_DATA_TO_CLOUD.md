# Import Current Data To Cloud

Use this one-time importer for business CSV data in `docs/current-data`.

Do not use `supabase db push --include-seed` for cloud business data.

## What It Imports

The script imports business data only:

- `locations` derived from `locations.csv` or `machines.csv`
- `suppliers` derived from `suppliers.csv` or `purchases.csv`
- `products`
- `machines`
- `storage_locations`
- `vms_product_mappings`
- `machine_slots` from `machine_slots.csv` or `machine_planograms.csv`
- `purchase_orders`
- `purchase_order_lines`
- `inventory_movements` from `storage_inventory.csv`
- `financial_transactions`

It also understands the raw AppSheet-style filenames when they are placed in `docs/current-data`, such as `Items - Purchases.csv`, `Items - PurchaseLines.csv`, `Items - Inventory.csv`, and `Items - Inventory_Old.csv`.

It does not import `auth.users`, sessions, tokens, passwords, or Supabase Auth data.

## Environment

Create `.env.import.local` in the repo root:

```bash
CLOUD_SUPABASE_URL=https://your-project-ref.supabase.co
CLOUD_SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Use the service role key only from a local/server-side import environment. Do not expose it in browser code and do not commit `.env.import.local`.

## Run

Dry run first:

```bash
npx tsx scripts/import-current-data-to-cloud.ts --dry-run
```

Import to cloud:

```bash
npx tsx scripts/import-current-data-to-cloud.ts
```

Optional custom directory:

```bash
npx tsx scripts/import-current-data-to-cloud.ts --data-dir docs/current-data --dry-run
```

## Behavior

- Reads CSV files from `docs/current-data`.
- Uses `CLOUD_SUPABASE_URL` and `CLOUD_SUPABASE_SERVICE_ROLE_KEY`.
- Uses upsert where the schema has a usable conflict key.
- Deduplicates source rows before writing and keeps the most complete duplicate row.
- Skips bad rows instead of failing the whole import.
- Logs skipped rows with file, row number, and reason.
- Prints a summary with rows read, rows imported, rows skipped, existing rows skipped, and errors by table.

Some tables in the current schema do not have a unique source key, so the importer uses safe lookup/update behavior or stable import markers instead of creating duplicate ledger rows.
