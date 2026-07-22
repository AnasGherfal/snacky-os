from pathlib import Path

api_path = Path('src/app/api/operator/routes/[id]/pick-list/route.ts')
api = api_path.read_text(encoding='utf-8')
old_filter = '      if (pendingStopIds.size && stop && String(stop.status ?? "") !== ROUTE_STOP_PENDING_STATUS) return;'
new_filter = '      if (stop && !includesRelevantStop(String(stop.id ?? ""))) return;'
if old_filter not in api:
    raise SystemExit('pending-only stop filter not found')
api = api.replace(old_filter, new_filter, 1)
api_path.write_text(api, encoding='utf-8')

page_path = Path('src/app/operator/routes/[id]/pick-list/page.tsx')
page = page_path.read_text(encoding='utf-8')
old_block = '''  const activePreparedBatch = preparedBatch && !preparedBatch.confirmedAt && !preparedBatch.returnedToAssignedAt ? preparedBatch : null;
  const checklistFrozen = Boolean(activePreparedBatch);
  const preparedLoadRows = (activePreparedBatch?.productSummary?.length ? activePreparedBatch.productSummary : routeTotals.map((item) => ({
'''
new_block = '''  const preparedSummaryMatchesRouteTotals = useMemo(() => {
    if (!preparedBatch?.productSummary?.length) return true;
    const expected = new Map(routeTotals.filter((item) => item.confirmedQty > 0).map((item) => [item.productId, item.confirmedQty]));
    const prepared = new Map(preparedBatch.productSummary.filter((item) => item.quantity > 0).map((item) => [item.productId, item.quantity]));
    if (expected.size !== prepared.size) return false;
    return Array.from(expected.entries()).every(([productId, quantity]) => prepared.get(productId) === quantity);
  }, [preparedBatch, routeTotals]);
  const activePreparedBatch = preparedBatch && !preparedBatch.confirmedAt && !preparedBatch.returnedToAssignedAt && preparedSummaryMatchesRouteTotals ? preparedBatch : null;
  const checklistFrozen = Boolean(activePreparedBatch);
  const preparedLoadRows = (activePreparedBatch?.productSummary?.length ? activePreparedBatch.productSummary : routeTotals.map((item) => ({
'''
if old_block not in page:
    raise SystemExit('prepared batch block not found')
page = page.replace(old_block, new_block, 1)
page_path.write_text(page, encoding='utf-8')

test_path = Path('scripts/test-stale-pickup-recovery.mjs')
test_path.write_text('''import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport test from "node:test";\n\nconst api = fs.readFileSync("src/app/api/operator/routes/[id]/pick-list/route.ts", "utf8");\nconst page = fs.readFileSync("src/app/operator/routes/[id]/pick-list/page.tsx", "utf8");\n\ntest("active route stops remain in the pickup plan", () => {\n  assert.doesNotMatch(api, /pendingStopIds\\.size && stop/);\n  assert.match(api, /if \\(stop && !includesRelevantStop\\(String\\(stop\\.id/);\n});\n\ntest("stale prepared snapshots do not freeze the checklist", () => {\n  assert.match(page, /preparedSummaryMatchesRouteTotals/);\n  assert.match(page, /&& preparedSummaryMatchesRouteTotals \\? preparedBatch : null/);\n  assert.match(page, /prepared\\.get\\(productId\\) === quantity/);\n});\n''', encoding='utf-8')
