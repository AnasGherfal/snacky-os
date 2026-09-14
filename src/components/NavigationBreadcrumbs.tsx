"use client";

import Link from "next/link";
import { useLanguage } from "@/components/I18nProvider";
import { useOptionalAppNavigation } from "@/components/NavigationProvider";
import { navigationBreadcrumbItems, type NavigationBreadcrumbItem } from "@/lib/navigation-breadcrumbs";

export function NavigationBreadcrumbs({ items }: { items: NavigationBreadcrumbItem[] }) {
  const navigation = useOptionalAppNavigation();
  const { locale } = useLanguage();
  if (!items.length) return null;
  const currentHref = navigation ? `${navigation.pathname}${navigation.search ? `?${navigation.search}` : ""}` : "";
  const trail = navigation ? navigationBreadcrumbItems(items, navigation.user, currentHref, locale) : items;
  if (!trail.length) return null;
  return (
    <nav aria-label={locale === "ar" ? "مسار الصفحة" : "Breadcrumb"} className="mb-3 flex flex-wrap items-center gap-1 text-sm text-slate-500" data-navigation-breadcrumbs>
      {trail.map((item, index) => {
        const isLast = index === trail.length - 1;
        return (
          <span key={`${item.href || item.label}-${index}`} className="inline-flex min-w-0 items-center gap-1">
            {index > 0 ? <span aria-hidden="true" className="text-slate-300">/</span> : null}
            {item.href && !isLast ? (
              <Link href={item.href} prefetch={false} className="break-words font-medium text-slate-600 hover:text-slate-900">{item.label}</Link>
            ) : (
              <span aria-current={isLast ? "page" : undefined} className={`break-words ${isLast ? "font-medium text-slate-900" : ""}`}>{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
