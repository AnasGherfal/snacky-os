"use client";

import Link from "next/link";
import { useEffect, useState, type ComponentProps } from "react";
import { PurchaseForm } from "@/components/PurchaseForm";
import { useLanguage } from "@/components/I18nProvider";
import { boxDraftLine, type BoxProduct } from "@/lib/purchase-boxes";
import { readRestockShoppingListStrict } from "@/lib/restock-shopping-list";

type Props = ComponentProps<typeof PurchaseForm>;
type Prepared = { lines: ReturnType<typeof boxDraftLine>[]; errors: string[] };

export function BoxAwarePurchaseForm(props: Props) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const restock = props.prefillSource === "restock" && !props.initialPurchase?.id;
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  useEffect(() => {
    if (!restock) return;
    const lines: Prepared["lines"] = [], errors: string[] = [];
    try {
      const saved = readRestockShoppingListStrict();
      const products = new Map(props.products.map(product => [product.id, product]));
      for (const item of saved) {
        const product = products.get(item.productId);
        try {
          if (!product) throw new Error(`${item.name}: product is no longer available.`);
          lines.push(boxDraftLine(item, { ...product, case_quantity: product.case_quantity } as BoxProduct));
        } catch (error) { errors.push(error instanceof Error ? error.message : "Could not verify product packaging."); }
      }
      if (!saved.length) errors.push(ar ? "قائمة الشراء فارغة. اختر المنتجات أولاً." : "Your buying list is empty. Select products first.");
    } catch (error) { errors.push(error instanceof Error ? error.message : "Could not read the buying list."); }
    setPrepared({ lines, errors });
  }, [restock, props.products, ar]);

  if (!restock) return <PurchaseForm {...props} />;
  if (!prepared) return <p role="status">{ar ? "جارٍ التحقق من كميات الصناديق…" : "Checking box quantities…"}</p>;
  if (prepared.errors.length) return <section className="surface-card space-y-3" role="alert">
    <h2 className="font-semibold">{ar ? "راجع حجم الصندوق قبل الشراء" : "Review box sizes before purchasing"}</h2>
    {prepared.errors.map((error, index) => <p key={index} className="text-sm text-rose-800">{error}</p>)}
    <Link href="/restock-priority/purchase-list" className="btn-primary">{ar ? "العودة إلى قائمة الشراء" : "Back to Purchase List"}</Link>
  </section>;
  return <div className="space-y-3">
    <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
      {ar ? "تم تحميل كميات الشراء بصناديق كاملة دون وحدات مفردة. راجع المورد والأسعار قبل الحفظ. استعادة مسودة قديمة تستعيد كمياتها السابقة." : "Loaded whole boxes with zero loose units. Review the supplier and prices before saving. Restoring an older draft restores that draft’s previous quantities."}
    </p>
    <PurchaseForm {...props} prefillSource={null} initialLines={prepared.lines} />
  </div>;
}
