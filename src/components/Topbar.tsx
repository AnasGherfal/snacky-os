"use client";
import Image from "next/image";
import Link from "next/link";
import { Menu, UserCircle } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AppRole } from "@/lib/authz";

type TopbarProfile = {
  full_name: string;
  role: AppRole;
  roles?: AppRole[] | null;
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
  "/locations-pipeline": "locationsPipeline",
  "/machine-slots": "machinePlanograms",
  "/inventory": "storageInventory",
  "/restock-priority": "restockPriority",
  "/inventory/movements": "movements",
  "/purchases": "purchases",
  "/products": "products",
  "/suppliers": "suppliers",
  "/vms-import": "vmsImport",
  "/vms-mappings": "productMapping",
  "/finance": "financeOverview",
  "/finance/import": "financeImport",
  "/finance/import/review": "financeImport",
  "/finance/transactions": "financeTransactions",
  "/finance/cleanup": "financeCleanup",
  "/finance/reports": "financeReports",
  "/cash-collections": "cashCollections",
  "/issues": "issues",
  "/team": "team",
  "/settings": "settings",
  "/install": "install",
  "/account": "account",
};

export function Topbar({ profile, onMenuClick }: { profile: TopbarProfile; onMenuClick?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const { locale, dictionary, setLocale } = useI18n();
  const titleKey = titleKeys[pathname];

  const logout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8">
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
          <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-white shadow-sm md:hidden">
            <Image src="/brand/snacky-logo.png" alt="" fill sizes="36px" className="object-contain" />
          </div>
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
            <div className="text-xs text-slate-500">{(profile.roles?.length ? profile.roles : [profile.role]).join(", ")}</div>
          </div>
          <Link href="/account" className="btn-secondary hidden sm:inline-flex">
            Account
          </Link>
          <div className="hidden w-fit rounded-lg border border-slate-200 bg-slate-50 p-1 sm:inline-flex" aria-label="Language">
            <button
              type="button"
              onClick={() => setLocale("en")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${locale === "en" ? "brand-selected" : "text-slate-600 hover:bg-white"}`}
            >
              {dictionary.language.english}
            </button>
            <button
              type="button"
              onClick={() => setLocale("ar")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${locale === "ar" ? "brand-selected" : "text-slate-600 hover:bg-white"}`}
            >
              {dictionary.language.arabic}
            </button>
          </div>
          <button type="button" onClick={logout} disabled={loggingOut} className="btn-secondary hidden sm:inline-flex disabled:opacity-60">
            {loggingOut ? "Signing out" : "Logout"}
          </button>
        </div>
      </div>
    </header>
  );
}
