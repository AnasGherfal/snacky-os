from pathlib import Path

# Applies the smallest possible repair, then the workflow validates pickup and inventory behavior.
path = Path('src/app/api/operator/routes/[id]/pick-list/route.ts')
text = path.read_text(encoding='utf-8')
text = text.replace(
    'import { isTerminalRouteStatus, ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";',
    'import { isRouteStopDoneStatus, isTerminalRouteStatus, ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";'
)
old = '''    const pendingStopIds = new Set(
      stops
        .filter((stop: any) => String(stop.status ?? "") === ROUTE_STOP_PENDING_STATUS)
        .map((stop: any) => String(stop.id ?? ""))
        .filter(Boolean),
    );
    const relevantStopIds = pendingStopIds.size
      ? pendingStopIds
      : new Set(stops.map((stop: any) => String(stop.id ?? "")).filter(Boolean));
'''
new = '''    const pendingStopIds = new Set(
      stops
        .filter((stop: any) => String(stop.status ?? "") === ROUTE_STOP_PENDING_STATUS)
        .map((stop: any) => String(stop.id ?? ""))
        .filter(Boolean),
    );
    const preparedStopIds = new Set(
      Array.isArray(preparedBatch?.selectedStopIds)
        ? preparedBatch.selectedStopIds.map((stopId: unknown) => String(stopId ?? "")).filter(Boolean)
        : [],
    );
    const actionableStopIds = new Set(
      stops
        .filter((stop: any) => !isRouteStopDoneStatus(String(stop.status ?? ROUTE_STOP_PENDING_STATUS)))
        .map((stop: any) => String(stop.id ?? ""))
        .filter(Boolean),
    );
    preparedStopIds.forEach((stopId) => actionableStopIds.add(stopId));
    const relevantStopIds = actionableStopIds.size
      ? actionableStopIds
      : new Set(stops.map((stop: any) => String(stop.id ?? "")).filter(Boolean));
'''
if old not in text:
    raise SystemExit('target block not found')
text = text.replace(old, new)
path.write_text(text, encoding='utf-8')

test_path = Path('scripts/test-active-route-pickup-quantity.mjs')
test_path.write_text('''import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport test from "node:test";\n\nconst source = fs.readFileSync("src/app/api/operator/routes/[id]/pick-list/route.ts", "utf8");\n\ntest("pickup keeps pending and active stops visible after route start", () => {\n  assert.match(source, /isRouteStopDoneStatus/);\n  assert.match(source, /const actionableStopIds = new Set/);\n  assert.match(source, /!isRouteStopDoneStatus\(String\(stop\.status/);\n  assert.doesNotMatch(source, /const relevantStopIds = pendingStopIds\.size/);\n});\n\ntest("prepared pickup stops remain visible for retry after a lag", () => {\n  assert.match(source, /const preparedStopIds = new Set/);\n  assert.match(source, /preparedStopIds\.forEach\(\(stopId\) => actionableStopIds\.add\(stopId\)\)/);\n});\n''', encoding='utf-8')
