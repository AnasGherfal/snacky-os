"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";
import { AppRole } from "@/lib/authz";

const navGroups = [
  { titleKey: "dashboardGroup", roles: ["owner", "admin", "supervisor", "finance", "viewer"], items: [{ labelKey: "dashboard", href: "/dashboard", roles: ["owner", "admin", "supervisor", "viewer"] }, { labelKey: "sales", href: "/sales", roles: ["owner", "admin", "finance"] }, { labelKey: "productsDashboard", href: "/products-dashboard", roles: ["owner", "admin"] }, { labelKey: "machinesDashboard", href: "/machines-dashboard", roles: ["owner", "admin", "finance"] }, { labelKey: "inventoryDashboard", href: "/inventory-dashboard", roles: ["owner", "admin"] }] },
  { titleKey: "operations", roles: ["owner", "admin", "supervisor"], items: [{ labelKey: "refillRecommendations", href: "/refills" }, { labelKey: "routes", href: "/routes" }, { labelKey: "operatorProgress", href: "/operator/routes" }] },
  { titleKey: "operatorView", roles: ["operator"], items: [{ labelKey: "myRoutes", href: "/operator/routes" }, { labelKey: "todaysRoute", href: "/operator" }, { labelKey: "issues", href: "/operator" }] },
  { titleKey: "assets", roles: ["owner", "admin", "supervisor"], items: [{ labelKey: "machines", href: "/machines" }, { labelKey: "locations", href: "/locations", roles: ["owner", "admin"] }, { labelKey: "machinePlanograms", href: "/machine-slots" }] },
  { titleKey: "inventory", roles: ["owner", "admin", "supervisor", "warehouse"], items: [{ labelKey: "products", href: "/products", roles: ["owner", "admin", "warehouse"] }, { labelKey: "storageInventory", href: "/inventory", roles: ["owner", "admin", "supervisor", "warehouse"] }, { labelKey: "movementLog", href: "/inventory/movements", roles: ["owner", "admin", "supervisor", "warehouse"] }, { labelKey: "purchases", href: "/purchases", roles: ["owner", "admin", "supervisor", "warehouse"] }, { labelKey: "suppliers", href: "/suppliers", roles: ["owner", "admin"] }] },
  { titleKey: "vms", roles: ["owner", "admin"], items: [{ labelKey: "vmsImport", href: "/vms-import" }, { labelKey: "productMapping", href: "/vms-mappings" }] },
  { titleKey: "control", roles: ["owner", "admin", "supervisor", "finance"], items: [{ labelKey: "activityLog", href: "/activity", roles: ["owner", "admin", "supervisor"] }, { labelKey: "cashCollections", href: "/cash-collections" }, { labelKey: "issues", href: "/issues", roles: ["owner", "admin", "supervisor"] }, { labelKey: "team", href: "/team", roles: ["owner", "admin"] }, { labelKey: "settings", href: "/settings", roles: ["owner", "admin"] }] },
] as const;

function canSee(role: AppRole, roles?: readonly AppRole[]) {
  if (!roles) return true;
  return roles.includes(role);
}

export function Sidebar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const { dictionary } = useI18n();

  return (
    <aside className="app-sidebar hidden w-72 shrink-0 border-r border-slate-200 bg-white md:block">
      <div className="sticky top-0 h-screen overflow-y-auto p-6">
        <h2 className="text-xl font-semibold">{dictionary.app.name}</h2>
        <p className="mb-6 text-xs text-slate-500">{dictionary.app.operationsSystem}</p>
        {navGroups.filter((group) => canSee(role, group.roles)).map((group) => {
          const items = group.items.filter((item) => canSee(role, "roles" in item ? item.roles : undefined));
          if (!items.length) return null;

          return (
          <div key={group.titleKey} className="mb-5">
            <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {dictionary.nav[group.titleKey]}
            </div>
            <div className="space-y-1">
              {items.map((item) => (
                <Link key={`${group.titleKey}-${item.labelKey}-${item.href}`} href={item.href} className={pathname === item.href ? "nav-link-active" : "nav-link"}>
                  {dictionary.nav[item.labelKey]}
                </Link>
              ))}
            </div>
          </div>
        )})}
      </div>
    </aside>
  );
}
