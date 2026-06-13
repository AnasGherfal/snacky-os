"use client";

import { ShoppingCart } from "lucide-react";
import { useEffect, useState } from "react";
import { readRestockShoppingList, toggleRestockShoppingListItem, type RestockShoppingListItem } from "@/lib/restock-shopping-list";

export function ShoppingListButton({ productId, name, suggestedQty, priorityScore, status }: RestockShoppingListItem) {
  const [selected, setSelected] = useState(false);
  const canAdd = Math.max(0, Math.floor(Number(suggestedQty ?? 0))) > 0;

  useEffect(() => {
    setSelected(readRestockShoppingList().some((item) => item.productId === productId));
  }, [productId]);

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`${selected ? "btn-primary" : "btn-secondary"} gap-2 disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={!canAdd}
      onClick={() => {
        if (!canAdd) return;
        const next = toggleRestockShoppingListItem({ productId, name, suggestedQty, priorityScore, status });
        setSelected(next.some((item) => item.productId === productId));
      }}
      title={canAdd ? undefined : "This product does not have a suggested purchase quantity yet"}
    >
      <ShoppingCart className="h-4 w-4" />
      {canAdd ? (selected ? "Added" : "Add to shopping list") : "No buy qty yet"}
    </button>
  );
}
