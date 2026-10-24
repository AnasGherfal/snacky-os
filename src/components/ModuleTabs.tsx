"use client";

import Link, { useLinkStatus } from "next/link";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { organizeModuleNavigation } from "@/components/module-navigation-organization";

export type ModuleTab = {
  label: string;
  labelAr?: string;
  href: string;
  exact?: boolean;
  match?: string[];
  /** The few daily destinations displayed before the More menu. */
  primary?: boolean;
};

function pathnameFromHref(href: string) {
  return href.split("?")[0]?.split("#")[0] || href;
}

function TabPendingIndicator() {
  const { pending } = useLinkStatus();
  return (
    <span aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--snacky-primary)] transition-opacity ${pending ? "animate-pulse opacity-100" : "opacity-0"}`} />
  );
}

export function ModuleTabs({
  tabs, currentPath, currentSearch = "", moduleName, moduleNameAr,
}: {
  tabs: ModuleTab[];
  currentPath: string;
  currentSearch?: string;
  moduleName: string;
  moduleNameAr?: string;
}) {
  const router = useRouter();
  const { locale } = useLanguage();
  const overflowRef = useRef<HTMLDetailsElement>(null);
  const prefetched = useRef(new Set<string>());
  const [optimisticNavigation, setOptimisticNavigation] = useState<{ href: string; path: string; search: string } | null>(null);
  const optimisticHref = optimisticNavigation?.path === currentPath && optimisticNavigation.search === currentSearch
    ? optimisticNavigation.href : null;
  const activePath = optimisticHref ?? currentPath;
  const { primary, overflow, activeTab } = useMemo(
    () => organizeModuleNavigation(tabs, activePath),
    [tabs, activePath],
  );

  useEffect(() => {
    // A navigation must not leave a floating section picker open over the next page.
    if (overflowRef.current) overflowRef.current.open = false;
  }, [currentPath, currentSearch]);

  if (!tabs.length) return null;

  const displayModuleName = locale === "ar" && moduleNameAr ? moduleNameAr : moduleName;
  const goTo = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    setOptimisticNavigation({ href, path: currentPath, search: currentSearch });
    if (overflowRef.current) overflowRef.current.open = false;
  };
  const prefetchOnIntent = (href: string) => {
    // Do NOT prefetch every tab when the page mounts. Some Snacky pages are
    // expensive server-rendered dashboards; hover/focus only and at most once.
    if (prefetched.current.has(href)) return;
    prefetched.current.add(href);
    router.prefetch(href);
  };

  const navLink = (tab: ModuleTab, compact = false) => {
    const active = activeTab === tab;
    const label = locale === "ar" && tab.labelAr ? tab.labelAr : tab.label;
    return (
      <Link
        key={tab.href}
        href={tab.href}
        prefetch={false}
        onMouseEnter={() => prefetchOnIntent(tab.href)}
        onFocus={() => prefetchOnIntent(tab.href)}
        onClick={(event) => goTo(event, tab.href)}
        aria-current={active ? "page" : undefined}
        className={compact
          ? `flex min-h-12 items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${active
            ? "bg-emerald-50 font-bold text-emerald-950 ring-1 ring-inset ring-emerald-200"
            : "font-medium text-slate-700 hover:bg-slate-50 hover:text-emerald-900"}`
          : `relative inline-flex min-h-12 shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm transition-colors sm:min-h-11 ${active
            ? "bg-emerald-50 font-bold text-emerald-950 ring-1 ring-inset ring-emerald-200"
            : "font-medium text-slate-600 hover:bg-slate-50 hover:text-emerald-900"}`}
      >
        <span>{label}</span>
        <TabPendingIndicator />
        {!compact && active ? <span aria-hidden="true"
          className="absolute inset-x-4 -bottom-1 h-0.5 rounded-full bg-[var(--snacky-primary)]" /> : null}
      </Link>
    );
  };

  return (
    <nav aria-label={`${moduleName} navigation`}
      className="relative rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-800">
            {displayModuleName}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {locale === "ar" ? "انتقل بين صفحات هذا القسم" : "All the tools for this section"}
          </p>
        </div>
        {overflow.length ? (
          <span className="shrink-0 text-xs tabular-nums text-slate-400">
            {tabs.length} {locale === "ar" ? "صفحة" : "pages"}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-stretch gap-1 border-t border-slate-100 p-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {primary.map((tab) => navLink(tab))}
        </div>
        {overflow.length ? (
          <details ref={overflowRef} className="group relative shrink-0 border-s border-slate-100 ps-2">
            <summary
              className="flex min-h-12 cursor-pointer list-none items-center gap-1.5 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-800 transition-colors hover:bg-emerald-50 hover:text-emerald-900 sm:min-h-11 [&::-webkit-details-marker]:hidden"
              onKeyDown={(event) => {
                if (event.key === "Escape" && overflowRef.current) {
                  overflowRef.current.open = false;
                  (event.currentTarget as HTMLElement).focus();
                }
              }}
              aria-label={locale === "ar" ? `المزيد من صفحات ${displayModuleName}` : `More ${moduleName} pages`}
            >
              {locale === "ar" ? "المزيد" : "More"}
              <span className="rounded-full bg-white px-1.5 py-0.5 text-xs tabular-nums text-slate-600">
                {overflow.length}
              </span>
              <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="absolute end-0 top-full z-40 mt-2 max-h-[min(65dvh,29rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_18px_50px_rgba(15,23,42,0.19)]">
              <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-wide text-slate-500">
                {locale === "ar" ? "صفحات أخرى" : "More destinations"}
              </p>
              <div className="grid gap-1">{overflow.map((tab) => navLink(tab, true))}</div>
            </div>
          </details>
        ) : null}
      </div>
    </nav>
  );
}
