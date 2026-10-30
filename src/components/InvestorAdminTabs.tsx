"use client";

import { useState, type ReactNode } from "react";

type Tab = "review" | "payment" | "manage";
type Props = {
  ar: boolean;
  review: ReactNode;
  payment: ReactNode;
  manage: ReactNode;
  initialTab?: Tab;
};
const tabs: Array<{ id: Tab; en: string; ar: string }> = [
  { id: "review", en: "Review a month", ar: "مراجعة شهر" },
  { id: "payment", en: "Record payment", ar: "تسجيل دفعة" },
  { id: "manage", en: "Agreement", ar: "الاتفاق" },
];

export function InvestorAdminTabs({ ar, review, payment, manage, initialTab = "review" }: Props) {
  const [active, setActive] = useState<Tab>(initialTab);
  const content = { review, payment, manage };
  return <section dir={ar ? "rtl" : "ltr"} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={ar ? "إدارة المستثمر" : "Investor management"}>
    <div className="border-b border-slate-100 bg-slate-50/60 px-3 pt-3 sm:px-5">
      <div role="tablist" aria-label={ar ? "إجراءات إدارة المستثمر" : "Investor actions"} className="flex w-full gap-1 overflow-x-auto">
        {tabs.map(tab => <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`investor-owner-panel-${tab.id}`}
          id={`investor-owner-tab-${tab.id}`}
          onClick={() => setActive(tab.id)}
          className={`shrink-0 rounded-t-lg border-b-2 px-4 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-700 ${active === tab.id ? "border-emerald-700 bg-white text-emerald-900" : "border-transparent text-slate-500 hover:bg-white/70 hover:text-slate-900"}`}>
          {ar ? tab.ar : tab.en}
        </button>)}
      </div>
    </div>
    {tabs.map(tab => <div
      key={tab.id}
      role="tabpanel"
      id={`investor-owner-panel-${tab.id}`}
      aria-labelledby={`investor-owner-tab-${tab.id}`}
      hidden={active !== tab.id}
      className="p-4 sm:p-6">
      {content[tab.id]}
    </div>)}
  </section>;
}
