# Production Bootstrap

Use this only for the first Supabase Cloud staging or production data load.

The production bootstrap is separate from the SQL seed:

- Business-data seed: `supabase/seed.sql`, used with local `npx supabase db reset` or cloud `npx supabase db push --include-seed`. It loads the local business dataset but skips team/Auth users.
- Production bootstrap: `scripts/bootstrap-production-data.mjs`, used after migrations on Supabase Cloud.

Never run `npx supabase db reset` against production.

## Why Cloud Is Empty After Migrations

Supabase migrations create tables, columns, constraints, policies, and indexes. They do not load Snacky's operating data.

Local development looked populated because local setup used `supabase/seed.sql` and the exported files under `docs/current-data`. A new Supabase Cloud project starts with schema only until you run this production bootstrap or enter data through the app.

## What It Imports

The script reads `docs/current-data` and imports:

- Products from `products.csv`
- Machines from `machines.csv`
- Locations referenced by machines
- Machine planograms from `machine_planograms.csv`
- One default storage location named `MAIN`
- Net positive storage opening balances from `storage_inventory.csv`, imported through `inventory_movements`
- Finance transactions from `financial_transactions.csv`
- VMS product mappings from `vms_product_mappings.csv`
- Suppliers referenced by purchase history
- Historical purchases and purchase lines from `purchases.csv`

It does not create Auth users or team members, and it does not run `supabase/seed.sql`.

Purchase history is imported as purchase records and lines only. It does not replay purchase receipt inventory movements, because current storage stock is established by the opening-balance `inventory_movements`. Replaying historical purchases as stock movements would double count inventory.

The current source export does not include confirmed physical slot codes for `machine_planograms.csv`. The bootstrap uses the real VMS product number as a stable slot code like `VMS-114` when `slot_code` is `TO_CONFIRM`. Review planograms in `/machine-slots` before relying on refill recommendations.

## Idempotency

The script is safe to run again if a previous run stopped halfway:

- Products are skipped when the SKU already exists.
- Machines are skipped when the machine code or VMS machine ID already exists.
- Locations are skipped when the location name already exists.
- Machine planograms are skipped when a machine already has the same imported slot code.
- VMS mappings are skipped when the VMS product ID and name already exist.
- Finance transactions are skipped by `source_sheet` and `source_row`.
- Suppliers are skipped by exact supplier name.
- Purchase orders are skipped by `receipt_number`, which is set to the source `purchase_id`.
- Purchase lines are skipped by purchase order and source line position.
- Storage opening balances are skipped by a stable note marker:
  `production_bootstrap:storage_opening_balance:sku=<sku>:source=docs/current-data/storage_inventory.csv`

The script does not overwrite existing products, machines, or manually reviewed mappings. If a row already exists, it is treated as already bootstrapped.

## Prerequisites

1. Create and link the Supabase Cloud project.
2. Apply all migrations:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

3. Create the first production admin using [FIRST_PRODUCTION_ADMIN.md](./FIRST_PRODUCTION_ADMIN.md), or do it after the bootstrap if you prefer to load data first.
4. Set these environment variables in the shell that will run the script:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-or-secret-key
```

Use the service role or secret key only from a trusted machine. Do not commit it.

## Validate Source Files

This command parses `docs/current-data` without connecting to Supabase:

```bash
npm run bootstrap:production -- --check-files
```

## Dry Run

This connects to Supabase and reports what would be inserted:

```bash
npm run bootstrap:production -- --dry-run
```

The script refuses local Supabase URLs by default. For a local rehearsal only, add `--allow-local`.

## Run The Bootstrap

After reviewing the dry run:

```bash
npm run bootstrap:production -- --confirm-production-bootstrap
```

Run it once for staging first. If staging looks correct, run it once for production with the production Supabase environment variables.

## Verify After Running

Use these checks in Supabase SQL Editor:

```sql
select count(*) as products from public.products;
select count(*) as machines from public.machines;
select count(*) as machine_slots from public.machine_slots;
select count(*) as storage_locations from public.storage_locations;
select count(*) as vms_mappings from public.vms_product_mappings;
select count(*) as suppliers from public.suppliers;
select count(*) as purchase_orders from public.purchase_orders;
select count(*) as purchase_lines from public.purchase_order_lines;

select count(*) as opening_balance_movements
from public.inventory_movements
where notes like 'production_bootstrap:storage_opening_balance:%';

select count(*) as finance_transactions
from public.financial_transactions
where source_sheet = 'production_bootstrap_financial_transactions';
```

Then open Snacky OS and verify:

1. `/products` shows imported products.
2. `/machines` shows imported machines.
3. `/machine-slots` shows imported planograms.
4. `/inventory` shows storage balances.
5. `/finance/transactions` shows imported finance rows.
6. `/purchases` shows historical purchase records if `purchases.csv` was available.
7. `/vms-mappings` shows imported mappings.

## Known Source Data Notes

The source files use `TO_CONFIRM` where the original spreadsheets had missing required values. The bootstrap script does not import `TO_CONFIRM` as real operational values where it can avoid it:

- Product barcode and category placeholders are converted to `null` or the default `snack`.
- Missing machine locations are left unassigned.
- Machine planogram slot codes marked `TO_CONFIRM` are replaced with source-derived `VMS-<product-number>` slot codes for idempotent import, then should be reviewed.
- Storage rows are aggregated into net positive opening balances.
- Purchase history is imported without creating stock movements, because storage opening balances are the production inventory baseline.
- Finance rows with missing category, location, description, or bucket are imported with `needs_review`.

Review imported data before letting operators use production routes.
