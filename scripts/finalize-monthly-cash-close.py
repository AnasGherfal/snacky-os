from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

finance_path = ROOT / "src/app/finance/operations/page.tsx"
finance = finance_path.read_text()
before = '''      .not("counted_at", "is", null)
      .gte("counted_at", startTimestamp)
      .lte("counted_at", endTimestamp)'''
after = '''      .not("counted_at", "is", null)
      .gte("collected_at", startTimestamp)
      .lte("collected_at", endTimestamp)'''
if before in finance:
    finance = finance.replace(before, after, 1)
elif after not in finance:
    raise RuntimeError("Could not change cash reconciliation date basis to collected_at")
finance_path.write_text(finance)

cash_list_path = ROOT / "src/app/cash-collections/page.tsx"
cash_list = cash_list_path.read_text()
cash_list = cash_list.replace(
    '\n  const reviewCount = rows.filter((row: any) => getCashCollectionStatus(row.review_status, row.variance) === "variance_review").length;',
    "",
    1,
)
cash_list_path.write_text(cash_list)

print("Finalized monthly cash close date basis.")
