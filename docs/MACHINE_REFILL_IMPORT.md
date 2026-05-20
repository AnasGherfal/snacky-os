# Machine Refill History Import

The old operator refill form export is `Items - MachineRefills.csv`. It contains refill visit history, not product-level quantities.

Columns:

- `RefillID`
- `DateTime`
- `Machine Name`
- `OperatorEmail`
- `MachinePhoto`
- `FillStatus`
- `IssuesFound`
- `IssueNotes`

## What The Import Does

The import stores rows in `machine_refill_history` and links them to current Snacky OS records when possible:

- Machine is matched by `machine_code`, `vms_machine_id`, `serial_number`, or `name`.
- Operator is matched by email. Missing operators are created as active operator team members.
- Machine photo URLs are stored as URLs. Local/relative photo paths are preserved as paths.
- Issue flags are preserved on the history row.
- Historical issue flags can create closed `issues` records linked back to the refill history row.

The import does not create `inventory_movements`. The CSV does not include product quantities, so creating stock movement rows would corrupt the ledger.

## Run The Import

Apply migrations first:

```bash
npx supabase db push
```

Run a dry run:

```bash
npm run import:machine-refills -- --dry-run --file "C:\Users\anas2\Downloads\Items - MachineRefills.csv"
```

Run the actual import:

```bash
npm run import:machine-refills -- --file "C:\Users\anas2\Downloads\Items - MachineRefills.csv"
```

If the machine master data is incomplete and you intentionally want the import to create missing machine placeholders:

```bash
npm run import:machine-refills -- --file "C:\Users\anas2\Downloads\Items - MachineRefills.csv" --create-missing-machines
```

Use `--no-issues` if you want issue flags kept only on `machine_refill_history` without creating closed historical issue records.

## Where It Shows Up

- `/refills`: historical refill forms and issue flags.
- `/machines-dashboard`: machine refill count includes both current route refills and imported historical refill forms.

## Review After Import

Check rows with `import_status = 'needs_review'`:

```sql
select legacy_refill_id, refill_at, machine_name, operator_email, review_reason
from machine_refill_history
where import_status = 'needs_review'
order by refill_at desc;
```

Common review reasons:

- Machine name did not match current machine master data.
- Operator email did not match and could not be created.
- Date/time was missing or invalid.
