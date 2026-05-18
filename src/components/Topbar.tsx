"use client";
import Link from "next/link";
import { Menu, UserCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";
import { AppRole } from "@/lib/authz";

type TopbarProfile = {
  full_name: string;
  role: AppRole;
};

const titleKeys: Record<string, keyof ReturnType<typeof useI18n>["dictionary"]["nav"]> = {
  "/dashboard": "dashboard",
  "/sales": "sales",
  "/products-dashboard": "productsDashboard",
  "/machines-dashboard": "machinesDashboard",
  "/inventory-dashboard": "inventoryDashboard",
  "/reports": "reports",
  "/admin": "admin",
  "/refills": "refillRecommendations",
  "/routes": "routes",
  "/operator": "operatorView",
  "/operator/issues": "issues",
  "/warehouse/pick-lists": "pickLists",
  "/machines": "machines",
  "/locations": "locations",
  "/machine-slots": "machinePlanograms",
  "/inventory": "storageInventory",
  "/inventory/movements": "movements",
  "/purchases": "purchases",
  "/products": "products",
  "/suppliers": "suppliers",
  "/vms-import": "vmsImport",
  "/vms-mappings": "productMapping",
  "/finance": "financeOverview",
  "/finance/transactions": "financeTransactions",
  "/finance/reports": "financeReports",
  "/cash-collections": "cashCollections",
  "/issues": "issues",
  "/team": "team",
  "/settings": "settings",
  "/account": "account",
};

export function Topbar({ profile, onMenuClick }: { profile: TopbarProfile; onMenuClick?: () => void }) {
  const pathname = usePathname();
  const { locale, dictionary, setLocale } = useI18n();
  const titleKey = titleKeys[pathname];

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onMenuClick}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-900">{titleKey ? dictionary.nav[titleKey] : dictionary.app.name}</div>
            <div className="truncate text-xs text-slate-500">{dictionary.app.subtitle}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/account"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 sm:hidden"
            aria-label="Account"
          >
            <UserCircle className="h-5 w-5" />
          </Link>
          <div className="hidden text-right sm:block">
            <div className="text-xs font-medium text-slate-900">{profile.full_name}</div>
            <div className="text-xs text-slate-500">{profile.role}</div>
          </div>
          <Link href="/account" className="btn-secondary hidden sm:inline-flex">
            Account
          </Link>
          <div className="hidden w-fit rounded-lg border border-slate-200 bg-slate-50 p-1 sm:inline-flex" aria-label="Language">
            <button
              type="button"
              onClick={() => setLocale("en")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${locale === "en" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}
            >
              {dictionary.language.english}
            </button>
            <button
              type="button"
              onClick={() => setLocale("ar")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${locale === "ar" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}
            >
              {dictionary.language.arabic}
            </button>
          </div>
          <button type="button" onClick={logout} className="btn-secondary hidden sm:inline-flex">
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
