"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { lyd } from "@/lib/format";
import {
  clearRestockShoppingList,
  readRestockShoppingList,
  removeRestockShoppingListItem,
  updateRestockShoppingListQuantity,
  type RestockShoppingListItem,
} from "@/lib/restock-shopping-list";

function estimatedLineCost(item: RestockShoppingListItem) {
  return item.lastPurchaseCost ? item.lastPurchaseCost * item.suggestedQty : null;
}

export function RestockBuyingList() {
  const [items, setItems] = useState<RestockShoppingListItem[]>([]);

  useEffect(() => {
    setItems(readRestockShoppingList());
  }, []);

  const estimatedTotal = useMemo(
    () => items.reduce((sum, item) => sum + (estimatedLineCost(item) ?? 0), 0),
    [items],
  );
  const missingCostCount = items.filter((item) => !item.lastPurchaseCost).length;
  const totalUnits = items.reduce((sum, item) => sum + item.suggestedQty, 0);

  if (!items.length) {
    return (
      <div className="surface-card p-6">
        <h2 className="text-lg font-semibold text-slate-950">Your buying list is empty</h2>
        <p className="mt-2 text-sm text-slate-600">Add products from Restock Priority. Their recommended quantities and latest purchase costs will be carried here.</p>
        <Link href="/restock-priority" className="btn-primary mt-4 inline-flex">Open Restock Priority</Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="surface-card"><div className="text-xs font-semibold uppercase text-slate-500">Products</div><div className="mt-2 text-3xl font-semibold">{items.length}</div></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase text-slate-500">Units to buy</div><div className="mt-2 text-3xl font-semibold">{totalUnits}</div></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase text-slate-500">Estimated total</div><div className="mt-2 text-3xl font-semibold">{lyd(estimatedTotal)}</div><div className="mt-1 text-xs text-slate-500">Based on latest purchase cost{missingCostCount ? ` · ${missingCostCount} item(s) missing cost` : ""}</div></div>
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white max-h-[65vh]">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)]">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Quantity</th>
              <th className="px-4 py-3">Last cost</th>
              <th className="px-4 py-3">Estimated line cost</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => (
              <tr key={item.productId}>
                <td className="px-4 py-3 font-semibold text-slate-900">{item.name}</td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    min="1"
                    value={item.suggestedQty}
                    className="field-input w-28"
                    onChange={(event) => setItems(updateRestockShoppingListQuantity(item.productId, Number(event.target.value)))}
                  />
                </td>
                <td className="px-4 py-3">{item.lastPurchaseCost ? lyd(item.lastPurchaseCost) : "No recorded cost"}</td>
                <td className="px-4 py-3 font-semibold">{estimatedLineCost(item) === null ? "-" : lyd(estimatedLineCost(item) as number)}</td>
                <td className="px-4 py-3"><button type="button" className="btn-secondary" onClick={() => setItems(removeRestockShoppingListItem(item.productId))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/purchases/new?source=restock" className="btn-primary">Create purchase draft</Link>
        <Link href="/restock-priority" className="btn-secondary">Add more products</Link>
        <button type="button" className="btn-secondary" onClick={() => { clearRestockShoppingList(); setItems([]); }}>Clear list</button>
      </div>
    </div>
  );
}
