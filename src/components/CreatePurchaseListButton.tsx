"use client";

import { PackagePlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { writeRestockShoppingList, type RestockShoppingListItem } from "@/lib/restock-shopping-list";

export function CreatePurchaseListButton({
  items,
  className = "",
}: {
  items: RestockShoppingListItem[];
  className?: string;
}) {
  const router = useRouter();
  const actionableItems = items.filter((item) => Math.max(0, Math.floor(Number(item.suggestedQty ?? 0))) > 0);
  const totalSuggestedQty = actionableItems.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.suggestedQty ?? 0))), 0);

  return (
    <button
      type="button"
      className={`btn-primary gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${className}`.trim()}
      disabled={!actionableItems.length}
      onClick={() => {
        writeRestockShoppingList(actionableItems);
        router.push("/purchases/new?source=restock");
      }}
      title={actionableItems.length ? `Create a purchase draft with ${actionableItems.length} product lines` : "No suggested purchase quantities in this view yet"}
    >
      <PackagePlus className="h-4 w-4" />
      {actionableItems.length ? `Create Purchase List (${actionableItems.length})` : "No Purchase List Yet"}
      {actionableItems.length ? <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">{totalSuggestedQty} units</span> : null}
    </button>
  );
}
