"use client";

import { ShoppingCart } from "lucide-react";
import { useEffect, useState } from "react";

type ShoppingListItem = {
  productId: string;
  name: string;
  suggestedQty: number;
};

const storageKey = "snacky-restock-shopping-list";

function readList(): ShoppingListItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(items: ShoppingListItem[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(items));
}

export function ShoppingListButton({ productId, name, suggestedQty }: ShoppingListItem) {
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    setSelected(readList().some((item) => item.productId === productId));
  }, [productId]);

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`${selected ? "btn-primary" : "btn-secondary"} gap-2`}
      onClick={() => {
        const list = readList();
        const next = selected
          ? list.filter((item) => item.productId !== productId)
          : [...list.filter((item) => item.productId !== productId), { productId, name, suggestedQty }];
        writeList(next);
        setSelected(!selected);
      }}
    >
      <ShoppingCart className="h-4 w-4" />
      {selected ? "Added" : "Add to shopping list"}
    </button>
  );
}
