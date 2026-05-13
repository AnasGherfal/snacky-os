"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";

const navGroups = [
  { titleKey: "dashboardGroup", items: [{ labelKey: "dashboard", href: "/dashboard" }, { labelKey: "sales", href: "/sales" }, { labelKey: "productsDashboard", href: "/products-dashboard" }, { labelKey: "machinesDashboard", href: "/machines-dashboard" }, { labelKey: "inventoryDashboard", href: "/inventory-dashboard" }] },
  { titleKey: "operations", items: [{ labelKey: "refillRecommendations", href: "/refills" }, { labelKey: "routes", href: "/routes" }, { labelKey: "operatorView", href: "/operator" }] },
  { titleKey: "assets", items: [{ labelKey: "machines", href: "/machines" }, { labelKey: "locations", href: "/locations" }, { labelKey: "machinePlanograms", href: "/machine-slots" }] },
  { titleKey: "inventory", items: [{ labelKey: "products", href: "/products" }, { labelKey: "storageInventory", href: "/inventory" }, { labelKey: "suppliers", href: "/suppliers" }] },
  { titleKey: "vms", items: [{ labelKey: "vmsImport", href: "/vms-import" }, { labelKey: "productMapping", href: "/vms-mappings" }] },
  { titleKey: "control", items: [{ labelKey: "cashCollections", href: "/cash-collections" }, { labelKey: "issues", href: "/issues" }, { labelKey: "team", href: "/team" }] },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { dictionary } = useI18n();

  return (
    <aside className="app-sidebar hidden w-72 shrink-0 border-r border-slate-200 bg-white md:block">
      <div className="sticky top-0 h-screen overflow-y-auto p-6">
        <h2 className="text-xl font-semibold">{dictionary.app.name}</h2>
        <p className="mb-6 text-xs text-slate-500">{dictionary.app.operationsSystem}</p>
        {navGroups.map((group) => (
          <div key={group.titleKey} className="mb-5">
            <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {dictionary.nav[group.titleKey]}
            </div>
            <div className="space-y-1">
              {group.items.map((item) => (
                <Link key={item.href} href={item.href} className={pathname === item.href ? "nav-link-active" : "nav-link"}>
                  {dictionary.nav[item.labelKey]}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
