"use client";

import { useCallback, useState, type ReactNode } from "react";
import { ModuleTabsLayout } from "@/components/ModuleTabsLayout";
import { NavigationProvider, useAppNavigation } from "@/components/NavigationProvider";
import { useLanguage } from "@/components/I18nProvider";
import { SessionGuard } from "@/components/SessionGuard";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { XyBackgroundSync } from "@/components/XyBackgroundSync";
import { type AppRole, hasPermission } from "@/lib/authz";

type ShellProfile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: AppRole;
  roles: AppRole[];
  can_add_products: boolean;
  active_status: "active" | "inactive";
  team_member_id: string | null;
};

function ShellContent({ children, profile }: { children: ReactNode; profile: ShellProfile }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeNavigation = useCallback(() => setMobileNavOpen(false), []);
  const { pathname } = useAppNavigation();
  const { locale } = useLanguage();
  const canRefreshXy = pathname !== "/routes/new" && hasPermission(profile, "routes.create");

  return (
    <div className="app-shell flex h-dvh min-h-0 overflow-hidden bg-slate-100/70" dir={locale === "ar" ? "rtl" : "ltr"}>
      <a href="#snacky-main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[90] focus:rounded-lg focus:bg-white focus:p-3">{locale === "ar" ? "انتقل إلى المحتوى" : "Skip to content"}</a>
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={closeNavigation} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={mobileNavOpen || undefined}>
        <Topbar profile={profile} onMenuClick={() => setMobileNavOpen(true)} mobileNavOpen={mobileNavOpen} />
        <main id="snacky-main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-7xl px-3 py-4 sm:px-5 lg:p-6">
            <ModuleTabsLayout>{children}</ModuleTabsLayout>
          </div>
        </main>
      </div>
      <SessionGuard />
      <XyBackgroundSync enabled={canRefreshXy} />
    </div>
  );
}

export function ShellChrome({ children, profile }: { children: ReactNode; profile: ShellProfile; pathname: string }) {
  return <NavigationProvider profile={profile}><ShellContent profile={profile}>{children}</ShellContent></NavigationProvider>;
}
