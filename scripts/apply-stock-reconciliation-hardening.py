from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, encoding="utf-8")


def replace_once(source: str, label: str, before: str, after: str) -> str:
    count = source.count(before)
    if count == 0 and after in source:
        return source
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(before, after, 1)


migration_path = "supabase/migrations/202607170001_stock_reconciliation_missing_items.sql"
migration = read(migration_path)
migration = migration.replace(
    "internal_types as (\n  select unnest(array['storage', 'operator_bag', 'machine'])::text as entity_type\n),\n",
    "",
)
migration = migration.replace("not in (select entity_type from internal_types)", "not in ('storage', 'operator_bag', 'machine')")
migration = migration.replace("in (select entity_type from internal_types)", "in ('storage', 'operator_bag', 'machine')")

old_opening = '''opening_by_type as (
  select
    counts.product_id,
    counts.entity_type,
    sum(counts.quantity_counted)::integer as quantity,
    count(*)::integer as row_count
  from public.stock_reconciliation_counts counts
  where counts.session_id = p_session_id
    and counts.count_phase = 'opening'
  group by counts.product_id, counts.entity_type
),
opening as (
  select
    product_id,
    sum(quantity)::integer as opening_units,
    sum(quantity) filter (where entity_type = 'machine')::integer as opening_machine_units,
    sum(row_count)::integer as opening_rows
  from opening_by_type
  group by product_id
),'''
new_opening = '''opening_by_type as (
  select
    counts.product_id,
    counts.entity_type,
    coalesce(
      sum(counts.quantity_counted) filter (where counts.count_source = 'manual' and counts.is_confirmed),
      sum(counts.quantity_counted) filter (where counts.count_source <> 'manual'),
      0
    )::integer as quantity,
    bool_or(counts.count_source = 'manual' and counts.is_confirmed) as has_manual,
    count(*)::integer as row_count
  from public.stock_reconciliation_counts counts
  where counts.session_id = p_session_id
    and counts.count_phase = 'opening'
  group by counts.product_id, counts.entity_type
),
opening as (
  select
    product_id,
    sum(quantity)::integer as opening_units,
    coalesce(sum(quantity) filter (where entity_type = 'machine'), 0)::integer as opening_machine_units,
    coalesce(bool_or(has_manual) filter (where entity_type = 'storage'), false) as storage_manual,
    coalesce(bool_or(has_manual) filter (where entity_type = 'operator_bag'), false) as operator_manual,
    sum(row_count)::integer as opening_rows
  from opening_by_type
  group by product_id
),'''
migration = replace_once(migration, "manual opening baseline", old_opening, new_opening)

migration = replace_once(
    migration,
    "calculated opening manual flags",
    '''    coalesce(opening.opening_machine_units, 0)::integer as opening_machine_units,
    coalesce(opening.opening_rows, 0)::integer as opening_rows,''',
    '''    coalesce(opening.opening_machine_units, 0)::integer as opening_machine_units,
    coalesce(opening.storage_manual, false) as opening_storage_manual,
    coalesce(opening.operator_manual, false) as opening_operator_manual,
    coalesce(opening.opening_rows, 0)::integer as opening_rows,''',
)
migration = replace_once(
    migration,
    "confidence requires opening and closing physical counts",
    "      when not calculated.storage_manual or not calculated.operator_manual then 'suspected'",
    "      when not calculated.opening_storage_manual or not calculated.opening_operator_manual\n        or not calculated.storage_manual or not calculated.operator_manual then 'suspected'",
)
write(migration_path, migration)

page_path = "src/app/inventory/reconciliation/page.tsx"
page = read(page_path)
page = replace_once(
    page,
    "manual count helper phase",
    '''function manualCountValue(
  counts: CountRow[],
  productId: string,
  entityType: CountRow["entity_type"],
) {
  const row = counts.find((count) => count.product_id === productId
    && count.count_phase === "closing"''',
    '''function manualCountValue(
  counts: CountRow[],
  productId: string,
  entityType: CountRow["entity_type"],
  countPhase: CountRow["count_phase"],
) {
  const row = counts.find((count) => count.product_id === productId
    && count.count_phase === countPhase''',
)
page = replace_once(
    page,
    "auto count helper phase",
    '''function autoCountValue(
  counts: CountRow[],
  productId: string,
  entityType: CountRow["entity_type"],
) {
  return counts
    .filter((count) => count.product_id === productId
      && count.count_phase === "closing"''',
    '''function autoCountValue(
  counts: CountRow[],
  productId: string,
  entityType: CountRow["entity_type"],
  countPhase: CountRow["count_phase"],
) {
  return counts
    .filter((count) => count.product_id === productId
      && count.count_phase === countPhase''',
)
count_phase_declaration = '  const countPhase = text(formData.get("count_phase")) === "opening" ? "opening" : "closing";\n'
while count_phase_declaration + count_phase_declaration in page:
    page = page.replace(count_phase_declaration + count_phase_declaration, count_phase_declaration)
if count_phase_declaration not in page:
    page = replace_once(
        page,
        "physical count phase input",
        '''  const productIds = Array.from(new Set(formData.getAll("product_id").map((value) => text(value)).filter(Boolean)));
  const now = new Date().toISOString();''',
        count_phase_declaration + '''  const productIds = Array.from(new Set(formData.getAll("product_id").map((value) => text(value)).filter(Boolean)));
  const now = new Date().toISOString();''',
    )
page = replace_once(page, "physical count payload phase", '        count_phase: "closing",', '        count_phase: countPhase,')
page = replace_once(
    page,
    "physical count note phase",
    '        notes: "Physical company total entered from Missing Items reconciliation",',
    '        notes: `Physical ${countPhase} company total entered from Missing Items reconciliation`,',
)
page = replace_once(
    page,
    "session status after physical count",
    '''  await supabase.from(SESSION_TABLE).update({ status: "review", updated_at: now }).eq("id", sessionId).neq("status", "closed");
  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=counts`);''',
    '''  await supabase.from(SESSION_TABLE).update({
    status: countPhase === "closing" ? "review" : "open",
    updated_at: now,
  }).eq("id", sessionId).neq("status", "closed");
  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=${countPhase}-counts`);''',
)

page = page.replace('autoCountValue(counts, row.product_id, "storage")', 'autoCountValue(counts, row.product_id, "storage", "closing")')
page = page.replace('autoCountValue(counts, row.product_id, "machine")', 'autoCountValue(counts, row.product_id, "machine", "closing")')
page = page.replace('autoCountValue(counts, row.product_id, "operator_bag")', 'autoCountValue(counts, row.product_id, "operator_bag", "closing")')
page = page.replace('manualCountValue(counts, row.product_id, "storage")', 'manualCountValue(counts, row.product_id, "storage", "closing")')
page = page.replace('manualCountValue(counts, row.product_id, "machine")', 'manualCountValue(counts, row.product_id, "machine", "closing")')
page = page.replace('manualCountValue(counts, row.product_id, "operator_bag")', 'manualCountValue(counts, row.product_id, "operator_bag", "closing")')

closing_marker = '''          {varianceRows.length ? (
            <section className="surface-card mb-6">
              <div><h2 className="text-lg font-semibold text-slate-950">Physical closing counts</h2>'''
opening_section = '''          {varianceRows.length ? (
            <section className="surface-card mb-6">
              <div><h2 className="text-lg font-semibold text-slate-950">Physical opening baseline</h2><p className="mt-1 text-sm text-slate-500">Confirm the opening totals that existed when this checkpoint began. Manual totals override the provisional opening ledger/VMS snapshot.</p></div>
              <form action={savePhysicalCounts} className="mt-4">
                <input type="hidden" name="session_id" value={selectedSession.id} />
                <input type="hidden" name="count_phase" value="opening" />
                <DataTable headers={["Product", "Auto storage", "Physical storage", "VMS machines", "Machine override", "Auto operator", "Physical operator"]}>
                  {varianceRows.map((row) => (
                    <tr key={row.product_id}>
                      <td><input type="hidden" name="product_id" value={row.product_id} /><div className="font-semibold text-slate-950">{row.product_name}</div><div className="text-xs text-slate-500">{reconciliationWholeNumber(row.case_quantity)} per box</div></td>
                      <td>{reconciliationQuantity(autoCountValue(counts, row.product_id, "storage", "opening"), row)}</td>
                      <td><input name={`storage__${row.product_id}`} type="number" min="0" step="1" className="field-input min-w-28" defaultValue={manualCountValue(counts, row.product_id, "storage", "opening")} placeholder="Count" /></td>
                      <td>{reconciliationQuantity(autoCountValue(counts, row.product_id, "machine", "opening"), row)}</td>
                      <td><input name={`machine__${row.product_id}`} type="number" min="0" step="1" className="field-input min-w-28" defaultValue={manualCountValue(counts, row.product_id, "machine", "opening")} placeholder="Optional" /></td>
                      <td>{reconciliationQuantity(autoCountValue(counts, row.product_id, "operator_bag", "opening"), row)}</td>
                      <td><input name={`operator_bag__${row.product_id}`} type="number" min="0" step="1" className="field-input min-w-28" defaultValue={manualCountValue(counts, row.product_id, "operator_bag", "opening")} placeholder="Count" /></td>
                    </tr>
                  ))}
                </DataTable>
                <div className="mt-4 flex justify-end"><FormSubmitButton className="btn-primary" pendingLabel="Saving opening counts...">Confirm opening baseline</FormSubmitButton></div>
              </form>
            </section>
          ) : null}

'''
if "Physical opening baseline" not in page:
    if closing_marker not in page:
        raise RuntimeError("opening count section: closing marker not found")
    page = page.replace(closing_marker, opening_section + closing_marker, 1)

page = replace_once(
    page,
    "closing count phase hidden input",
    '''              <form action={savePhysicalCounts} className="mt-4">
                <input type="hidden" name="session_id" value={selectedSession.id} />
                <DataTable headers={["Product", "Auto storage", "Physical storage", "VMS machines", "Machine override", "Auto operator", "Physical operator"]}>''',
    '''              <form action={savePhysicalCounts} className="mt-4">
                <input type="hidden" name="session_id" value={selectedSession.id} />
                <input type="hidden" name="count_phase" value="closing" />
                <DataTable headers={["Product", "Auto storage", "Physical storage", "VMS machines", "Machine override", "Auto operator", "Physical operator"]}>''',
)
write(page_path, page)

for path, markers in {
    migration_path: [
        "opening.storage_manual",
        "opening.operator_manual",
        "in ('storage', 'operator_bag', 'machine')",
    ],
    page_path: [
        "Physical opening baseline",
        'name="count_phase" value="opening"',
        'name="count_phase" value="closing"',
    ],
}.items():
    value = read(path)
    missing = [marker for marker in markers if marker not in value]
    if missing:
        raise RuntimeError(f"{path}: missing markers {missing}")

print("Stock reconciliation hardening applied.")
