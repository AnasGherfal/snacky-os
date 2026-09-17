"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { CreatePurchaseListButton } from "@/components/CreatePurchaseListButton";
import { boxShoppingItem, type BoxProduct } from "@/lib/purchase-boxes";
import { clearRestockShoppingList, readRestockShoppingListStrict, writeRestockShoppingList, type RestockShoppingListItem } from "@/lib/restock-shopping-list";

export function RestockBuyingList({products = []}: {products?:BoxProduct[]}) {
  const {locale} = useLanguage(), ar = locale === "ar";
  const tr = (en:string,arabic:string) => ar ? arabic : en;
  const [items,setItems] = useState<RestockShoppingListItem[]>([]), [ready,setReady] = useState(false), [error,setError] = useState("");
  useEffect(() => {try {setItems(readRestockShoppingListStrict());} catch {setError(tr("Could not read your saved buying list. Recreate it from Purchase List.","تعذر قراءة قائمة الشراء المحفوظة. أعد إنشاءها من قائمة الشراء."));} setReady(true);},[]);
  const rows = useMemo(() => {
    const byId = new Map(products.map(product => [product.id,product]));
    return items.map(item => {
      const product = byId.get(item.productId);
      try {
        if (!product) throw new Error(tr("Product is no longer active.","المنتج لم يعد نشطاً."));
        return {item:boxShoppingItem(item,product),error:""};
      } catch (failure) {return {item,error:failure instanceof Error ? failure.message : "Check packaging."};}
    });
  },[items,products,ar]);
  const safeItems = rows.filter(row => !row.error).map(row => row.item);
  const blocked = rows.some(row => row.error);
  const boxes = safeItems.reduce((sum,item) => sum + Number(item.boxesQty),0);
  const units = safeItems.reduce((sum,item) => sum + item.suggestedQty,0);
  const costs = safeItems.filter(item => item.lastPurchaseCost != null);
  const total = costs.reduce((sum,item) => sum + item.lastPurchaseCost! * item.suggestedQty,0);
  function save(next:RestockShoppingListItem[]) {
    try {writeRestockShoppingList(next);setItems(next);setError("");}
    catch {setError(tr("Could not save these box quantities. Retry before leaving this page.","تعذر حفظ كميات الصناديق. أعد المحاولة قبل مغادرة الصفحة."));}
  }
  if (!ready) return <p role="status">{tr("Loading saved boxes…","جارٍ تحميل الصناديق المحفوظة…")}</p>;
  return <div className="space-y-4" dir={ar ? "rtl" : "ltr"}>
    <p className="text-sm text-slate-600">{tr("This is your saved buying list. Change the number of whole boxes here. Stock is counted in units automatically; costs include every unit in the boxes.","هذه قائمة الشراء المحفوظة. غيّر عدد الصناديق الكاملة هنا. يُحسب المخزون تلقائياً بالوحدات وتشمل التكلفة جميع وحدات الصناديق.")}</p>
    {error ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p> : null}
    {!items.length ? <section className="surface-card"><h2 className="font-semibold">{tr("Your buying list is empty","قائمة الشراء فارغة")}</h2><Link className="btn-primary mt-3" href="/restock-priority/purchase-list">{tr("Open automatic Purchase List","فتح قائمة الشراء التلقائية")}</Link></section> : <>
      <div className="grid gap-3 sm:grid-cols-3"><div className="surface-card">{tr("Boxes to buy","صناديق للشراء")}<strong className="mt-2 block text-3xl">{boxes}</strong></div><div className="surface-card">{tr("Total units inside boxes","إجمالي الوحدات داخل الصناديق")}<strong className="mt-2 block text-3xl">{units}</strong></div><div className="surface-card">{tr("Estimated total","التكلفة التقديرية")}<strong className="mt-2 block text-xl">{costs.length ? `${total.toFixed(2)} LYD` : "—"}</strong>{costs.length < safeItems.length || blocked ? <p className="text-xs text-amber-800">{tr("Incomplete until missing sizes/costs are resolved.","غير مكتمل حتى تحديد الأحجام والتكاليف المفقودة.")}</p> : null}</div></div>
      {blocked ? <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm">{tr("Resolve the highlighted box sizes or remove those products before creating a draft. No item will be silently skipped.","حدد أحجام الصناديق الموضحة أو احذف هذه المنتجات قبل إنشاء المسودة. لن يتم تجاهل أي منتج تلقائياً.")}</p> : null}
      <div className="space-y-3">{rows.map(({item,error:rowError}) => <section key={item.productId} className="surface-card grid items-center gap-3 sm:grid-cols-[1fr_150px_1fr_auto]">
        <div><strong>{item.name}</strong><div className="text-xs text-slate-500">{item.unitsPerBox ? `${item.unitsPerBox} ${tr("units/box","وحدة/صندوق")}` : "—"}</div></div>
        {rowError ? <div className="sm:col-span-2"><p className="text-sm text-amber-900">{rowError}</p><Link href={`/products/${item.productId}/edit`} className="text-sm underline">{tr("Set box size","حدد حجم الصندوق")}</Link></div> : <>
          <label className="text-sm">{tr("Boxes","الصناديق")}<input aria-label={`${item.name} ${tr("boxes","صناديق")}`} type="number" min="1" step="1" inputMode="numeric" value={item.boxesQty} className="field-input mt-1" onChange={event => {
            const count = Number(event.target.value);
            if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(count * item.unitsPerBox!)) return;
            save(rows.map(row => row.item.productId === item.productId ? {...item,boxesQty:count,suggestedQty:count*item.unitsPerBox!} : row.item));
          }}/></label>
          <div className="text-sm"><div>{item.suggestedQty} {tr("total units","وحدة إجمالاً")}</div><div>{item.lastPurchaseCost == null ? tr("Cost missing","التكلفة مفقودة") : `${(item.lastPurchaseCost*item.unitsPerBox!).toFixed(2)} LYD/${tr("box","صندوق")} · ${(item.lastPurchaseCost*item.suggestedQty).toFixed(2)} LYD`}</div></div>
        </>}
        <button type="button" className="btn-secondary" onClick={() => save(items.filter(old => old.productId !== item.productId))}>{tr("Remove","إزالة")}</button>
      </section>)}</div>
      <div className="flex flex-wrap gap-3">{!blocked && !error ? <CreatePurchaseListButton items={safeItems} label={tr("Create purchase draft","إنشاء مسودة شراء")}/> : null}<Link href="/restock-priority/purchase-list" className="btn-secondary">{tr("Refresh from sales and storage","تحديث من المبيعات والمخزون")}</Link><button type="button" className="btn-secondary" onClick={() => {try {clearRestockShoppingList();setItems([]);setError("");} catch {setError(tr("Could not clear the saved list.","تعذر مسح القائمة المحفوظة."));}}}>{tr("Clear list","مسح القائمة")}</button></div>
    </>}
  </div>;
}
