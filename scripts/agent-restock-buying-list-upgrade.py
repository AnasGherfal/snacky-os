from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Persist latest purchase cost with every selected buying-list item.
path = "src/lib/restock-shopping-list.ts"
text = read(path)
text = replace_once(
    text,
    "  status?: string | null;\n};",
    "  status?: string | null;\n  lastPurchaseCost?: number | null;\n};",
    "shopping list cost type",
)
text = replace_once(
    text,
    "  const status = item?.status ? String(item.status) : null;",
    "  const status = item?.status ? String(item.status) : null;\n  const parsedCost = Number(item?.lastPurchaseCost ?? 0);\n  const lastPurchaseCost = Number.isFinite(parsedCost) && parsedCost > 0 ? parsedCost : null;",
    "shopping list cost normalize",
)
text = replace_once(
    text,
    "    status,\n  };",
    "    status,\n    lastPurchaseCost,\n  };",
    "shopping list cost output",
)
addition = '''\n\nexport function updateRestockShoppingListQuantity(productId: string, suggestedQty: number) {\n  const quantity = Math.max(1, Math.floor(Number(suggestedQty ?? 1)));\n  const next = readRestockShoppingList().map((item) => item.productId === productId ? { ...item, suggestedQty: quantity } : item);\n  writeRestockShoppingList(next);\n  return next;\n}\n\nexport function removeRestockShoppingListItem(productId: string) {\n  const next = readRestockShoppingList().filter((item) => item.productId !== productId);\n  writeRestockShoppingList(next);\n  return next;\n}\n'''
if "updateRestockShoppingListQuantity" not in text:
    text += addition
write(path, text)


# Carry cost into row-level selection.
path = "src/components/ShoppingListButton.tsx"
text = read(path)
text = replace_once(
    text,
    "export function ShoppingListButton({ productId, name, suggestedQty, priorityScore, status }: RestockShoppingListItem) {",
    "export function ShoppingListButton({ productId, name, suggestedQty, priorityScore, status, lastPurchaseCost }: RestockShoppingListItem) {",
    "shopping button cost prop",
)
text = replace_once(
    text,
    "toggleRestockShoppingListItem({ productId, name, suggestedQty, priorityScore, status })",
    "toggleRestockShoppingListItem({ productId, name, suggestedQty, priorityScore, status, lastPurchaseCost })",
    "shopping button cost payload",
)
write(path, text)


# Upgrade the main restock planning page.
path = "src/app/restock-priority/page.tsx"
text = read(path)
text = replace_once(
    text,
    "    status: item.status,\n  };",
    "    status: item.status,\n    lastPurchaseCost: item.lastPurchaseCost,\n  };",
    "restock list item cost",
)
text = replace_once(
    text,
    "        status={item.status}\n      />",
    "        status={item.status}\n        lastPurchaseCost={item.lastPurchaseCost}\n      />",
    "product actions cost",
)

old_function_pattern = re.compile(r'function ProductTable\(\{ items, currentPath, canEditProducts \}: \{ items: RestockPriorityItem\[\]; currentPath: string; canEditProducts: boolean \}\) \{.*?\n\}\n\nfunction ProductSection', re.S)
new_function = '''function ProductTable({ items, currentPath, canEditProducts }: { items: RestockPriorityItem[]; currentPath: string; canEditProducts: boolean }) {\n  return (\n    <DataTable\n      className="hidden max-h-[70vh] overflow-auto md:block [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-20 [&_thead]:bg-white [&_th]:whitespace-nowrap [&_th]:shadow-[0_1px_0_0_rgb(226_232_240)]"\n      headers={["Product", "Status", "Sold this month", "Storage left", "Recommended buy", "Last cost", "Estimated cost", "Machines", "Add to list", "Settings"]}\n    >\n      {items.map((item) => {\n        const estimatedCost = item.lastPurchaseCost === null ? null : item.lastPurchaseCost * item.suggestedBuyQty;\n        return (\n          <tr key={item.productId}>\n            <td>\n              <div className="font-semibold text-slate-900">{item.name}</div>\n              <div className="text-xs text-slate-500">{item.sku ?? "-"} - {item.category ?? "-"}</div>\n              <div className="mt-2"><WhyRecommended item={item} /></div>\n            </td>\n            <td><StatusBadge status={statusLabel(item.status)} /></td>\n            <td className="font-semibold text-slate-950">{formatQty(item.unitsSold)}</td>\n            <td>{formatQty(item.storageQty)}</td>\n            <td className="font-semibold text-slate-950">{formatQty(item.suggestedBuyQty)}</td>\n            <td>\n              <div>{item.lastPurchaseCost === null ? "-" : lyd(item.lastPurchaseCost)}</div>\n              <div className="text-xs text-slate-500">{item.lastPurchasedDate ?? "-"}</div>\n            </td>\n            <td className="font-semibold">{estimatedCost === null ? "-" : lyd(estimatedCost)}</td>\n            <td><MachineNeeds item={item} /></td>\n            <td>\n              <ShoppingListButton\n                productId={item.productId}\n                name={item.name}\n                suggestedQty={item.suggestedBuyQty}\n                priorityScore={item.priorityScore}\n                status={item.status}\n                lastPurchaseCost={item.lastPurchaseCost}\n              />\n            </td>\n            <td>\n              <div className="space-y-2">\n                <Link href={`/products/${item.productId}/history`} className="link-secondary">Product history</Link>\n                {canEditProducts ? (\n                  <details className="rounded-lg border border-slate-200 p-3">\n                    <summary className="cursor-pointer text-xs font-semibold text-slate-700">Adjust planning</summary>\n                    <ThresholdForm item={item} currentPath={currentPath} />\n                  </details>\n                ) : null}\n              </div>\n            </td>\n          </tr>\n        );\n      })}\n    </DataTable>\n  );\n}\n\nfunction ProductSection'''
text, count = old_function_pattern.subn(new_function, text, count=1)
if count != 1:
    raise RuntimeError(f"product table replacement: expected one match, found {count}")

text = replace_once(
    text,
    "  const filteredItems = filterRestockItems(result.items, filter, q);",
    "  const filteredItems = [...filterRestockItems(result.items, filter, q)].sort((left, right) =>\n    right.unitsSold - left.unitsSold\n    || right.salesVelocity - left.salesVelocity\n    || right.suggestedBuyQty - left.suggestedBuyQty\n    || left.name.localeCompare(right.name)\n  );",
    "sort products by sales",
)
text = replace_once(
    text,
    "            <CreatePurchaseListButton items={purchaseListItems} />\n            <SecondaryButton href=\"/inventory/movements/new\">Storage adjustment</SecondaryButton>",
    "            <SecondaryButton href=\"/restock-priority/shopping-list\">Open Buying List</SecondaryButton>\n            <CreatePurchaseListButton items={purchaseListItems} />\n            <SecondaryButton href=\"/inventory/movements/new\">Storage adjustment</SecondaryButton>",
    "buying list page link",
)
text = replace_once(
    text,
    "        subtitle=\"What should I buy today? Snacky ranks products by storage pressure, route demand, machine gaps, and recent sales so you can buy the right items first.\"",
    "        subtitle=\"Plan purchases from one sales-ranked table: this month’s sales, storage left, recommended quantity, latest cost, and your saved buying list.\"",
    "restock subtitle",
)
write(path, text)


# Add targeted source regression assertions.
path = "scripts/test-critical-workflows.mjs"
text = read(path)
addition = '''\n\ntest("restock planning is sales-ranked with a persistent costed buying list", () => {\n  const page = readFileSync("src/app/restock-priority/page.tsx", "utf8");\n  const shoppingList = readFileSync("src/lib/restock-shopping-list.ts", "utf8");\n  const buyingList = readFileSync("src/components/RestockBuyingList.tsx", "utf8");\n\n  assert.match(page, /right\.unitsSold - left\.unitsSold/);\n  assert.match(page, /Sold this month/);\n  assert.match(page, /Storage left/);\n  assert.match(page, /Recommended buy/);\n  assert.match(page, /Estimated cost/);\n  assert.match(page, /\[&_thead\]:sticky/);\n  assert.match(page, /restock-priority\/shopping-list/);\n  assert.match(shoppingList, /lastPurchaseCost/);\n  assert.match(shoppingList, /updateRestockShoppingListQuantity/);\n  assert.match(buyingList, /Estimated total/);\n  assert.match(buyingList, /Create purchase draft/);\n});\n'''
if 'test("restock planning is sales-ranked with a persistent costed buying list"' not in text:
    text += addition
write(path, text)
