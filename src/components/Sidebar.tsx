"use client";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  AlertCircle,
  Banknote,
  BarChart3,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  Package,
  ReceiptText,
  ShieldCheck,
  ShoppingCart,
  UserCircle,
  Warehouse,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";
import { AppRole } from "@/lib/authz";

type NavLabelKey = keyof ReturnType<typeof useI18n>["dictionary"]["nav"];
type NavItem = {
  labelKey: NavLabelKey;
  href: string;
  icon: ComponentType<{ className?: string }>;
  exact?: boolean;
  activePrefixes?: string[];
};
type NavSection = {
  titleKey?: NavLabelKey;
  items: NavItem[];
};

const dashboardItem: NavItem = { labelKey: "dashboard", href: "/dashboard", icon: LayoutDashboard, exact: true };
const routesItem: NavItem = { labelKey: "routes", href: "/routes", icon: ClipboardList };
const refillsItem: NavItem = { labelKey: "refillRecommendations", href: "/refills", icon: ListChecks };
const storageItem: NavItem = { labelKey: "storage", href: "/inventory", icon: Warehouse, activePrefixes: ["/inventory"] };
const storageExactItem: NavItem = { labelKey: "storage", href: "/inventory", icon: Warehouse, exact: true };
const movementsItem: NavItem = { labelKey: "movements", href: "/inventory/movements", icon: Boxes };
const purchasesItem: NavItem = { labelKey: "purchases", href: "/purchases", icon: ShoppingCart };
const productsItem: NavItem = { labelKey: "products", href: "/products", icon: Package };
const machinesItem: NavItem = { labelKey: "machines", href: "/machines", icon: Boxes };
const planogramsItem: NavItem = { labelKey: "planograms", href: "/machine-slots", icon: ListChecks };
const issuesItem: NavItem = { labelKey: "issues", href: "/issues", icon: AlertCircle };
const financeOverviewItem: NavItem = { labelKey: "financeOverview", href: "/finance", icon: Banknote, exact: true };
const financeTransactionsItem: NavItem = { labelKey: "financeTransactions", href: "/finance/transactions", icon: ReceiptText };
const cashCollectionsItem: NavItem = { labelKey: "cashCollections", href: "/cash-collections", icon: Banknote };
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
  activePrefixes: ["/admin", "/team", "/settings", "/vms-import", "/vms-mappings", "/activity", "/storage-locations", "/suppliers"],
};
const accountItem: NavItem = { labelKey: "account", href: "/account", icon: UserCircle };

const ownerAdminNav: NavSection[] = [
  { items: [dashboardItem] },
  { titleKey: "operations", items: [routesItem, refillsItem] },
  { titleKey: "inventory", items: [storageItem, purchasesItem, productsItem] },
  { titleKey: "machinesGroup", items: [machinesItem, planogramsItem, issuesItem] },
  { titleKey: "finance", items: [financeOverviewItem, financeTransactionsItem, cashCollectionsItem] },
  { items: [reportsItem, adminItem] },
];

const supervisorNav: NavSection[] = [
  { items: [dashboardItem] },
  { titleKey: "operations", items: [routesItem, refillsItem] },
  { titleKey: "inventory", items: [storageItem, purchasesItem] },
  { titleKey: "machinesGroup", items: [machinesItem, planogramsItem, issuesItem] },
];

const operatorNav: NavSection[] = [
  {
    items: [
      { labelKey: "myRoutes", href: "/operator/routes", icon: ClipboardList },
      { labelKey: "issues", href: "/operator/issues", icon: AlertCircle },
      accountItem,
    ],
  },
];

const warehouseNav: NavSection[] = [
  {
    items: [
      storageExactItem,
      purchasesItem,
      movementsItem,
      { labelKey: "pickLists", href: "/warehouse/pick-lists", icon: ClipboardList },
      accountItem,
    ],
  },
];

const financeNav: NavSection[] = [
  {
    items: [
      financeOverviewItem,
      financeTransactionsItem,
      cashCollectionsItem,
      purchasesItem,
      { labelKey: "reports", href: "/finance/reports", icon: BarChart3 },
      accountItem,
    ],
  },
];

const viewerNav: NavSection[] = [{ items: [dashboardItem, accountItem] }];

function sectionsForRole(role: AppRole) {
  if (role === "owner" || role === "admin") return ownerAdminNav;
  if (role === "supervisor") return supervisorNav;
  if (role === "operator") return operatorNav;
  if (role === "warehouse") return warehouseNav;
  if (role === "finance") return financeNav;
  return viewerNav;
}

function pathWithoutQuery(href: string) {
  return href.split("?")[0] || href;
}

function matchesPath(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isActiveItem(pathname: string, item: NavItem) {
  if (item.activePrefixes?.some((prefix) => matchesPath(pathname, prefix))) return true;
  const hrefPath = pathWithoutQuery(item.href);
  if (item.exact) return pathname === hrefPath;
  return matchesPath(pathname, hrefPath);
}

export function Sidebar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const { dictionary } = useI18n();
  const sections = sectionsForRole(role);

  return (
    <aside className="app-sidebar hidden w-72 shrink-0 border-r border-slate-200 bg-white md:block">
      <div className="sticky top-0 h-screen overflow-y-auto p-5">
        <h2 className="text-xl font-semibold">{dictionary.app.name}</h2>
        <p className="mb-5 text-xs text-slate-500">{dictionary.app.operationsSystem}</p>

        <nav className="space-y-5" aria-label="Sidebar">
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
                  const active = isActiveItem(pathname, item);

                  return (
                    <Link
                      key={`${item.labelKey}-${item.href}`}
                      href={item.href}
                      className={active ? "nav-link-active flex items-center gap-2" : "nav-link flex items-center gap-2"}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{dictionary.nav[item.labelKey]}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}
