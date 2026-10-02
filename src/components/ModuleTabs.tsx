"use client";

import Link, { useLinkStatus } from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";

export type ModuleTab = {
  label: string;
  labelAr?: string;
  href: string;
  exact?: boolean;
  match?: string[];
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
  const router = useRouter();
  const { locale } = useLanguage();
  const [optimisticNavigation, setOptimisticNavigation] = useState<{ href: string; path: string; search: string } | null>(null);
  const optimisticHref = optimisticNavigation?.path === currentPath && optimisticNavigation.search === currentSearch
    ? optimisticNavigation.href
    : null;
  const activePath = optimisticHref ?? currentPath;
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

  useEffect(() => {
    tabs.forEach((tab) => router.prefetch(tab.href));
  }, [router, tabs]);

  if (!tabs.length) return null;

  const displayModuleName = locale === "ar" && moduleNameAr ? moduleNameAr : moduleName;

  return (
    <nav
      aria-label={`${moduleName} navigation`}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-3 py-2 sm:px-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {displayModuleName}
        </div>
      </div>
      <div
        role="tablist"
        aria-label={`${moduleName} tabs`}
        className="flex gap-1 overflow-x-auto whitespace-nowrap px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-3"
      >
        {tabs.map((tab, index) => {
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
    </nav>
  );
}
