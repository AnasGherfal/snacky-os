"use client";

import Image from "next/image";
import Link from "next/link";
import { Menu, UserCircle } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { NotificationCenter } from "@/components/NotificationCenter";
import type { Dictionary, SupportedLocale } from "@/lib/i18n";
import { AppRole, canExecuteRoutes } from "@/lib/authz";

type TopbarProfile = {
  id: string;
  full_name: string;
  role: AppRole;
  roles?: AppRole[] | null;
};

const titleKeys: Record<string, keyof Dictionary["nav"]> = {
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
  const { locale, dictionary, setLocale } = useLanguage();
  const titleKey = titleKeys[pathname];
  const nextLocale: SupportedLocale = locale === "ar" ? "en" : "ar";
  const nextLocaleLabel = nextLocale === "ar" ? dictionary.language.arabic : dictionary.language.english;
  const canSeeNotifications = canExecuteRoutes(profile);

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
            aria-label={dictionary.shell.openNavigation}
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
          {canSeeNotifications ? (
            <div className="md:hidden">
              <NotificationCenter compact />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setLocale(nextLocale)}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:hidden"
            aria-label={`${dictionary.shell.switchLanguage}: ${nextLocaleLabel}`}
          >
            {nextLocaleLabel}
          </button>
          <Link
            href="/account"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 sm:hidden"
            aria-label={dictionary.shell.account}
          >
            <UserCircle className="h-5 w-5" />
          </Link>
          <div className="hidden text-start sm:block">
            <div className="text-xs font-medium text-slate-900">{profile.full_name}</div>
            <div className="text-xs text-slate-500">{(profile.roles?.length ? profile.roles : [profile.role]).join(", ")}</div>
          </div>
          <Link href="/account" className="btn-secondary hidden sm:inline-flex">
            {dictionary.shell.account}
          </Link>
          <div className="hidden w-fit rounded-lg border border-slate-200 bg-slate-50 p-1 sm:inline-flex" aria-label={dictionary.shell.switchLanguage}>
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
            {loggingOut ? dictionary.shell.signingOut : dictionary.shell.logout}
          </button>
        </div>
      </div>
    </header>
  );
}

