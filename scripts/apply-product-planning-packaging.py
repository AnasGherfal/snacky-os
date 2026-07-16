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


# ---------------------------------------------------------------------------
# Access control: Product Planning follows inventory/product access.
# ---------------------------------------------------------------------------
authz_path = "src/lib/authz.ts"
authz = read(authz_path)
authz = replace_once(
    authz,
    "product planning authz",
    '  if (matchesPrefix(pathname, ["/restock-priority"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view");',
    '  if (matchesPrefix(pathname, ["/product-planning"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view") || hasPermission(user, "purchases.view") || hasPermission(user, "finance.view");\n  if (matchesPrefix(pathname, ["/restock-priority"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view");',
)
write(authz_path, authz)


# ---------------------------------------------------------------------------
# Inventory: load case quantities and format all product-level quantities.
# ---------------------------------------------------------------------------
inventory_path = "src/app/inventory/page.tsx"
inventory = read(inventory_path)
inventory = replace_once(
    inventory,
    "inventory quantity import",
    'import { lyd } from "@/lib/format";',
    'import { lyd } from "@/lib/format";\nimport { formatProductQuantity } from "@/lib/product-quantity";',
)
inventory = replace_once(
    inventory,
    "inventory row packaging field",
    '  brand: string | null;\n  currentQty: number;',
    '  brand: string | null;\n  caseQuantity: number;\n  currentQty: number;',
)
inventory = replace_once(
    inventory,
    "inventory packaging formatter",
    'function matchesText(values: Array<string | null | undefined>, query: string) {',
    'function packagedQuantity(quantity: unknown, row: { productName?: string | null; product_name?: string | null; category?: string | null; caseQuantity?: number | null; case_quantity?: number | null }) {\n  return formatProductQuantity(quantity, {\n    caseQuantity: row.caseQuantity ?? row.case_quantity ?? 1,\n    productName: row.productName ?? row.product_name ?? null,\n    category: row.category ?? null,\n  }, { compact: true });\n}\n\nfunction matchesText(values: Array<string | null | undefined>, query: string) {',
)
inventory = replace_once(
    inventory,
    "inventory promise destructure packaging",
    '    { data: movementsData, error: movementsError },\n  ] = await Promise.all([',
    '    { data: movementsData, error: movementsError },\n    { data: packagingRowsData, error: packagingError },\n  ] = await Promise.all([',
)
inventory = replace_once(
    inventory,
    "inventory packaging query",
    '    supabase\n      .from("inventory_movements")\n      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")\n      .order("created_at", { ascending: false })\n      .limit(250),\n  ]);',
    '    supabase\n      .from("inventory_movements")\n      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, created_at, product:products(name)")\n      .order("created_at", { ascending: false })\n      .limit(250),\n    supabase\n      .from("products")\n      .select("id, name, category, case_quantity")\n      .eq("active", true)\n      .order("name")\n      .limit(5000),\n  ]);',
)
inventory = replace_once(
    inventory,
    "inventory packaging query issue",
    '    movementsError\n      ? logInventoryQueryError({\n          key: "inventory_movements",\n          label: "Could not load inventory movements",\n          table: "inventory_movements",\n          error: movementsError,\n          profile,\n          params: { order: "created_at desc", limit: 250 },\n        })\n      : null,\n  ].filter((issue): issue is InventoryQueryIssue => Boolean(issue));',
    '    movementsError\n      ? logInventoryQueryError({\n          key: "inventory_movements",\n          label: "Could not load inventory movements",\n          table: "inventory_movements",\n          error: movementsError,\n          profile,\n          params: { order: "created_at desc", limit: 250 },\n        })\n      : null,\n    packagingError\n      ? logInventoryQueryError({\n          key: "product_packaging",\n          label: "Could not load product box quantities",\n          table: "products",\n          error: packagingError,\n          profile,\n          params: { select: "id,name,category,case_quantity", limit: 5000 },\n        })\n      : null,\n  ].filter((issue): issue is InventoryQueryIssue => Boolean(issue));',
)
inventory = replace_once(
    inventory,
    "inventory packaging map",
    '  const priorityByProductId = new Map(restockResult.items.map((item) => [item.productId, item]));\n  const allInventoryRows = restockResult.items',
    '  const priorityByProductId = new Map(restockResult.items.map((item) => [item.productId, item]));\n  const packagingByProductId = new Map((packagingRowsData ?? []).map((row: any) => [String(row.id), {\n    productName: row.name ?? null,\n    category: row.category ?? null,\n    caseQuantity: Math.max(1, Number(row.case_quantity ?? 1)),\n  }]));\n  const allInventoryRows = restockResult.items',
)
inventory = replace_once(
    inventory,
    "inventory row case quantity",
    '        brand: item.brand,\n        currentQty,',
    '        brand: item.brand,\n        caseQuantity: packagingByProductId.get(item.productId)?.caseQuantity ?? 1,\n        currentQty,',
)
inventory = replace_once(
    inventory,
    "operator bag packaging",
    '        sku: product?.sku ?? null,\n        isFastSeller: Boolean(product?.isFastSeller),',
    '        sku: product?.sku ?? null,\n        category: product?.category ?? packagingByProductId.get(String(row.product_id ?? ""))?.category ?? null,\n        case_quantity: packagingByProductId.get(String(row.product_id ?? ""))?.caseQuantity ?? 1,\n        isFastSeller: Boolean(product?.isFastSeller),',
)
inventory = replace_once(
    inventory,
    "movement packaging",
    '    product_name: movement.product?.name ?? priorityByProductId.get(String(movement.product_id ?? ""))?.name ?? "Unknown product",\n    from_label:',
    '    product_name: movement.product?.name ?? priorityByProductId.get(String(movement.product_id ?? ""))?.name ?? "Unknown product",\n    category: priorityByProductId.get(String(movement.product_id ?? ""))?.category ?? packagingByProductId.get(String(movement.product_id ?? ""))?.category ?? null,\n    case_quantity: packagingByProductId.get(String(movement.product_id ?? ""))?.caseQuantity ?? 1,\n    from_label:',
)
inventory = replace_once(
    inventory,
    "inventory header planning link",
    '            <SecondaryButton href="/restock-priority">Restock Priority</SecondaryButton>',
    '            <SecondaryButton href="/product-planning">Product Planning</SecondaryButton>\n            <SecondaryButton href="/restock-priority">Restock Priority</SecondaryButton>',
)
# Product inventory cards and table.
inventory = inventory.replace('{row.suggestedBuyQty > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">Buy {row.suggestedBuyQty}</span> : null}', '{row.suggestedBuyQty > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">Buy {packagedQuantity(row.suggestedBuyQty, row)}</span> : null}')
inventory = inventory.replace('<MobileField label="Current">{row.currentQty}</MobileField>', '<MobileField label="Current">{packagedQuantity(row.currentQty, row)}</MobileField>')
inventory = inventory.replace('<MobileField label="Reserved">{row.reservedQty}</MobileField>', '<MobileField label="Reserved">{packagedQuantity(row.reservedQty, row)}</MobileField>')
inventory = inventory.replace('<MobileField label="Available"><span className="font-semibold text-slate-950">{row.availableQty}</span></MobileField>', '<MobileField label="Available"><span className="font-semibold text-slate-950">{packagedQuantity(row.availableQty, row)}</span></MobileField>')
inventory = inventory.replace('<MobileField label="Suggested buy">{row.suggestedBuyQty}</MobileField>', '<MobileField label="Suggested buy">{packagedQuantity(row.suggestedBuyQty, row)}</MobileField>')
inventory = inventory.replace('<MobileField label="Route need">{row.routeNeedQty}</MobileField>', '<MobileField label="Route need">{packagedQuantity(row.routeNeedQty, row)}</MobileField>')
inventory = inventory.replace('                <td>{row.currentQty}</td>\n                <td>{row.reservedQty}</td>\n                <td className="font-semibold">{row.availableQty}</td>\n                <td>{row.suggestedBuyQty}</td>\n                <td>{row.routeNeedQty}</td>', '                <td>{packagedQuantity(row.currentQty, row)}</td>\n                <td>{packagedQuantity(row.reservedQty, row)}</td>\n                <td className="font-semibold">{packagedQuantity(row.availableQty, row)}</td>\n                <td>{packagedQuantity(row.suggestedBuyQty, row)}</td>\n                <td>{packagedQuantity(row.routeNeedQty, row)}</td>')
inventory = inventory.replace('<MobileField label="Quantity"><span className="font-semibold text-slate-950">{Number(row.quantity_on_hand ?? 0)}</span></MobileField>', '<MobileField label="Quantity"><span className="font-semibold text-slate-950">{packagedQuantity(row.quantity_on_hand, row)}</span></MobileField>')
inventory = inventory.replace('<td className="font-semibold">{Number(row.quantity_on_hand ?? 0)}</td>', '<td className="font-semibold">{packagedQuantity(row.quantity_on_hand, row)}</td>')
inventory = inventory.replace('<MobileField label="Qty">{movement.quantity}</MobileField>', '<MobileField label="Qty">{packagedQuantity(movement.quantity, movement)}</MobileField>')
inventory = inventory.replace('                  <td>{movement.quantity}</td>', '                  <td>{packagedQuantity(movement.quantity, movement)}</td>')
write(inventory_path, inventory)


# ---------------------------------------------------------------------------
# Pickup API: expose case quantity for every product and row.
# ---------------------------------------------------------------------------
api_path = "src/app/api/operator/routes/[id]/pick-list/route.ts"
api = read(api_path)
api = replace_once(api, "route item product case select", '.select("id, name, sku, category")', '.select("id, name, sku, category, case_quantity")')
api = replace_once(api, "route item product case fallback", '.select("id, name, sku")\n          .in("id", productIds);', '.select("id, name, sku, case_quantity")\n          .in("id", productIds);')
api = replace_once(
    api,
    "route item product case normalize",
    '          category: product?.category ?? null,\n        }));',
    '          category: product?.category ?? null,\n          case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        }));',
)
api = replace_once(api, "product options case select", '.select("id, sku, barcode, name, category, brand, image_url, active")', '.select("id, sku, barcode, name, category, brand, image_url, case_quantity, active")')
api = replace_once(api, "product options case fallback", '.select("id, sku, barcode, name, active")', '.select("id, sku, barcode, name, case_quantity, active")')
api = replace_once(
    api,
    "product options case normalize",
    '          image_url: product?.image_url ?? null,\n        }));',
    '          image_url: product?.image_url ?? null,\n          case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        }));',
)
api = replace_once(
    api,
    "pickup stop item case",
    '        category: product?.category ?? "Other",\n        planned_qty: plannedQty,',
    '        category: product?.category ?? "Other",\n        case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        planned_qty: plannedQty,',
)
api = replace_once(
    api,
    "planned product case",
    '        category: product?.category ?? "Other",\n        planned_qty: 0,',
    '        category: product?.category ?? "Other",\n        case_quantity: Math.max(1, unitQuantity(product?.case_quantity ?? 1)),\n        planned_qty: 0,',
)
api = replace_once(
    api,
    "route totals response case",
    '      sku: line.sku ?? null,\n      planned_qty: unitQuantity(line.planned_qty),',
    '      sku: line.sku ?? null,\n      case_quantity: Math.max(1, unitQuantity(line.case_quantity ?? 1)),\n      planned_qty: unitQuantity(line.planned_qty),',
)
api = replace_once(
    api,
    "product option response case",
    '      imageUrl: product.image_url ?? null,\n      availableStorageQty:',
    '      imageUrl: product.image_url ?? null,\n      caseQuantity: Math.max(1, unitQuantity(product.case_quantity ?? 1)),\n      availableStorageQty:',
)
write(api_path, api)


# ---------------------------------------------------------------------------
# Pickup UI: show boxes + loose units for every product quantity.
# ---------------------------------------------------------------------------
pickup_path = "src/app/operator/routes/[id]/pick-list/page.tsx"
pickup = read(pickup_path)
pickup = replace_once(
    pickup,
    "pickup quantity import",
    'import { ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";',
    'import { ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";\nimport { formatProductQuantity } from "@/lib/product-quantity";',
)
pickup = replace_once(pickup, "stop item case field", '  sku: string | null;\n  requestedQty: number;', '  sku: string | null;\n  caseQuantity: number;\n  requestedQty: number;')
pickup = replace_once(pickup, "product option case field", '  imageUrl?: string | null;\n  availableStorageQty: number;', '  imageUrl?: string | null;\n  caseQuantity: number;\n  availableStorageQty: number;')
pickup = replace_once(pickup, "route total case field", '  sku: string | null;\n  plannedQty: number;', '  sku: string | null;\n  caseQuantity: number;\n  plannedQty: number;')
pickup = replace_once(pickup, "api stop case field", '  sku?: unknown;\n  planned_qty?: unknown;', '  sku?: unknown;\n  case_quantity?: unknown;\n  planned_qty?: unknown;')
pickup = replace_once(pickup, "api option case field", '  imageUrl?: unknown;\n  availableStorageQty?: unknown;', '  imageUrl?: unknown;\n  caseQuantity?: unknown;\n  availableStorageQty?: unknown;')
pickup = replace_once(
    pickup,
    "route total case initial",
    '        sku: item.sku,\n        plannedQty: 0,',
    '        sku: item.sku,\n        caseQuantity: item.caseQuantity,\n        plannedQty: 0,',
)
pickup = replace_once(
    pickup,
    "route total extra case initial",
    '        sku: product?.sku ?? null,\n        plannedQty: 0,',
    '        sku: product?.sku ?? null,\n        caseQuantity: product?.caseQuantity ?? 1,\n        plannedQty: 0,',
)
pickup = replace_once(
    pickup,
    "stop item parse case",
    '          sku: optionalText(item.sku),\n          requestedQty,',
    '          sku: optionalText(item.sku),\n          caseQuantity: Math.max(1, Number(item.case_quantity ?? 1)),\n          requestedQty,',
)
pickup = replace_once(
    pickup,
    "product option parse case",
    '        imageUrl: optionalText(product.imageUrl),\n        availableStorageQty:',
    '        imageUrl: optionalText(product.imageUrl),\n        caseQuantity: Math.max(1, Number(product.caseQuantity ?? 1)),\n        availableStorageQty:',
)
# Replace product quantity text in detailed rows.
pickup = replace_once(
    pickup,
    "pickup detail quantities",
    '                                                    SKU: {item.sku ?? "No SKU"} - Recommended: {item.requestedQty} - Route storage: {item.availableStorageQty}',
    '                                                    SKU: {item.sku ?? "No SKU"} - Recommended: {formatProductQuantity(item.requestedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })} - Route storage: {formatProductQuantity(item.availableStorageQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}',
)
pickup = replace_once(
    pickup,
    "pickup available row quantity",
    '                                                 <span className="mt-1 block text-xs text-slate-500">Available for this row: {maxQty}</span>',
    '                                                 <span className="mt-1 block text-xs text-slate-500">Available for this row: {formatProductQuantity(maxQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}</span>',
)
pickup = replace_once(
    pickup,
    "route total storage quantity",
    '                  <p className="text-xs text-slate-500">{item.sku ?? "No SKU"} - Storage {item.availableStorageQty}</p>',
    '                  <p className="text-xs text-slate-500">{item.sku ?? "No SKU"} - Storage {formatProductQuantity(item.availableStorageQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}</p>',
)
pickup = replace_once(
    pickup,
    "route total picked planned quantity",
    '                   {item.confirmedQty} / {item.plannedQty}',
    '                   {formatProductQuantity(item.confirmedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })} / {formatProductQuantity(item.plannedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}',
)
pickup = replace_once(
    pickup,
    "load checklist packaged quantity",
    '                       <div className="mt-1 text-sm text-slate-500">{item.quantity} units</div>',
    '                       <div className="mt-1 text-sm text-slate-500">{formatProductQuantity(item.quantity, { caseQuantity: productById.get(item.productId)?.caseQuantity ?? 1, productName: item.productName ?? productById.get(item.productId)?.name, category: productById.get(item.productId)?.category }, { compact: true })}</div>',
)
# Adjustment row shows selected packaging below the stepper.
pickup = replace_once(
    pickup,
    "adjustment row selected product",
    '}) {\n  return (\n    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">',
    '}) {\n  const selectedProduct = products.find((product) => product.id === productId);\n  return (\n    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">',
)
pickup = replace_once(
    pickup,
    "adjustment quantity package",
    '           <QuantityStepper\n             value={quantity}\n             max={maxQuantity}\n             onChange={(nextQuantity) => onChange({ quantity: nextQuantity })}\n             disabled={disabled || !productId}\n             inputLabel="Added product quantity"\n           />\n         </label>',
    '           <QuantityStepper\n             value={quantity}\n             max={maxQuantity}\n             onChange={(nextQuantity) => onChange({ quantity: nextQuantity })}\n             disabled={disabled || !productId}\n             inputLabel="Added product quantity"\n           />\n           {selectedProduct ? <span className="mt-1 block text-xs text-slate-500">{formatProductQuantity(quantity, { caseQuantity: selectedProduct.caseQuantity, productName: selectedProduct.name, category: selectedProduct.category }, { compact: true })}</span> : null}\n         </label>',
)
pickup = replace_once(
    pickup,
    "product combobox selected storage",
    '               Selected: {selected.name} - Storage {selected.availableStorageQty}',
    '               Selected: {selected.name} - Storage {formatProductQuantity(selected.availableStorageQty, { caseQuantity: selected.caseQuantity, productName: selected.name, category: selected.category }, { compact: true })}',
)
pickup = replace_once(
    pickup,
    "product combobox storage options",
    '{product.sku ?? "No SKU"} - Storage {product.availableStorageQty}{outOfStock ? " available" : ""}',
    '{product.sku ?? "No SKU"} - Storage {formatProductQuantity(product.availableStorageQty, { caseQuantity: product.caseQuantity, productName: product.name, category: product.category }, { compact: true })}{outOfStock ? " available" : ""}',
)
write(pickup_path, pickup)

print("Product planning access and packaging display integration applied.")
