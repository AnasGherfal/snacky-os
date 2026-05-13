"use client";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";

const titleKeys: Record<string, keyof ReturnType<typeof useI18n>["dictionary"]["nav"]> = {
  "/dashboard": "dashboard",
  "/sales": "sales",
  "/products-dashboard": "productsDashboard",
  "/machines-dashboard": "machinesDashboard",
  "/inventory-dashboard": "inventoryDashboard",
  "/refills": "refillRecommendations",
  "/routes": "routes",
  "/operator": "operatorView",
  "/machines": "machines",
  "/locations": "locations",
  "/machine-slots": "machinePlanograms",
  "/inventory": "storageInventory",
  "/products": "products",
  "/suppliers": "suppliers",
  "/vms-import": "vmsImport",
  "/vms-mappings": "productMapping",
  "/cash-collections": "cashCollections",
  "/issues": "issues",
  "/team": "team",
};

export function Topbar() {
  const pathname = usePathname();
  const { locale, dictionary, setLocale } = useI18n();
  const titleKey = titleKeys[pathname];

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium text-slate-900">{titleKey ? dictionary.nav[titleKey] : dictionary.app.name}</div>
          <div className="text-xs text-slate-500">{dictionary.app.subtitle}</div>
        </div>
        <div className="inline-flex w-fit rounded-lg border border-slate-200 bg-slate-50 p-1" aria-label="Language">
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
      </div>
    </header>
  );
}
