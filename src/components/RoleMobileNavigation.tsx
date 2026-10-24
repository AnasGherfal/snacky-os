"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertCircle, Banknote, Boxes, BriefcaseBusiness, ClipboardList, House,
  ListChecks, MapPin, Menu, Package, ShoppingCart, Truck, UserCircle, Users, Warehouse,
} from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";
import { getAppModuleKey } from "@/components/app-navigation";
import {
  activeMobileShortcutIndex, getRoleMobileDestinations, mobileRoleKind,
  showRoleMobileNavigation, type MobileRoleProfile, type MobileShortcut,
} from "@/lib/role-mobile-navigation";

const icons: Record<MobileShortcut["icon"], typeof House> = {
  house: House, route: Truck, warehouse: Warehouse, machines: Boxes, work: BriefcaseBusiness,
  issues: AlertCircle, leads: Users, sites: MapPin, available: ListChecks, cash: Banknote,
  buying: ShoppingCart, finance: Banknote, account: UserCircle, pick: ClipboardList, products: Package,
};

/** Fast, role-scoped phone navigation. Full modules remain in the existing sidebar. */
export function RoleMobileNavigation({ profile, onOpenMenu }: {
  profile: MobileRoleProfile;
  onOpenMenu: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const { locale } = useLanguage();
  if (!showRoleMobileNavigation(profile, pathname)) return null;

  const items = getRoleMobileDestinations(profile);
  const activeIndex = activeMobileShortcutIndex(items, pathname, search?.toString() ?? "", getAppModuleKey(pathname));
  const mode = mobileRoleKind(profile);
  const showMore = mode !== "investor" && mode !== "viewer";
  const moreActive = activeIndex < 0;

  return (
    <nav
      aria-label={locale === "ar" ? "التنقل السريع" : "Quick navigation"}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 shadow-[0_-6px_22px_rgba(15,23,42,0.07)] backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-1">
        {items.map((item, index) => {
          const Icon = icons[item.icon];
          const active = index === activeIndex;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] font-semibold leading-tight transition focus-visible:outline-offset-[-3px] ${
                active ? "text-[var(--snacky-accent)]" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="max-w-full truncate">{locale === "ar" ? item.ar : item.en}</span>
            </Link>
          );
        })}
        {showMore ? (
          <button
            type="button"
            onClick={onOpenMenu}
            aria-haspopup="dialog"
            aria-label={locale === "ar" ? "افتح باقي أقسام سناكي" : "Open all Snacky sections"}
            className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] font-semibold leading-tight focus-visible:outline-offset-[-3px] ${
              moreActive ? "text-[var(--snacky-accent)]" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
            }`}
          >
            <Menu className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{locale === "ar" ? "المزيد" : "More"}</span>
          </button>
        ) : null}
      </div>
    </nav>
  );
}
