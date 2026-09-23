"use client";

import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Banknote,
  BarChart3,
  Boxes,
  ClipboardList,
  HandCoins,
  LayoutDashboard,
  ShieldCheck,
  UserCircle,
  Warehouse,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { getAppModuleKey, type AppModuleKey } from "@/components/app-navigation";
import {
  AppRole,
  hasAnyRole,
  hasPermission,
  hasRole,
  isOperatorRole,
  isOwnerAdminRole,
  isSupervisorRole,
} from "@/lib/authz";
import { companyHubEnabled, companyRoles } from "@/lib/company-hub";
import type { Dictionary } from "@/lib/i18n";

type NavLabelKey = keyof Dictionary["nav"];
type LocalizedText = { en: string; ar: string };
type NavItem = {
  labelKey?: NavLabelKey;
  label?: LocalizedText;
  href: string;
  icon: ComponentType<{ className?: string }>;
  moduleKey?: AppModuleKey;
  exact?: boolean;
  activePrefixes?: string[];
  activeSearch?: { key: string; value: string | null };
};
type NavSection = {
  titleKey?: NavLabelKey;
  title?: LocalizedText;
  items: NavItem[];
};

const sectionTitles = {
  work: { en: "Work", ar: "العمل" },
  business: { en: "Business", ar: "الأعمال" },
  system: { en: "System", ar: "النظام" },
  account: { en: "Account", ar: "الحساب" },
} satisfies Record<string, LocalizedText>;

const dashboardItem: NavItem = {
  labelKey: "dashboard",
  href: "/dashboard",
  icon: LayoutDashboard,
  exact: true,
};
const operationsItem: NavItem = {
  labelKey: "operations",
  href: "/routes",
  icon: ClipboardList,
  moduleKey: "operations",
};
const operatorOperationsItem: NavItem = {
  labelKey: "myRoutes",
  href: "/operator/routes",
  icon: ClipboardList,
  activePrefixes: ["/operator/routes"],
  activeSearch: { key: "view", value: null },
};
const operatorAvailableRoutesItem: NavItem = {
  labelKey: "availableRoutes",
  href: "/operator/routes?view=available",
  icon: ClipboardList,
  exact: true,
  activeSearch: { key: "view", value: "available" },
};
const operatorIssuesItem: NavItem = {
  labelKey: "issues",
  href: "/operator/issues",
  icon: AlertCircle,
  exact: true,
};
const operatorTasksItem: NavItem = {
  label: { en: "Customer issue tasks", ar: "مهام مشاكل العملاء" },
  href: "/operator/issues/actions",
  icon: ClipboardList,
  activePrefixes: ["/operator/issues/actions", "/follow-ups"],
};
const accountItem: NavItem = {
  labelKey: "account",
  href: "/account",
  icon: UserCircle,
};
const investorPortalItem: NavItem = {
  label: { en: "Investor Portal", ar: "بوابة المستثمر" },
  href: "/investor",
  icon: HandCoins,
  activePrefixes: ["/investor"],
};
const warehouseOperationsItem: NavItem = {
  label: { en: "Warehouse Pick Lists", ar: "قوائم تجهيز المخزن" },
  href: "/warehouse/pick-lists",
  icon: ClipboardList,
  activePrefixes: ["/warehouse"],
};
const stockItem: NavItem = {
  label: { en: "Stock & Purchasing", ar: "المخزون والمشتريات" },
  href: "/inventory",
  icon: Warehouse,
  moduleKey: "stock",
};
const purchasingStockItem: NavItem = {
  label: { en: "Stock & Purchasing", ar: "المخزون والمشتريات" },
  href: "/purchases",
  icon: Warehouse,
  moduleKey: "stock",
};
const machinesItem: NavItem = {
  labelKey: "machinesGroup",
  href: "/machines",
  icon: Boxes,
  moduleKey: "machines",
};
const crmItem: NavItem = {
  label: { en: "Customer Relations", ar: "علاقات العملاء" },
  href: "/my-work",
  icon: UserCircle,
  moduleKey: "crm",
};
const financeItem: NavItem = {
  labelKey: "finance",
  href: "/finance",
  icon: Banknote,
  moduleKey: "finance",
};
const cashRemovalItem: NavItem = {
  label: { en: "Remove Cash", ar: "سحب النقد" },
  href: "/cash-collections/new",
  icon: HandCoins,
  moduleKey: "cash",
};
const cashCustodyItem: NavItem = {
  label: { en: "Cash", ar: "النقدية" },
  href: "/cash-collections",
  icon: HandCoins,
  moduleKey: "cash",
};
const reportsItem: NavItem = {
  labelKey: "reports",
  href: "/reports",
  icon: BarChart3,
  moduleKey: "reports",
};
const adminItem: NavItem = {
  labelKey: "admin",
  href: "/admin",
  icon: ShieldCheck,
  moduleKey: "admin",
};

const cashHandlingItem: NavItem = { label: { en: "Cash handling", ar: "تسليم وعد النقد" }, href: "/cash-handling", icon: HandCoins, activePrefixes: ["/cash-handling"] };

const buyingListsItem: NavItem = { label: {en:"My buying lists", ar:"قوائم الشراء المسندة"}, href:"/buying-lists", icon:ClipboardList, activePrefixes:["/buying-lists"] };

const companyItem: NavItem = { label: { en: "Company", ar: "الشركة" }, href: "/company", icon: ClipboardList, moduleKey: "company" };

const ownerAdminNav: NavSection[] = [
  { items: [dashboardItem] },
  { title: sectionTitles.work, items: [operationsItem, cashCustodyItem, cashHandlingItem, stockItem, machinesItem, crmItem, ...(companyHubEnabled ? [companyItem] : [])] },
  { title: sectionTitles.business, items: [financeItem, reportsItem] },
  { title: sectionTitles.system, items: [adminItem] },
];

const supervisorNav: NavSection[] = [
  { items: [dashboardItem] },
  { title: sectionTitles.work, items: [operationsItem, cashCustodyItem, cashHandlingItem, stockItem, machinesItem, crmItem, ...(companyHubEnabled ? [companyItem] : [])] },
  { title: sectionTitles.business, items: [financeItem] },
];

// A pure investor account intentionally stays isolated from operational modules.
// Keep this named contract because investor access has its own regression coverage.
const investorNav: NavSection[] = [
  { title: sectionTitles.business, items: [investorPortalItem] },
  { title: sectionTitles.account, items: [accountItem] },
];

const operatorNavItems: NavItem[] = [
  operatorOperationsItem,
  operatorAvailableRoutesItem,
  cashRemovalItem,
  operatorIssuesItem,
  operatorTasksItem,
];

function itemIdentity(item: NavItem) {
  return `${item.moduleKey ?? "direct"}:${item.labelKey ?? item.label?.en ?? "item"}:${item.href}`;
}

function uniqueItems(items: NavItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemIdentity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionsForRoles(role: AppRole, roles?: AppRole[] | null): NavSection[] {
  const context = { id: "sidebar", role, roles };
  if (isOwnerAdminRole(context)) return ownerAdminNav;
  if (isSupervisorRole(context)) return supervisorNav;

  const effectiveRoles = roles?.length ? roles : [role];
  if (effectiveRoles.length === 1 && effectiveRoles[0] === "investor") return investorNav;

  const primary: NavItem[] = [];
  const work: NavItem[] = [];
  const business: NavItem[] = [];

  if (hasPermission(context, "dashboard.view")) primary.push(dashboardItem);
  if (isOperatorRole(context) || hasPermission(context, "assigned_routes.view")) {
    work.push(...operatorNavItems);
  }
  if (hasPermission(context, "locations.pipeline.manage") || hasPermission(context, "issues.view")) {
    work.push(crmItem);
  }
  if (hasPermission(context, "machines.view")) work.push(machinesItem);

  if (hasPermission(context, "inventory.view") || hasPermission(context, "storage.view")) {
    work.push(stockItem);
  } else if (
    hasPermission(context, "purchases.view") ||
    hasPermission(context, "purchase_items.view") ||
    hasPermission(context, "products.view") ||
    hasPermission(context, "suppliers.view")
  ) {
    work.push(purchasingStockItem);
  }

  if (hasRole(context, "warehouse") || hasPermission(context, "storage.movement.view")) {
    work.push(warehouseOperationsItem);
  }
  if (hasPermission(context, "cash.receive") && !hasPermission(context, "finance.view")) {
    work.push(cashCustodyItem);
  }
  if (hasPermission(context, "finance.view")) {
    business.push(financeItem);
    work.push(cashCustodyItem);
  }
  if (hasAnyRole(context, ["crm", "operator", "finance"]) && !hasAnyRole(context, ["warehouse", "purchasing"])) work.push(buyingListsItem);
  if (hasAnyRole(context, ["operator", "warehouse", "purchasing", "finance"])) work.push(cashHandlingItem);
  if (companyHubEnabled && hasAnyRole(context, companyRoles)) work.push(companyItem);
  if (hasPermission(context, "reports.view")) business.push(reportsItem);
  if (hasPermission(context, "investor.view")) business.push(investorPortalItem);

  if (!primary.length && !work.length && !business.length && hasAnyRole(context, ["viewer"])) {
    primary.push(dashboardItem);
  }

  const sections: NavSection[] = [];
  if (primary.length) sections.push({ items: uniqueItems(primary) });
  if (work.length) sections.push({ title: sectionTitles.work, items: uniqueItems(work) });
  if (business.length) sections.push({ title: sectionTitles.business, items: uniqueItems(business) });
  sections.push({ title: sectionTitles.account, items: [accountItem] });
  return sections;
}

function pathWithoutQuery(href: string) {
  return href.split("?")[0] || href;
}

function searchFromHref(href: string) {
  return href.split("?")[1]?.split("#")[0] ?? "";
}

function matchesPath(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isActiveItem(pathname: string, item: NavItem, searchParams?: URLSearchParams) {
  if (item.activeSearch) {
    const current = searchParams?.get(item.activeSearch.key) ?? null;
    if (current !== item.activeSearch.value) return false;
  }
  if (item.activePrefixes?.some((prefix) => matchesPath(pathname, prefix))) return true;
  const hrefPath = pathWithoutQuery(item.href);
  if (item.exact) return pathname === hrefPath;
  return matchesPath(pathname, hrefPath);
}

function NavPendingIndicator() {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden="true"
      className={`ms-auto h-1.5 w-1.5 shrink-0 rounded-full bg-current transition-opacity ${pending ? "animate-pulse opacity-70" : "opacity-0"}`}
    />
  );
}

function SidebarContent({ role, roles, onNavigate }: { role: AppRole; roles?: AppRole[] | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const { dictionary, locale } = useLanguage();
  const sections = sectionsForRoles(role, roles);
  const [optimisticHref, setOptimisticHref] = useState<string | null>(null);
  const [optimisticOriginHref, setOptimisticOriginHref] = useState<string | null>(null);
  const currentHref = currentSearch ? `${pathname}?${currentSearch}` : pathname;
  const useOptimisticHref = Boolean(optimisticHref && optimisticOriginHref === currentHref);
  const activePathname = useOptimisticHref && optimisticHref ? pathWithoutQuery(optimisticHref) : pathname;
  const activeSearchParams = new URLSearchParams(useOptimisticHref && optimisticHref ? searchFromHref(optimisticHref) : currentSearch);
  const activeModule = getAppModuleKey(activePathname);

  useEffect(() => {
    sections.forEach((section) => {
      section.items.forEach((item) => router.prefetch(item.href));
    });
  }, [router, sections]);

  return (
    <>
      <div className="mb-6 flex shrink-0 items-center gap-3">
        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm">
          <Image src="/brand/snacky-logo.png" alt="" fill sizes="48px" className="object-contain" />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-950">{dictionary.app.name}</h2>
          <p className="truncate text-xs text-slate-500">{dictionary.app.operationsSystem}</p>
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pe-1" aria-label={dictionary.shell.navigation}>
        {sections.map((section, sectionIndex) => {
          const sectionTitle = section.title
            ? section.title[locale]
            : section.titleKey
              ? dictionary.nav[section.titleKey]
              : null;

          return (
            <div key={`${sectionTitle ?? "primary"}-${sectionIndex}`}>
              {sectionTitle ? (
                <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {sectionTitle}
                </div>
              ) : null}
              <div className="space-y-1">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.moduleKey
                    ? activeModule === item.moduleKey
                    : isActiveItem(activePathname, item, activeSearchParams);
                  const label = item.label
                    ? item.label[locale]
                    : item.labelKey
                      ? dictionary.nav[item.labelKey]
                      : item.href;

                  return (
                    <Link
                      key={itemIdentity(item)}
                      href={item.href}
                      prefetch={true}
                      onClick={(event) => {
                        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                        setOptimisticOriginHref(currentHref);
                        setOptimisticHref(item.href);
                        onNavigate?.();
                      }}
                      className={active ? "nav-link-active flex items-center gap-2" : "nav-link flex items-center gap-2"}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">{label}</span>
                      <NavPendingIndicator />
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </>
  );
}

export function Sidebar({ role, roles, mobileOpen = false, onMobileClose }: { role: AppRole; roles?: AppRole[] | null; mobileOpen?: boolean; onMobileClose?: () => void }) {
  const { dictionary } = useLanguage();
  return (
    <>
      <aside className="app-sidebar sticky top-0 hidden h-dvh w-72 shrink-0 overflow-hidden border-r border-slate-200 bg-white md:flex md:flex-col">
        <div className="flex min-h-0 flex-1 flex-col p-5">
          <SidebarContent role={role} roles={roles} />
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/40"
            onClick={onMobileClose}
            aria-label={dictionary.shell.closeNavigationOverlay}
          />
          <aside className="app-sidebar relative flex h-full min-h-0 w-[min(20rem,86vw)] flex-col overflow-hidden border-r border-slate-200 bg-white p-5 shadow-xl">
            <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{dictionary.shell.navigation}</div>
              <button
                type="button"
                onClick={onMobileClose}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700"
                aria-label={dictionary.shell.closeNavigation}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarContent role={role} roles={roles} onNavigate={onMobileClose} />
          </aside>
        </div>
      ) : null}
    </>
  );
}
