from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, encoding="utf-8")


def replace_once(source: str, before: str, after: str, label: str) -> str:
    if after in source:
        return source
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(before, after, 1)


def regex_once(source: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    if re.search(re.escape(replacement), source):
        return source
    matches = list(re.finditer(pattern, source, flags))
    if len(matches) != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {len(matches)}")
    return re.sub(pattern, replacement, source, count=1, flags=flags)


# Access control.
authz_path = "src/lib/authz.ts"
authz = read(authz_path)
planning_access = '  if (matchesPrefix(pathname, ["/product-planning"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view") || hasPermission(user, "purchases.view") || hasPermission(user, "finance.view");'
if planning_access not in authz:
    anchor = '  if (matchesPrefix(pathname, ["/restock-priority"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view");'
    authz = replace_once(authz, anchor, planning_access + "\n" + anchor, "product planning access")
write(authz_path, authz)


# Inventory packaging display.
inventory_path = "src/app/inventory/page.tsx"
inv = read(inventory_path)
inv = replace_once(inv, 'import { lyd } from "@/lib/format";', 'import { lyd } from "@/lib/format";\nimport { formatProductQuantity } from "@/lib/product-quantity";', "inventory packaging import")
inv = replace_once(inv, '  brand: string | null;\n  currentQty: number;', '  brand: string | null;\n  caseQuantity: number;\n  currentQty: number;', "inventory case field")
helper = '''function packagedQuantity(quantity: unknown, row: { productName?: string | null; product_name?: string | null; category?: string | null; caseQuantity?: number | null; case_quantity?: number | null }) {
  return formatProductQuantity(quantity, {
    caseQuantity: row.caseQuantity ?? row.case_quantity ?? 1,
    productName: row.productName ?? row.product_name ?? null,
    category: row.category ?? null,
  }, { compact: true });
}

'''
if "function packagedQuantity(" not in inv:
    inv = replace_once(inv, 'function matchesText(values: Array<string | null | undefined>, query: string) {', helper + 'function matchesText(values: Array<string | null | undefined>, query: string) {', "inventory formatter helper")

if "packagingRowsData" not in inv:
    inv = replace_once(
        inv,
        '    { data: movementsData, error: movementsError },\n  ] = await Promise.all([',
        '    { data: movementsData, error: movementsError },\n    { data: packagingRowsData, error: packagingError },\n  ] = await Promise.all([',
        "inventory promise result",
    )
    movement_query = '''    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")
      .order("created_at", { ascending: false })
      .limit(250),
  ]);'''
    movement_query_with_packaging = '''    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")
      .order("created_at", { ascending: false })
      .limit(250),
    supabase
      .from("products")
      .select("id, name, category, case_quantity")
      .eq("active", true)
      .order("name")
      .limit(5000),
  ]);'''
    inv = replace_once(inv, movement_query, movement_query_with_packaging, "inventory packaging query")

if 'key: "product_packaging"' not in inv:
    issue_anchor = '''    movementsError
      ? logInventoryQueryError({
          key: "inventory_movements",
          label: "Could not load inventory movements",
          table: "inventory_movements",
          error: movementsError,
          profile,
          params: { order: "created_at desc", limit: 250 },
        })
      : null,
  ].filter((issue): issue is InventoryQueryIssue => Boolean(issue));'''
    issue_replacement = '''    movementsError
      ? logInventoryQueryError({
          key: "inventory_movements",
          label: "Could not load inventory movements",
          table: "inventory_movements",
          error: movementsError,
          profile,
          params: { order: "created_at desc", limit: 250 },
        })
      : null,
    packagingError
      ? logInventoryQueryError({
          key: "product_packaging",
          label: "Could not load product box quantities",
          table: "products",
          error: packagingError,
          profile,
          params: { select: "id,name,category,case_quantity", limit: 5000 },
        })
      : null,
  ].filter((issue): issue is InventoryQueryIssue => Boolean(issue));'''
    inv = replace_once(inv, issue_anchor, issue_replacement, "inventory packaging issue")

if "const packagingByProductId" not in inv:
    map_anchor = '  const priorityByProductId = new Map(restockResult.items.map((item) => [item.productId, item]));\n'
    map_block = '''  const priorityByProductId = new Map(restockResult.items.map((item) => [item.productId, item]));
  const packagingByProductId = new Map((packagingRowsData ?? []).map((row: any) => [String(row.id), {
    productName: row.name ?? null,
    category: row.category ?? null,
    caseQuantity: Math.max(1, Number(row.case_quantity ?? 1)),
  }]));
'''
    inv = replace_once(inv, map_anchor, map_block, "inventory packaging map")

inv = replace_once(inv, '        brand: item.brand,\n        currentQty,', '        brand: item.brand,\n        caseQuantity: packagingByProductId.get(item.productId)?.caseQuantity ?? 1,\n        currentQty,', "inventory item case")
inv = replace_once(inv, '        sku: product?.sku ?? null,\n        isFastSeller: Boolean(product?.isFastSeller),', '        sku: product?.sku ?? null,\n        category: product?.category ?? packagingByProductId.get(String(row.product_id ?? ""))?.category ?? null,\n        case_quantity: packagingByProductId.get(String(row.product_id ?? ""))?.caseQuantity ?? 1,\n        isFastSeller: Boolean(product?.isFastSeller),', "operator bag case")
inv = replace_once(inv, '    product_name: movement.product?.name ?? priorityByProductId.get(String(movement.product_id ?? ""))?.name ?? "Unknown product",\n    from_label:', '    product_name: movement.product?.name ?? priorityByProductId.get(String(movement.product_id ?? ""))?.name ?? "Unknown product",\n    category: priorityByProductId.get(String(movement.product_id ?? ""))?.category ?? packagingByProductId.get(String(movement.product_id ?? ""))?.category ?? null,\n    case_quantity: packagingByProductId.get(String(movement.product_id ?? ""))?.caseQuantity ?? 1,\n    from_label:', "movement case")
inv = replace_once(inv, '            <SecondaryButton href="/restock-priority">Restock Priority</SecondaryButton>', '            <SecondaryButton href="/product-planning">Product Planning</SecondaryButton>\n            <SecondaryButton href="/restock-priority">Restock Priority</SecondaryButton>', "inventory planning button")

simple_inventory_replacements = {
    'Buy {row.suggestedBuyQty}</span>': 'Buy {packagedQuantity(row.suggestedBuyQty, row)}</span>',
    '<MobileField label="Current">{row.currentQty}</MobileField>': '<MobileField label="Current">{packagedQuantity(row.currentQty, row)}</MobileField>',
    '<MobileField label="Reserved">{row.reservedQty}</MobileField>': '<MobileField label="Reserved">{packagedQuantity(row.reservedQty, row)}</MobileField>',
    '<MobileField label="Available"><span className="font-semibold text-slate-950">{row.availableQty}</span></MobileField>': '<MobileField label="Available"><span className="font-semibold text-slate-950">{packagedQuantity(row.availableQty, row)}</span></MobileField>',
    '<MobileField label="Suggested buy">{row.suggestedBuyQty}</MobileField>': '<MobileField label="Suggested buy">{packagedQuantity(row.suggestedBuyQty, row)}</MobileField>',
    '<MobileField label="Route need">{row.routeNeedQty}</MobileField>': '<MobileField label="Route need">{packagedQuantity(row.routeNeedQty, row)}</MobileField>',
    '<td>{row.currentQty}</td>': '<td>{packagedQuantity(row.currentQty, row)}</td>',
    '<td>{row.reservedQty}</td>': '<td>{packagedQuantity(row.reservedQty, row)}</td>',
    '<td className="font-semibold">{row.availableQty}</td>': '<td className="font-semibold">{packagedQuantity(row.availableQty, row)}</td>',
    '<td>{row.suggestedBuyQty}</td>': '<td>{packagedQuantity(row.suggestedBuyQty, row)}</td>',
    '<td>{row.routeNeedQty}</td>': '<td>{packagedQuantity(row.routeNeedQty, row)}</td>',
    '<MobileField label="Quantity"><span className="font-semibold text-slate-950">{Number(row.quantity_on_hand ?? 0)}</span></MobileField>': '<MobileField label="Quantity"><span className="font-semibold text-slate-950">{packagedQuantity(row.quantity_on_hand, row)}</span></MobileField>',
    '<td className="font-semibold">{Number(row.quantity_on_hand ?? 0)}</td>': '<td className="font-semibold">{packagedQuantity(row.quantity_on_hand, row)}</td>',
    '<MobileField label="Qty">{movement.quantity}</MobileField>': '<MobileField label="Qty">{packagedQuantity(movement.quantity, movement)}</MobileField>',
    '<td>{movement.quantity}</td>': '<td>{packagedQuantity(movement.quantity, movement)}</td>',
}
for before, after in simple_inventory_replacements.items():
    if after not in inv:
        if before not in inv:
            raise RuntimeError(f"inventory display replacement missing: {before}")
        inv = inv.replace(before, after)
write(inventory_path, inv)


# Pickup API.
api_path = "src/app/api/operator/routes/[id]/pick-list/route.ts"
api = read(api_path)
api_replacements = {
    '.select("id, name, sku, category")': '.select("id, name, sku, category, case_quantity")',
    '.select("id, name, sku")\n          .in("id", productIds);': '.select("id, name, sku, case_quantity")\n          .in("id", productIds);',
    '          category: product?.category ?? null,\n        }));': '          category: product?.category ?? null,\n          case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        }));',
    '.select("id, sku, barcode, name, category, brand, image_url, active")': '.select("id, sku, barcode, name, category, brand, image_url, case_quantity, active")',
    '.select("id, sku, barcode, name, active")': '.select("id, sku, barcode, name, case_quantity, active")',
    '          image_url: product?.image_url ?? null,\n        }));': '          image_url: product?.image_url ?? null,\n          case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        }));',
    '        category: product?.category ?? "Other",\n        planned_qty: plannedQty,': '        category: product?.category ?? "Other",\n        case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        planned_qty: plannedQty,',
    '        category: product?.category ?? "Other",\n        planned_qty: 0,': '        category: product?.category ?? "Other",\n        case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        planned_qty: 0,',
    '      sku: line.sku ?? null,\n      planned_qty: unitQuantity(line.planned_qty),': '      sku: line.sku ?? null,\n      case_quantity: Math.max(1, unitQuantity(line.case_quantity ?? 1)),\n      planned_qty: unitQuantity(line.planned_qty),',
    '      imageUrl: product.image_url ?? null,\n      availableStorageQty:': '      imageUrl: product.image_url ?? null,\n      caseQuantity: Math.max(1, unitQuantity(product.case_quantity ?? 1)),\n      availableStorageQty:',
}
for before, after in api_replacements.items():
    if after not in api:
        count = api.count(before)
        if count != 1:
            raise RuntimeError(f"pickup API replacement expected one match, found {count}: {before[:70]}")
        api = api.replace(before, after, 1)
write(api_path, api)


# Pickup UI.
pickup_path = "src/app/operator/routes/[id]/pick-list/page.tsx"
pickup = read(pickup_path)
pickup_replacements = {
    'import { ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";': 'import { ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";\nimport { formatProductQuantity } from "@/lib/product-quantity";',
    '  sku: string | null;\n  requestedQty: number;': '  sku: string | null;\n  caseQuantity: number;\n  requestedQty: number;',
    '  imageUrl?: string | null;\n  availableStorageQty: number;': '  imageUrl?: string | null;\n  caseQuantity: number;\n  availableStorageQty: number;',
    '  sku: string | null;\n  plannedQty: number;': '  sku: string | null;\n  caseQuantity: number;\n  plannedQty: number;',
    '  sku?: unknown;\n  planned_qty?: unknown;': '  sku?: unknown;\n  case_quantity?: unknown;\n  planned_qty?: unknown;',
    '  imageUrl?: unknown;\n  availableStorageQty?: unknown;': '  imageUrl?: unknown;\n  caseQuantity?: unknown;\n  availableStorageQty?: unknown;',
    '        sku: item.sku,\n        plannedQty: 0,': '        sku: item.sku,\n        caseQuantity: item.caseQuantity,\n        plannedQty: 0,',
    '        sku: product?.sku ?? null,\n        plannedQty: 0,': '        sku: product?.sku ?? null,\n        caseQuantity: product?.caseQuantity ?? 1,\n        plannedQty: 0,',
    '          sku: optionalText(item.sku),\n          requestedQty,': '          sku: optionalText(item.sku),\n          caseQuantity: Math.max(1, Number(item.case_quantity ?? 1)),\n          requestedQty,',
    '        imageUrl: optionalText(product.imageUrl),\n        availableStorageQty:': '        imageUrl: optionalText(product.imageUrl),\n        caseQuantity: Math.max(1, Number(product.caseQuantity ?? 1)),\n        availableStorageQty:',
}
for before, after in pickup_replacements.items():
    if after not in pickup:
        count = pickup.count(before)
        if count != 1:
            raise RuntimeError(f"pickup UI replacement expected one match, found {count}: {before[:70]}")
        pickup = pickup.replace(before, after, 1)

if "const selectedProduct = products.find((product) => product.id === productId);" not in pickup:
    pickup = pickup.replace(
        '}) {\n  return (\n    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">',
        '}) {\n  const selectedProduct = products.find((product) => product.id === productId);\n  return (\n    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">',
        1,
    )

pickup = re.sub(
    r'SKU: \{item\.sku \?\? "No SKU"\} - Recommended: \{item\.requestedQty\} - Route storage: \{item\.availableStorageQty\}',
    'SKU: {item.sku ?? "No SKU"} - Recommended: {formatProductQuantity(item.requestedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })} - Route storage: {formatProductQuantity(item.availableStorageQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}',
    pickup,
    count=1,
)
pickup = pickup.replace(
    'Available for this row: {maxQty}',
    'Available for this row: {formatProductQuantity(maxQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}',
    1,
)
pickup = pickup.replace(
    '{item.sku ?? "No SKU"} - Storage {item.availableStorageQty}',
    '{item.sku ?? "No SKU"} - Storage {formatProductQuantity(item.availableStorageQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}',
    1,
)
pickup = pickup.replace(
    '{item.confirmedQty} / {item.plannedQty}',
    '{formatProductQuantity(item.confirmedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })} / {formatProductQuantity(item.plannedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}',
    1,
)
pickup = pickup.replace(
    '<div className="mt-1 text-sm text-slate-500">{item.quantity} units</div>',
    '<div className="mt-1 text-sm text-slate-500">{formatProductQuantity(item.quantity, { caseQuantity: productById.get(item.productId)?.caseQuantity ?? 1, productName: item.productName ?? productById.get(item.productId)?.name, category: productById.get(item.productId)?.category }, { compact: true })}</div>',
    1,
)
pickup = pickup.replace(
    '            inputLabel="Added product quantity"\n          />\n        </label>',
    '            inputLabel="Added product quantity"\n          />\n          {selectedProduct ? <span className="mt-1 block text-xs text-slate-500">{formatProductQuantity(quantity, { caseQuantity: selectedProduct.caseQuantity, productName: selectedProduct.name, category: selectedProduct.category }, { compact: true })}</span> : null}\n        </label>',
    1,
)
pickup = pickup.replace(
    'Selected: {selected.name} - Storage {selected.availableStorageQty}',
    'Selected: {selected.name} - Storage {formatProductQuantity(selected.availableStorageQty, { caseQuantity: selected.caseQuantity, productName: selected.name, category: selected.category }, { compact: true })}',
    1,
)
pickup = pickup.replace(
    '{product.sku ?? "No SKU"} - Storage {product.availableStorageQty}{outOfStock ? " available" : ""}',
    '{product.sku ?? "No SKU"} - Storage {formatProductQuantity(product.availableStorageQty, { caseQuantity: product.caseQuantity, productName: product.name, category: product.category }, { compact: true })}{outOfStock ? " available" : ""}',
    1,
)

required_pickup_markers = [
    'import { formatProductQuantity } from "@/lib/product-quantity";',
    "caseQuantity: Math.max(1, Number(item.case_quantity ?? 1))",
    "caseQuantity: Math.max(1, Number(product.caseQuantity ?? 1))",
    "formatProductQuantity(item.requestedQty",
    "formatProductQuantity(item.confirmedQty",
    "formatProductQuantity(item.quantity",
    "formatProductQuantity(quantity",
    "formatProductQuantity(selected.availableStorageQty",
]
for marker in required_pickup_markers:
    if marker not in pickup:
        raise RuntimeError(f"pickup UI marker missing after integration: {marker}")
write(pickup_path, pickup)

print("Robust product planning and packaging integration applied.")
