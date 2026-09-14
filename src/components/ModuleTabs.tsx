"use client";

import Link, { useLinkStatus } from "next/link";
import { useEffect, useRef } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { activeTabForPath, type ModuleTab } from "@/components/module-tabs-config";

export type { ModuleTab } from "@/components/module-tabs-config";

function TabPendingIndicator() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${pending ? "animate-pulse opacity-80" : "opacity-0"}`} />;
}

export function ModuleTabs({ tabs, currentPath, currentSearch = "", moduleName, activeHref, secondary = false }: {
  tabs: ModuleTab[];
  currentPath: string;
  currentSearch?: string;
  moduleName: string;
  activeHref?: string | null;
  secondary?: boolean;
}) {
  const { locale } = useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedHref = activeHref !== undefined ? activeHref : activeTabForPath(tabs, currentPath, currentSearch)?.href;

  useEffect(() => {
    const scroller = scrollRef.current;
    const active = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !active || scroller.scrollWidth <= scroller.clientWidth) return;
    const outer = scroller.getBoundingClientRect();
    const inner = active.getBoundingClientRect();
    // Only move this horizontal strip, never scroll a form or the main page.
    if (inner.left < outer.left) scroller.scrollLeft += inner.left - outer.left - 8;
    else if (inner.right > outer.right) scroller.scrollLeft += inner.right - outer.right + 8;
  }, [selectedHref, locale]);

  if (!tabs.length) return null;
  return (
    <nav aria-label={moduleName} dir={locale === "ar" ? "rtl" : "ltr"} data-navigation-tabs={secondary ? "secondary" : "primary"}>
      <div ref={scrollRef} className="flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:thin]">
        {tabs.map((item) => {
          const active = selectedHref === item.href;
          return (
            <Link key={item.href} href={item.href} prefetch={false} aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? secondary ? "bg-white font-semibold text-slate-950 shadow-sm ring-1 ring-slate-200" : "brand-selected font-semibold"
                  : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
              }`}>
              <span>{locale === "ar" ? item.labelAr || item.label : item.label}</span>
              <TabPendingIndicator />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
