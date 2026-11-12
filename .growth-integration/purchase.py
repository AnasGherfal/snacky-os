from pathlib import Path
from hashlib import sha256
root = Path.cwd()
path = root / 'src/app/purchases/[id]/page.tsx'
source = path.read_text()
assert sha256(source.encode()).hexdigest() == '663dbd92af5974c29332fc56c7636dd38f536133531dc1f0e4bc53e0d3f71727'
def replace(old, new):
    global source
    assert source.count(old) == 1, old[:120]
    source = source.replace(old, new)
replace('import Link from "next/link";', 'import Link from "next/link";\nimport { readCompleteList } from "@/lib/complete-list-read";')
replace('  const [\n    { data: purchase, error: purchaseError },', '  const purchaseReadSignal = AbortSignal.timeout(10000);\n  const [\n    { data: purchase, error: purchaseError },')
replace('''    supabase
      .from("purchase_order_lines")
      .select("id, line_position, boxes_qty, units_per_box, loose_units_qty, total_units, ordered_qty, received_qty, unit_cost, line_total, unit_cost_lyd, line_total_lyd, product:products(id, sku, name)")
      .eq("purchase_order_id", id)
      .order("line_position")
      .order("created_at"),''', '''    readCompleteList<any>(
      ({from,to,signal}) => supabase.from("purchase_order_lines")
        .select("id, line_position, boxes_qty, units_per_box, loose_units_qty, total_units, ordered_qty, received_qty, unit_cost, line_total, unit_cost_lyd, line_total_lyd, product:products!purchase_order_lines_product_id_fkey(id, sku, name)", {count:"exact"})
        .eq("purchase_order_id",id).order("line_position").order("created_at").order("id")
        .range(from,to).abortSignal(signal),
      {key:row=>row.id,signal:purchaseReadSignal},
    ),''')
replace('''    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, to_entity_type, reason, related_purchase_line_id, unit_cost_lyd, line_total_lyd, notes, created_at, product:products(name, sku), created_by_member:team_members(full_name)", { count: "exact" })
      .eq("related_purchase_id", id)
      .order("created_at", { ascending: false }),''', '''    readCompleteList<any>(
      ({from,to,signal}) => supabase.from("inventory_movements")
        .select("id, product_id, quantity, from_entity_type, to_entity_type, reason, related_purchase_line_id, unit_cost_lyd, line_total_lyd, notes, created_at, product:products(name, sku), created_by_member:team_members(full_name)", {count:"exact"})
        .eq("related_purchase_id",id).order("created_at",{ascending:false}).order("id")
        .range(from,to).abortSignal(signal),
      {key:row=>row.id,signal:purchaseReadSignal},
    ),''')
replace('''  if (movementsError) console.error("[purchases:detail] Failed to load inventory movements", { purchase_id: id, supabase_error: movementsError });''', '''  if (movementsError) console.error("[purchases:detail] Failed to load inventory movements", { purchase_id: id, supabase_error: movementsError });
  if (linesError || movementsError) {
    return <ErrorState title="Purchase details are incomplete"
      body="Snacky could not verify every purchase item and inventory receipt. This is not an empty purchase. No changes were made; reload before receiving, paying or correcting this purchase."
      action={<SecondaryButton href={`/purchases/${id}${moduleQuery}`}>Retry complete purchase</SecondaryButton>} />;
  }''')
assert sha256(source.encode()).hexdigest() == '9f8ae18348e0695d88f6ae1d6130bcf900f7d1c3e3b562e630178c444eab6f48'
path.write_text(source)
test = root / 'scripts/test-growth-hardening.mjs'
assert sha256(test.read_bytes()).hexdigest() == '3527e8c6d70bc0fd4d73d918816377e82c295fe866a53669b34dfcb253efd72c'
with test.open('a') as out:
    out.write('''
test('purchase detail uses explicit product foreign key and blocks incomplete receipts',()=>{
  const purchase=source('src/app/purchases/[id]/page.tsx');
  assert.match(purchase,/product:products!purchase_order_lines_product_id_fkey/);
  assert.ok((purchase.match(/readCompleteList<any>/g)??[]).length>=2);
  assert.match(purchase,/if \\(linesError \\|\\| movementsError\\)/);
  assert.match(purchase,/This is not an empty purchase/);
});
''')
print('Purchase relationship and full-list fix verified; no financial data changed.')
