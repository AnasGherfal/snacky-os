import type { ModuleTab } from "@/components/ModuleTabs";

/** Match exact and nested pages without treating /products as /products-dashboard. */
function cleanPath(value: string) {
  const path = value.split("?")[0]?.split("#")[0] || "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function moduleTabMatchScore(pathname: string, tab: ModuleTab) {
  const pathnameClean = cleanPath(pathname);
  const candidates = [tab.href, ...(tab.match ?? [])].map(cleanPath);
  let best = -1;
  for (const candidate of candidates) {
    const exact = pathnameClean === candidate;
    if (!exact && (tab.exact || !pathnameClean.startsWith(`${candidate}/`))) continue;
    best = Math.max(best, candidate.length + (exact ? 10000 : 0));
  }
  return best;
}

export function organizeModuleNavigation(tabs: readonly ModuleTab[], pathname: string, visibleLimit = 5) {
  const best = tabs.reduce(
    (value, tab, index) => {
      const score = moduleTabMatchScore(pathname, tab);
      return score > value.score ? { index, score } : value;
    },
    { index: -1, score: -1 },
  );
  const activeTab = best.index < 0 ? null : tabs[best.index];
  const maxVisible = Math.max(2, Math.floor(visibleLimit));

  // Preserve the existing navigation in compact groups (no surprise reshuffle).
  if (tabs.length <= maxVisible + 1) {
    return { primary: [...tabs], overflow: [] as ModuleTab[], activeTab };
  }

  const primary = tabs.filter((tab) => tab.primary).slice(0, maxVisible);
  for (const tab of tabs) {
    if (primary.length >= maxVisible) break;
    if (!primary.includes(tab)) primary.push(tab);
  }
  // A deep link must always have its active page visible; do not lose it in "More".
  if (activeTab && !primary.includes(activeTab)) {
    primary[primary.length - 1] = activeTab;
  }
  const overflow = tabs.filter((tab) => !primary.includes(tab));
  return { primary, overflow, activeTab };
}
