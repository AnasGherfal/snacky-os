"use client";

import { PackagePlus } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { readRestockShoppingListStrict, writeRestockShoppingList, type RestockShoppingListItem } from "@/lib/restock-shopping-list";

export function CreatePurchaseListButton({ items, className = "", destination = "draft" }: {
  items: RestockShoppingListItem[]; className?: string; destination?: "draft" | "review";
}) {
  const router = useRouter(), {locale} = useLanguage();
  const ar = locale === "ar";
  const [error,setError] = useState("");
  const actionableItems = items.filter(item => Number.isSafeInteger(item.suggestedQty) && item.suggestedQty > 0);
  const boxed = actionableItems.length > 0 && actionableItems.every(item => item.purchaseUnit === "box");
  const totalBoxes = actionableItems.reduce((sum,item) => sum + Number(item.boxesQty ?? 0),0);
  const totalSuggestedQty = actionableItems.reduce((sum,item) => sum + item.suggestedQty,0);
  return <div>
    <button type="button" className={`btn-primary gap-2 disabled:cursor-not-allowed disabled:opacity-50 ${className}`.trim()}
      disabled={!actionableItems.length} onClick={() => {
        setError("");
        try {
          writeRestockShoppingList(actionableItems);
          const saved = readRestockShoppingListStrict();
          if (saved.length !== actionableItems.length) throw new Error("Purchase list could not be saved completely.");
          router.push(destination === "review" ? "/restock-priority/shopping-list" : "/purchases/new?source=restock");
        } catch { setError(ar ? "تعذر حفظ قائمة الشراء في المتصفح. لم يتم فتح المسودة؛ أعد المحاولة." : "Could not save the buying list in this browser. No draft was opened; retry."); }
      }}>
      <PackagePlus className="h-4 w-4" />
      {destination === "review" ? (ar ? "مراجعة الصناديق" : "Review buying list") : (ar ? "إنشاء مسودة شراء" : "Create Purchase List")}
      <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">{boxed ? `${totalBoxes} ${ar ? "صندوق" : "boxes"}` : `${totalSuggestedQty} ${ar ? "وحدة" : "units"}`}</span>
    </button>
    {error ? <p role="alert" className="mt-2 text-sm text-rose-800">{error}</p> : null}
  </div>;
}
