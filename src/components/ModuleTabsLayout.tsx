"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { ModuleTabs } from "@/components/ModuleTabs";
import { useAppNavigation, type NavigationProfile } from "@/components/NavigationProvider";

export function ModuleTabsLayout({ children }: { children: ReactNode; profile?: NavigationProfile }) {
  const { pathname, search, location } = useAppNavigation();
  const { locale } = useLanguage();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const module = location?.module;
  const group = location?.section;
  const totalTabs = module?.sections.reduce((count, item) => count + item.tabs.length, 0) ?? 0;
  const moduleName = locale === "ar" ? module?.nameAr : module?.name;
  const primaryTabs = module?.sections.map((item) => ({
    label: item.label,
    labelAr: item.labelAr,
    href: item.tabs[0].href,
  })) ?? [];

  return (
    <>
      {module && group && totalTabs > 1 ? (
        <div className="mb-5 min-w-0 rounded-xl border border-slate-200 bg-white p-2 shadow-sm" data-workspace={module.id}>
          <div className="hidden md:block">
            {module.sections.length > 1 ? (
              <ModuleTabs tabs={primaryTabs} currentPath={pathname} currentSearch={search}
                moduleName={`${moduleName} — ${locale === "ar" ? "الأقسام" : "sections"}`}
                activeHref={group.tabs[0].href} />
            ) : null}
            {group.tabs.length > 1 ? (
              <div className={module.sections.length > 1 ? "mt-2 rounded-lg bg-slate-50" : ""}>
                <ModuleTabs tabs={group.tabs} currentPath={pathname} currentSearch={search}
                  moduleName={`${moduleName} — ${locale === "ar" ? group.labelAr : group.label}`}
                  activeHref={location.tab.href} secondary={module.sections.length > 1} />
              </div>
            ) : null}
          </div>
          <label className="block p-1 md:hidden">
            <span className="mb-1 block text-xs font-semibold text-slate-500">{moduleName}</span>
            <select className="field-input min-h-11" value={location.tab.href} aria-busy={pending}
              aria-label={locale === "ar" ? "انتقل داخل القسم" : "Navigate within this workspace"}
              onChange={(event) => {
                const href = event.target.value;
                if (href) startTransition(() => router.push(href));
              }}>
              {module.sections.map((item) => (
                <optgroup key={item.id} label={locale === "ar" ? item.labelAr : item.label}>
                  {item.tabs.map((entry) => <option key={entry.href} value={entry.href}>{locale === "ar" ? entry.labelAr || entry.label : entry.label}</option>)}
                </optgroup>
              ))}
            </select>
            <span className="sr-only" role="status">{pending ? locale === "ar" ? "جارٍ فتح الصفحة" : "Opening page" : ""}</span>
          </label>
        </div>
      ) : null}
      {children}
    </>
  );
}
