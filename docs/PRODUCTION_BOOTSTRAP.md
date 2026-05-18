# Production Bootstrap

Use this only for the first Supabase Cloud staging or production data load.

The production bootstrap is separate from local development seed data:

- Development seed: `supabase/seed.sql`, used with local `npx supabase db reset`.
- Production bootstrap: `scripts/bootstrap-production-data.mjs`, used after migrations on Supabase Cloud.

Never run `npx supabase db reset` against production.

## What It Imports

The script reads `docs/current-data` and imports:

- Products from `products.csv`
- Machines from `machines.csv`
- Locations referenced by machines
- One default storage location named `MAIN`
- Net positive storage opening balances from `storage_inventory.csv`
- Finance transactions from `financial_transactions.csv`
- VMS product mappings from `vms_product_mappings.csv`

It does not create local development login users, and it does not run `supabase/seed.sql`.

## Idempotency

The script is safe to run again if a previous run stopped halfway:

- Products are skipped when the SKU already exists.
- Machines are skipped when the machine code or VMS machine ID already exists.
- Locations are skipped when the location name already exists.
- VMS mappings are skipped when the VMS product ID and name already exist.
- Finance transactions are skipped by `source_sheet` and `source_row`.
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
select count(*) as storage_locations from public.storage_locations;
select count(*) as vms_mappings from public.vms_product_mappings;

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
3. `/inventory` shows storage balances.
4. `/finance/transactions` shows imported finance rows.
5. `/vms-mappings` shows imported mappings.

## Known Source Data Notes

The source files use `TO_CONFIRM` where the original spreadsheets had missing required values. The bootstrap script does not import `TO_CONFIRM` as real operational values where it can avoid it:

- Product barcode and category placeholders are converted to `null` or the default `snack`.
- Missing machine locations are left unassigned.
- Storage rows are aggregated into net positive opening balances.
- Finance rows with missing category, location, description, or bucket are imported with `needs_review`.

Review imported data before letting operators use production routes.
