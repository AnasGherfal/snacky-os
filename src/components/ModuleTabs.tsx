"use client";

import Link, { useLinkStatus } from "next/link";
import { useMemo, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";

export type ModuleTab = {
  label: string;
  labelAr?: string;
  href: string;
  exact?: boolean;
  match?: string[];
  group?: string;
  groupAr?: string;
  advanced?: boolean;
};

function pathnameFromHref(href: string) {
  return href.split("?")[0]?.split("#")[0] || href;
}

function normalizePath(path: string) {
  const clean = pathnameFromHref(path);
  if (clean.length > 1 && clean.endsWith("/")) return clean.slice(0, -1);
  return clean || "/";
}

function pathMatchScore(currentPath: string, tab: ModuleTab) {
  const current = normalizePath(currentPath);
  const candidates = [tab.href, ...(tab.match ?? [])].map(normalizePath);
  let score = -1;

  for (const candidate of candidates) {
    const exactMatch = current === candidate;
    const prefixMatch = current.startsWith(`${candidate}/`);
    const matches = tab.exact ? exactMatch : exactMatch || prefixMatch;
    if (!matches) continue;
    score = Math.max(score, candidate.length + (exactMatch ? 10000 : 0));
  }

  return score;
}

function TabPendingIndicator() {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--snacky-primary)] transition-opacity ${pending ? "animate-pulse opacity-100" : "opacity-0"}`}
    />
  );
}

export function ModuleTabs({
  tabs,
  currentPath,
  currentSearch = "",
  moduleName,
  moduleNameAr,
}: {
  tabs: ModuleTab[];
  currentPath: string;
  currentSearch?: string;
  moduleName: string;
  moduleNameAr?: string;
}) {
  const { locale } = useLanguage();
  const [optimisticNavigation, setOptimisticNavigation] = useState<{ href: string; path: string; search: string } | null>(null);
  const [moreSearch, setMoreSearch] = useState("");
  const optimisticHref = optimisticNavigation?.path === currentPath && optimisticNavigation.search === currentSearch
    ? optimisticNavigation.href
    : null;
  const activePath = optimisticHref ?? currentPath;
  const primaryTabs = tabs.slice(0, 4);
  const extraTabs = tabs.slice(primaryTabs.length);
  const activeIndex = useMemo(() => {
    let bestIndex = -1;
    let bestScore = -1;
    tabs.forEach((tab, index) => {
      const score = pathMatchScore(activePath, tab);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }, [activePath, tabs]);

  if (!tabs.length) return null;

  const displayModuleName = locale === "ar" && moduleNameAr ? moduleNameAr : moduleName;
  const extraTabActive = activeIndex >= primaryTabs.length;
  const needle = moreSearch.trim().toLocaleLowerCase();
  const matchesMoreSearch = (tab: ModuleTab) =>
    !needle || [tab.label, tab.labelAr, tab.group, tab.groupAr]
      .some((label) => String(label ?? "").toLocaleLowerCase().includes(needle));
  const primaryMoreItems = extraTabs.filter((tab) => !tab.advanced && matchesMoreSearch(tab));
  const advancedMoreItems = extraTabs.filter((tab) => tab.advanced && matchesMoreSearch(tab));
  const activeAdvanced = activeIndex >= 0 && Boolean(tabs[activeIndex]?.advanced);
  const renderMoreItems = (items: ModuleTab[]) => items.map((tab, index) => {
    const active = tabs[activeIndex] === tab;
    const group = tab.group ?? "Other tools";
    const previousGroup = items[index - 1]?.group ?? "Other tools";
    return (
      <div key={`${tab.label}-${tab.href}`}>
        {index === 0 || group !== previousGroup ? (
          <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {locale === "ar" ? (tab.groupAr ?? "أدوات أخرى") : group}
          </div>
        ) : null}
        <Link
          href={tab.href}
          prefetch={false}
          aria-current={active ? "page" : undefined}
          onClick={(event) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            setOptimisticNavigation({ href: tab.href, path: currentPath, search: currentSearch });
            setMoreSearch("");
          }}
          className={`block rounded-lg px-3 py-2.5 text-sm transition ${
            active
              ? "bg-emerald-50 font-semibold text-emerald-950"
              : "text-slate-700 hover:bg-slate-50 hover:text-slate-950"
          }`}
        >
          {locale === "ar" && tab.labelAr ? tab.labelAr : tab.label}
        </Link>
      </div>
    );
  });

  return (
    <nav
      aria-label={`${moduleName} navigation`}
      className="relative rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-3 py-2 sm:px-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {displayModuleName}
        </div>
      </div>
      <div className="flex min-w-0 items-stretch px-2 sm:px-3">
      <div
        role="tablist"
        aria-label={`${moduleName} tabs`}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {primaryTabs.map((tab, index) => {
          const active = index === activeIndex;

          return (
            <Link
              key={`${tab.label}-${tab.href}`}
              href={tab.href}
              prefetch={true}
              onClick={(event) => {
                if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                setOptimisticNavigation({ href: tab.href, path: currentPath, search: currentSearch });
              }}
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-[var(--snacky-primary)] px-3 py-2 text-sm font-semibold text-slate-950"
                  : "inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
              }
            >
              <span>{locale === "ar" && tab.labelAr ? tab.labelAr : tab.label}</span>
              <TabPendingIndicator />
            </Link>
          );
        })}
      </div>
      {extraTabs.length ? (
        <details key={currentPath} className="group relative ms-1 shrink-0 border-s border-slate-100">
          <summary
            className={`flex min-h-11 cursor-pointer list-none items-center gap-1 border-b-2 px-3 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden ${
              extraTabActive
                ? "border-[var(--snacky-primary)] text-slate-950"
                : "border-transparent text-slate-600 hover:text-slate-950"
            }`}
            aria-label={locale === "ar" ? "المزيد من الصفحات" : "More pages"}
          >
            {locale === "ar" ? "المزيد" : "More"}
            <span aria-hidden="true" className="text-xs">{extraTabActive ? "●" : "⌄"}</span>
          </summary>
          <div className="absolute end-0 top-full z-40 mt-1 max-h-[min(70vh,30rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
            {extraTabs.length > 6 ? (
              <label className="block px-1 pb-2">
                <span className="sr-only">{locale === "ar" ? "ابحث عن صفحة" : "Find a page"}</span>
                <input
                  type="search"
                  value={moreSearch}
                  onChange={(event) => setMoreSearch(event.target.value)}
                  placeholder={locale === "ar" ? "ابحث عن صفحة..." : "Find a page..."}
                  className="field-input w-full text-sm"
                  autoComplete="off"
                />
              </label>
            ) : null}
            {renderMoreItems(primaryMoreItems)}
            {advancedMoreItems.length ? (
              needle ? renderMoreItems(advancedMoreItems) : (
                <details key={activeAdvanced ? "active-advanced" : "closed-advanced"} open={activeAdvanced ? true : undefined}
                  className="mt-2 rounded-lg border border-slate-100 bg-slate-50/70">
                  <summary className="cursor-pointer px-3 py-3 text-xs font-semibold text-slate-600">
                    {locale === "ar" ? `إعدادات ومراجعة متقدمة (${advancedMoreItems.length})` : `Advanced setup & diagnostics (${advancedMoreItems.length})`}
                  </summary>
                  <div className="border-t border-slate-100 bg-white pb-1">{renderMoreItems(advancedMoreItems)}</div>
                </details>
              )
            ) : null}
            {!primaryMoreItems.length && !advancedMoreItems.length ? (
              <p className="px-3 py-4 text-sm text-slate-500">{locale === "ar" ? "لا توجد صفحات مطابقة" : "No matching pages"}</p>
            ) : null}
          </div>
        </details>
      ) : null}
      </div>
    </nav>
  );
}
