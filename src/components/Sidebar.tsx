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
  LayoutDashboard,
  Package,
  PackagePlus,
  ShieldCheck,
  UserCircle,
  Warehouse,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";
import { AppRole, hasAnyRole, hasPermission, hasRole, isOperatorRole, isOwnerAdminRole, isSupervisorRole } from "@/lib/authz";

type NavLabelKey = keyof ReturnType<typeof useI18n>["dictionary"]["nav"];
type NavItem = {
  labelKey: NavLabelKey;
  href: string;
  icon: ComponentType<{ className?: string }>;
  exact?: boolean;
  activePrefixes?: string[];
  activeSearch?: { key: string; value: string | null };
};
type NavSection = {
  titleKey?: NavLabelKey;
  items: NavItem[];
};

const dashboardItem: NavItem = { labelKey: "dashboard", href: "/dashboard", icon: LayoutDashboard, exact: true };
const operationsItem: NavItem = {
  labelKey: "operations",
  href: "/routes",
  icon: ClipboardList,
  activePrefixes: ["/routes", "/refills"],
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
};
const accountItem: NavItem = {
  labelKey: "account",
  href: "/account",
  icon: UserCircle,
};
const warehouseOperationsItem: NavItem = {
  labelKey: "operations",
  href: "/warehouse/pick-lists",
  icon: ClipboardList,
  activePrefixes: ["/warehouse"],
};
const inventoryItem: NavItem = {
  labelKey: "inventory",
  href: "/inventory",
  icon: Warehouse,
  activePrefixes: ["/inventory", "/purchases", "/storage-locations", "/suppliers"],
};
const restockPriorityItem: NavItem = {
  labelKey: "restockPriority",
  href: "/restock-priority",
  icon: PackagePlus,
  activePrefixes: ["/restock-priority"],
};
const productsItem: NavItem = {
  labelKey: "products",
  href: "/products",
  icon: Package,
  activePrefixes: ["/products"],
};
const machinesItem: NavItem = {
  labelKey: "machinesGroup",
  href: "/machines",
  icon: Boxes,
  activePrefixes: ["/machines", "/machine-slots", "/issues"],
};
const financeItem: NavItem = {
  labelKey: "finance",
  href: "/finance",
  icon: Banknote,
  activePrefixes: ["/finance", "/cash-collections", "/payroll"],
};
const reportsItem: NavItem = {
  labelKey: "reports",
  href: "/reports",
  icon: BarChart3,
  activePrefixes: ["/reports", "/sales", "/products-dashboard", "/machines-dashboard", "/inventory-dashboard"],
};
const adminItem: NavItem = {
  labelKey: "admin",
  href: "/admin",
  icon: ShieldCheck,
  activePrefixes: ["/admin", "/team", "/settings", "/vms-import", "/vms-mappings", "/activity"],
};

const ownerAdminNav: NavSection[] = [
  { items: [dashboardItem, operationsItem, inventoryItem, restockPriorityItem, productsItem, machinesItem, financeItem, reportsItem, adminItem] },
];

const supervisorNav: NavSection[] = [
  { items: [dashboardItem, operationsItem, inventoryItem, restockPriorityItem, productsItem, machinesItem] },
];

const operatorNav: NavSection[] = [
  { items: [operatorOperationsItem, operatorAvailableRoutesItem, operatorIssuesItem, accountItem] },
];

const financeNav: NavSection[] = [
  { items: [financeItem] },
];

const viewerNav: NavSection[] = [{ items: [dashboardItem] }];

function mergeSections(sections: NavSection[]): NavSection[] {
  const seen = new Set<string>();
  const items: NavItem[] = [];
  sections.flatMap((section) => section.items).forEach((item) => {
    const key = `${item.labelKey}:${item.href}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  });
  return [{ items }];
}

function sectionsForRoles(role: AppRole, roles?: AppRole[] | null) {
  const context = { id: "sidebar", role, roles };
  if (isOwnerAdminRole(context)) return ownerAdminNav;

  const sections: NavSection[] = [];
  if (isSupervisorRole(context)) sections.push(...supervisorNav);
  if (isOperatorRole(context) || hasPermission(context, "assigned_routes.view")) sections.push(...operatorNav);
  if (hasPermission(context, "inventory.view") || hasPermission(context, "storage.view")) sections.push({ items: [inventoryItem] });
  if (hasPermission(context, "products.view") || hasPermission(context, "inventory.view") || hasPermission(context, "storage.view")) sections.push({ items: [restockPriorityItem] });
  if (hasPermission(context, "products.view")) sections.push({ items: [productsItem] });
  if (hasRole(context, "warehouse") || hasPermission(context, "storage.movement.view")) sections.push({ items: [warehouseOperationsItem] });
  if (hasRole(context, "purchasing")) sections.push({ items: [inventoryItem, restockPriorityItem, productsItem] });
  if (hasRole(context, "finance") || hasPermission(context, "finance.view")) sections.push(...financeNav);
  if (!sections.length && hasAnyRole(context, ["viewer"])) sections.push(...viewerNav);
  return sections.length ? mergeSections(sections) : viewerNav;
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
  const { dictionary } = useI18n();
  const sections = sectionsForRoles(role, roles);
  const [optimisticHref, setOptimisticHref] = useState<string | null>(null);
  const activePathname = optimisticHref ? pathWithoutQuery(optimisticHref) : pathname;
  const activeSearchParams = new URLSearchParams(optimisticHref ? searchFromHref(optimisticHref) : currentSearch);
  const moduleParam = activeSearchParams.get("module") ?? (roles?.includes("finance") && matchesPath(activePathname, "/purchases") ? "finance" : null);

  useEffect(() => {
    setOptimisticHref(null);
  }, [pathname, currentSearch]);

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

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pr-1" aria-label="Sidebar">
        {sections.map((section, sectionIndex) => (
          <div key={`${section.titleKey ?? "primary"}-${sectionIndex}`}>
            {section.titleKey ? (
              <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {dictionary.nav[section.titleKey]}
              </div>
            ) : null}
            <div className="space-y-1">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active =
                  matchesPath(activePathname, "/purchases") && moduleParam === "finance"
                    ? item.labelKey === "finance"
                    : matchesPath(activePathname, "/purchases")
                      ? item.labelKey === "inventory"
                      : isActiveItem(activePathname, item, activeSearchParams);

                return (
                  <Link
                    key={`${item.labelKey}-${item.href}`}
                    href={item.href}
                    prefetch={true}
                    onClick={(event) => {
                      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                      setOptimisticHref(item.href);
                      onNavigate?.();
                    }}
                    className={active ? "nav-link-active flex items-center gap-2" : "nav-link flex items-center gap-2"}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate">{dictionary.nav[item.labelKey]}</span>
                    <NavPendingIndicator />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </>
  );
}

export function Sidebar({ role, roles, mobileOpen = false, onMobileClose }: { role: AppRole; roles?: AppRole[] | null; mobileOpen?: boolean; onMobileClose?: () => void }) {
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
            aria-label="Close navigation overlay"
          />
          <aside className="app-sidebar relative flex h-full min-h-0 w-[min(20rem,86vw)] flex-col overflow-hidden border-r border-slate-200 bg-white p-5 shadow-xl">
            <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Navigation</div>
              <button
                type="button"
                onClick={onMobileClose}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700"
                aria-label="Close navigation"
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
