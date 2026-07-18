from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/202607170001_stock_reconciliation_missing_items.sql"

source = MIGRATION.read_text(encoding="utf-8")
old = "order by rows.missing_cost desc, rows.missing_units desc, rows.product_name;"
new = "order by missing_cost desc, missing_units desc, rows.product_name;"

if old not in source:
    if new in source:
        print("Stock reconciliation ORDER BY hotfix already applied.")
        raise SystemExit(0)
    raise RuntimeError("Could not locate the invalid stock reconciliation ORDER BY expression.")

source = source.replace(old, new, 1)
if "rows.missing_cost" in source:
    raise RuntimeError("Invalid rows.missing_cost reference remains after hotfix.")

MIGRATION.write_text(source, encoding="utf-8")
print("Stock reconciliation ORDER BY hotfix applied.")
