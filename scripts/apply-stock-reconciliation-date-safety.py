from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(source: str, label: str, before: str, after: str) -> str:
    count = source.count(before)
    if count == 0 and after in source:
        return source
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(before, after, 1)


migration_path = "supabase/migrations/202607170001_stock_reconciliation_missing_items.sql"
migration = read(migration_path)

migration = replace_once(
    migration,
    "sales coverage metadata",
    '''sales_mode as (
  select
    case
      when session.period_start = date_trunc('month', session.period_start)::date
        and exists (select 1 from monthly_batches)
      then 'monthly_product_profit'
      when exists (select 1 from detailed_sales)
      then 'detailed_transactions'
      else 'none'
    end as sales_source
  from session_row session
),''',
    '''sales_mode as (
  select
    case
      when session.period_start = date_trunc('month', session.period_start)::date
        and exists (select 1 from monthly_batches)
      then 'monthly_product_profit'
      when exists (select 1 from detailed_sales)
      then 'detailed_transactions'
      else 'none'
    end as sales_source,
    case
      when session.period_start = date_trunc('month', session.period_start)::date
        and exists (select 1 from monthly_batches)
      then (select max(report_end_date) from monthly_batches)
      when exists (select 1 from detailed_sales)
      then session.period_end
      else null
    end as sales_coverage_end
  from session_row session
),''',
)

migration = replace_once(
    migration,
    "calculated alignment flags",
    '''    closing.machine_count_at,
    greatest(coalesce(products.cost_price, 0), 0)::numeric as unit_cost,
    mode.sales_source
  from product_scope scope''',
    '''    closing.machine_count_at,
    greatest(coalesce(products.cost_price, 0), 0)::numeric as unit_cost,
    mode.sales_source,
    mode.sales_coverage_end,
    (session.baseline_at::date > session.period_start) as baseline_misaligned,
    (session.cutoff_at is null or session.cutoff_at::date < session.period_end) as closing_misaligned,
    session.period_end
  from product_scope scope''',
)
migration = replace_once(
    migration,
    "calculated session join",
    '''  left join selected_sales sales on sales.product_id = products.id
  cross join sales_mode mode
),''',
    '''  left join selected_sales sales on sales.product_id = products.id
  cross join sales_mode mode
  cross join session_row session
),''',
)

migration = replace_once(
    migration,
    "date alignment confidence",
    '''    case
      when calculated.opening_rows <= 0 or calculated.closing_rows <= 0 or calculated.sales_source = 'none' then 'data_gap'
      when not calculated.opening_storage_manual or not calculated.opening_operator_manual''',
    '''    case
      when calculated.opening_rows <= 0 or calculated.closing_rows <= 0 or calculated.sales_source = 'none' then 'data_gap'
      when calculated.baseline_misaligned or calculated.closing_misaligned then 'data_gap'
      when calculated.sales_coverage_end is null then 'data_gap'
      when calculated.sales_coverage_end < calculated.period_end then 'suspected'
      when not calculated.opening_storage_manual or not calculated.opening_operator_manual''',
)

migration = replace_once(
    migration,
    "data gap missing units exclusion",
    '''  rows.variance_units,
  rows.missing_units,
  rows.extra_units,
  rows.unit_cost,
  (rows.missing_units * rows.unit_cost)::numeric as missing_cost,''',
    '''  rows.variance_units,
  case when rows.confidence = 'data_gap' then 0 else rows.missing_units end as missing_units,
  rows.extra_units,
  rows.unit_cost,
  case when rows.confidence = 'data_gap' then 0 else (rows.missing_units * rows.unit_cost)::numeric end as missing_cost,''',
)
write(migration_path, migration)

page_path = "src/app/inventory/reconciliation/page.tsx"
page = read(page_path)
page = replace_once(
    page,
    "default cutoff yesterday",
    '''function currentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  return { start, end };
}''',
    '''function currentMonthRange() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = monthStart.toISOString().slice(0, 10);
  const end = (yesterday < monthStart ? monthStart : yesterday).toISOString().slice(0, 10);
  return { start, end };
}''',
)
page = replace_once(
    page,
    "data gap not missing note",
    '''            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"><span className="font-semibold">Count rule:</span> machine stock comes from the latest VMS snapshot. Storage and operator values start as ledger estimates and become confirmed only after you enter physical totals below.</div>''',
    '''            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"><span className="font-semibold">Count rule:</span> machine stock comes from the latest VMS snapshot. Storage and operator values start as ledger estimates and become confirmed only after you enter physical totals below. Date-misaligned checkpoints remain data gaps and are excluded from missing-unit and missing-cost totals.</div>''',
)
write(page_path, page)

for path, markers in {
    migration_path: [
        "sales_coverage_end",
        "baseline_misaligned",
        "closing_misaligned",
        "case when rows.confidence = 'data_gap' then 0 else rows.missing_units end",
    ],
    page_path: [
        "now.getUTCDate() - 1",
        "excluded from missing-unit and missing-cost totals",
    ],
}.items():
    content = read(path)
    missing = [marker for marker in markers if marker not in content]
    if missing:
        raise RuntimeError(f"{path}: missing markers {missing}")

print("Stock reconciliation date safety applied.")
