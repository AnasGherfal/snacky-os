import { canAccessPath, type AuthUserContext } from "./authz.ts";
import { navigationContextForUser, navigationModules, pathnameFromHref } from "../components/module-tabs-config.ts";

export type NavigationBreadcrumbItem = { label: string; href?: string };
const registeredPaths = new Set(navigationModules.flatMap((module) => module.sections.flatMap((group) => group.tabs.map((item) => pathnameFromHref(item.href)))));

/** Replace outdated workspace crumbs, but keep record names supplied by the page.
 * Never turn permission to see one record into a link to a forbidden index. */
export function navigationBreadcrumbItems(items: NavigationBreadcrumbItem[], user: AuthUserContext, pathname: string, locale: "en" | "ar"): NavigationBreadcrumbItem[] {
  const path = pathnameFromHref(pathname);
  const { location } = navigationContextForUser(user, pathname);
  if (!location) return items.filter((item) => !item.href || canAccessPath(user, pathnameFromHref(item.href)));
  const { module, tab } = location;
  const rootHref = module.href || module.sections[0].tabs[0].href;
  const result: NavigationBreadcrumbItem[] = [{ label: locale === "ar" ? module.nameAr : module.name, href: pathnameFromHref(rootHref) === path ? undefined : rootHref }];
  const leafPath = pathnameFromHref(tab.href);
  if (leafPath !== pathnameFromHref(rootHref) && leafPath !== path && canAccessPath(user, leafPath)) {
    result.push({ label: locale === "ar" ? tab.labelAr || tab.label : tab.label, href: tab.href });
  }
  for (const item of items.slice(0, -1)) {
    if (!item.href) continue;
    const parent = pathnameFromHref(item.href);
    if (registeredPaths.has(parent) || parent === path || !path.startsWith(`${parent}/`) || !canAccessPath(user, parent)) continue;
    if (!result.some((entry) => entry.href && pathnameFromHref(entry.href) === parent)) result.push(item);
  }
  const terminal = registeredPaths.has(path) ? locale === "ar" ? tab.labelAr || tab.label : tab.label : items[items.length - 1]?.label || (locale === "ar" ? tab.labelAr || tab.label : tab.label);
  if (result[result.length - 1]?.label !== terminal) result.push({ label: terminal });
  return result;
}
