from pathlib import Path

page = Path(__file__).resolve().parents[1] / "src/app/reports/cash-reconciliation/page.tsx"
source = page.read_text(encoding="utf-8")

replacements = [
    (
        '>{formatInteger(selectedSummary.countedCollectionCount)} count record(s), filtered by counted_at</div></section>',
        '>{formatInteger(selectedSummary.countedCollectionCount)} count record(s), filtered by counted_at. See exactly which machines below.</div></section>',
        "counted cash card",
    ),
    (
        '<h2 className="text-base font-semibold text-slate-950">Machine reconciliation</h2>\n              <p className="mt-1 text-sm text-slate-500">VMS sales and cash counted in the selected duration, grouped by machine.</p>',
        '<h2 className="text-base font-semibold text-slate-950">Which machine has the difference?</h2>\n              <p className="mt-1 text-sm text-slate-500">Each row compares that machine\'s VMS expected sales with the cash Finance counted for that machine during the selected dates. Largest differences appear first.</p>',
        "machine section heading",
    ),
    (
        'headers={["Machine", "Location", "VMS sales", "Units", "Cash counted", "Difference", "Match rate", "Count records", "Latest count", "Status"]}',
        'headers={["Machine", "Location", "VMS expected sales for machine", "VMS units", "Cash counted for machine", "Difference for machine", "Match rate", "Counted pickups", "Latest finance count", "Result"]}',
        "machine table headers",
    ),
    (
        '{machineRows.map((row) => (',
        '{[...machineRows].sort((left, right) => Math.abs(right.rangeVariance) - Math.abs(left.rangeVariance) || right.vmsSalesAmount - left.vmsSalesAmount || left.machineLabel.localeCompare(right.machineLabel)).map((row) => (',
        "machine difference sorting",
    ),
    (
        '{row.machineCode ?? row.machineId ?? "Unmatched VMS row"}',
        '{row.machineCode ?? row.machineId ?? "Unmatched VMS/cash machine — fix mapping"}',
        "unmatched machine warning",
    ),
]

for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    source = source.replace(old, new, 1)

page.write_text(source, encoding="utf-8")
print("Machine-level cash labels applied.")
