"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, ClipboardList, House, Menu, Warehouse } from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";
import { getAppModuleKey } from "@/components/app-navigation";
import { canAccessPath, isOwnerAdminRole, isSupervisorRole, type AppRole } from "@/lib/authz";

type MobileProfile = {
  id: string;
  role: AppRole;
  roles: AppRole[];
  active_status: "active" | "inactive";
  can_add_products: boolean;
  team_member_id: string | null;
};

const primaryDestinations = [
  { href: "/dashboard", en: "Home", ar: "الرئيسية", icon: House, module: null },
  { href: "/routes", en: "Routes", ar: "الجولات", icon: ClipboardList, module: "operations" },
  { href: "/inventory", en: "Stock", ar: "المخزون", icon: Warehouse, module: "stock" },
  { href: "/machines", en: "Machines", ar: "الماكينات", icon: Boxes, module: "machines" },
] as const;

/** Fast mobile navigation for management, without changing operator/courier screens. */
export function OwnerMobileNavigation({ profile, onOpenMenu }: {
  profile: MobileProfile;
  onOpenMenu: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const { locale } = useLanguage();
  if (!isOwnerAdminRole(profile) && !isSupervisorRole(profile)) return null;

  const context = {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  };
  const visible = primaryDestinations.filter((item) => canAccessPath(context, item.href));
  const module = getAppModuleKey(pathname);
  const isPrimaryActive = (item: (typeof primaryDestinations)[number]) =>
    item.module ? module === item.module : pathname === item.href;
  const moreActive = !visible.some(isPrimaryActive);

  return (
    <nav
      aria-label={locale === "ar" ? "التنقل السريع" : "Quick navigation"}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 shadow-[0_-6px_22px_rgba(15,23,42,0.07)] backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-1">
        {visible.map((item) => {
          const Icon = item.icon;
          const active = isPrimaryActive(item);
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
              <span className="truncate max-w-full">{locale === "ar" ? item.ar : item.en}</span>
            </Link>
          );
        })}
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
      </div>
    </nav>
  );
}
