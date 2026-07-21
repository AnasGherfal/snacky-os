from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Route list: use only production-safe machine columns and never render every stop as Unknown Machine.
path = "src/app/routes/page.tsx"
text = read(path)
text = replace_once(
    text,
    'await supportClient.from("machines").select("id, name, machine_code, machine_display_name, location:locations(id, name, area)").in("id", stopMachineIds)',
    'await supportClient.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", stopMachineIds)',
    "route list machine columns",
)
text = replace_once(
    text,
    '      const label = formatMachineDisplayName(stopMachineById.get(stop.machine_id) ?? null, { includeArea: true });',
    '''      const machine = stopMachineById.get(stop.machine_id);\n      const label = machine\n        ? formatMachineDisplayName(machine, { includeArea: true })\n        : `Machine ${String(stop.machine_id ?? "").slice(0, 8)}`;''',
    "route stop label fallback",
)
text = replace_once(text, '{operatorsError || stopsError ? (', '{operatorsError || stopsError || stopMachinesError ? (', "route list warning")
write(path, text)


# Machine history: route_stops has no reliable created_at column. Use schema-safe lookup plus legacy evidence fallbacks.
path = "src/app/machines/[id]/page.tsx"
text = read(path)
text = replace_once(
    text,
    '  const { data: stops, error: stopsError } = await client.from("route_stops").select("id, route_id, stop_order, status").eq("machine_id", id).order("created_at", { ascending: false }).limit(500);\n  const routeIds = Array.from(new Set((stops ?? []).map((row: any) => row.route_id).filter(Boolean)));',
    '''  const stopsResult = await client.from("route_stops").select("id, route_id, stop_order, status").eq("machine_id", id).limit(500);\n  let stops: any[] = stopsResult.data ?? [];\n  let stopsError = stopsResult.error;\n  if (!stops.length) {\n    const [stopItemsResult, refillOrdersResult, refillHistoryResult] = await Promise.all([\n      client.from("route_stop_items").select("route_id, route_stop_id, machine_id").eq("machine_id", id).limit(1000),\n      client.from("refill_orders").select("route_id, machine_id").eq("machine_id", id).limit(1000),\n      client.from("machine_refill_history").select("route_id, machine_id").eq("machine_id", id).limit(1000),\n    ]);\n    const fallbackRouteIds = Array.from(new Set([\n      ...(stopItemsResult.data ?? []).map((row: any) => row.route_id),\n      ...(refillOrdersResult.data ?? []).map((row: any) => row.route_id),\n      ...(refillHistoryResult.data ?? []).map((row: any) => row.route_id),\n    ].filter(Boolean)));\n    if (fallbackRouteIds.length) {\n      stops = fallbackRouteIds.map((routeId, index) => ({ id: `history-${index}-${routeId}`, route_id: routeId, stop_order: null, status: null }));\n      stopsError = null;\n    }\n  }\n  const routeIds = Array.from(new Set(stops.map((row: any) => row.route_id).filter(Boolean)));''',
    "machine route history lookup",
)
text = replace_once(
    text,
    'client.from("inventory_movements").select("id, related_route_id, quantity, reason, from_entity_type, to_entity_type, created_at, product:products(name)")',
    'client.from("inventory_movements").select("id, related_route_id, quantity, reason, movement_type, from_entity_type, to_entity_type, created_at, product:products(name)")',
    "machine movement type",
)
text = replace_once(
    text,
    '  const machineStorage = movements.filter((row: any) => row.reason === "extra_stock_left_at_machine" || (row.from_entity_type === "operator_bag" && row.to_entity_type === "machine"));',
    '''  const machineStorage = movements.filter((row: any) => {\n    const reason = String(row.reason ?? "").toLowerCase();\n    return row.to_entity_type === "machine_storage"\n      || row.movement_type === "route_to_machine_storage"\n      || reason === "extra_stock_left_at_machine"\n      || reason === "machine_storage";\n  });''',
    "machine explicit storage filter",
)
write(path, text)


# Operator history: same explicit storage semantics and production-safe machine columns.
path = "src/app/team/[id]/page.tsx"
text = read(path)
text = replace_once(
    text,
    'client.from("inventory_movements").select("id, related_route_id, related_machine_id, quantity, reason, from_entity_type, to_entity_type, created_at, product:products(name)")',
    'client.from("inventory_movements").select("id, related_route_id, related_machine_id, quantity, reason, movement_type, from_entity_type, to_entity_type, created_at, product:products(name)")',
    "operator movement type",
)
text = replace_once(
    text,
    'await client.from("machines").select("id, name, machine_code, machine_display_name, location:locations(id, name, area)").in("id", machineIds)',
    'await client.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", machineIds)',
    "operator machine columns",
)
text = replace_once(
    text,
    '  const machineStorage = movements.filter((row:any)=>row.reason === "extra_stock_left_at_machine" || (row.from_entity_type === "operator_bag" && row.to_entity_type === "machine"));',
    '''  const machineStorage = movements.filter((row:any)=>{\n    const reason = String(row.reason ?? "").toLowerCase();\n    return row.to_entity_type === "machine_storage"\n      || row.movement_type === "route_to_machine_storage"\n      || reason === "extra_stock_left_at_machine"\n      || reason === "machine_storage";\n  });''',
    "operator explicit storage filter",
)
write(path, text)


# Completed route outcome: count only manually assigned storage movements, never normal machine fills.
path = "src/app/routes/[id]/page.tsx"
text = read(path)
text = replace_once(
    text,
    '.select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")',
    '.select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, movement_type, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")',
    "route movement type",
)
text = replace_once(
    text,
    '''  const machineStorageMovements = (movements ?? []).filter((movement: any) => {\n    const reason = String(movement.reason ?? "").toLowerCase();\n    return reason === "extra_stock_left_at_machine"\n      || reason === "machine_storage"\n      || (movement.from_entity_type === "operator_bag" && movement.to_entity_type === "machine");\n  });''',
    '''  const machineStorageMovements = (movements ?? []).filter((movement: any) => {\n    const reason = String(movement.reason ?? "").toLowerCase();\n    return movement.to_entity_type === "machine_storage"\n      || movement.movement_type === "route_to_machine_storage"\n      || reason === "extra_stock_left_at_machine"\n      || reason === "machine_storage";\n  });''',
    "route explicit storage filter",
)
write(path, text)


# Regression assertions for the exact failures reported from production.
path = "scripts/test-critical-workflows.mjs"
text = read(path)
addition = '''\n\ntest("machine storage and history use explicit storage records and schema-safe route links", () => {\n  const routeDetail = readFileSync("src/app/routes/[id]/page.tsx", "utf8");\n  const routesPage = readFileSync("src/app/routes/page.tsx", "utf8");\n  const machinePage = readFileSync("src/app/machines/[id]/page.tsx", "utf8");\n  const teamPage = readFileSync("src/app/team/[id]/page.tsx", "utf8");\n\n  for (const source of [routeDetail, machinePage, teamPage]) {\n    assert.match(source, /route_to_machine_storage/);\n    assert.match(source, /to_entity_type === "machine_storage"/);\n    assert.doesNotMatch(source, /from_entity_type === "operator_bag" && .*to_entity_type === "machine"/);\n  }\n\n  assert.doesNotMatch(routesPage, /machine_display_name/);\n  assert.match(routesPage, /location:locations\\(id, name\\)/);\n  assert.match(machinePage, /route_stop_items/);\n  assert.match(machinePage, /refill_orders/);\n  assert.equal(machinePage.includes('.from("route_stops").select("id, route_id, stop_order, status").eq("machine_id", id).order("created_at"'), false);\n  assert.doesNotMatch(teamPage, /machine_display_name/);\n});\n'''
if 'test("machine storage and history use explicit storage records and schema-safe route links"' not in text:
    text += addition
write(path, text)
