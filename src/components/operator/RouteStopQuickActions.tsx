"use client";

import { useLanguage } from "@/components/I18nProvider";

function openSection(eventName: string, targetId: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
  window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

export function RouteStopQuickActions() {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  return (
    <section className="sticky top-2 z-20 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Quick product actions", "إجراءات المنتجات السريعة")}</div>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => openSection("snacky:open-manual-sale", "manual-route-sales")}>{tr("Manual sale", "بيع يدوي")}</button>
        <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => openSection("snacky:open-inventory-adjustment", "inventory-adjustments", { adjustmentType: "damaged" })}>{tr("Damaged", "تالف")}</button>
        <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => openSection("snacky:open-inventory-adjustment", "inventory-adjustments", { adjustmentType: "returned_from_machine" })}>{tr("Return", "إرجاع من الجهاز")}</button>
      </div>
      <p className="mt-2 text-xs text-slate-500">{tr("Tap once to open the correct searchable form. No need to scroll through every product.", "اضغط مرة واحدة لفتح النموذج الصحيح القابل للبحث دون التمرير بين كل المنتجات.")}</p>
    </section>
  );
}
