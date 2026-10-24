"use client";

import { ReactNode, useState } from "react";
import { usePathname } from "next/navigation";
import { ModuleTabsLayout } from "@/components/ModuleTabsLayout";
import { SessionGuard } from "@/components/SessionGuard";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { RoleMobileNavigation } from "@/components/RoleMobileNavigation";
import { showRoleMobileNavigation } from "@/lib/role-mobile-navigation";
import { XyBackgroundSync } from "@/components/XyBackgroundSync";
import { NotificationOptInPrompt } from "@/components/NotificationOptInPrompt";
import { AppRole, hasPermission } from "@/lib/authz";

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

export function ShellChrome({ children, profile, pathname }: { children: ReactNode; profile: ShellProfile; pathname: string }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const activePath = usePathname() ?? pathname;
  const canRefreshXy = activePath !== "/routes/new" && hasPermission(profile, "routes.create");
  const hasMobileNav = showRoleMobileNavigation(profile, activePath);

  return (
    <div className="app-shell flex h-dvh min-h-0 overflow-hidden bg-slate-100/70">
      <Sidebar role={profile.role} roles={profile.roles} mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar profile={profile} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className={`mx-auto w-full max-w-7xl px-3 pt-4 sm:px-4 md:p-8 ${hasMobileNav ? "pb-24" : "pb-4"}`}>
            <NotificationOptInPrompt userId={profile.id} />
            <ModuleTabsLayout profile={profile}>{children}</ModuleTabsLayout>
          </div>
        </main>
      </div>
      {hasMobileNav ? <RoleMobileNavigation profile={profile} onOpenMenu={() => setMobileNavOpen(true)} /> : null}
      <SessionGuard />
      <XyBackgroundSync enabled={canRefreshXy} />
    </div>
  );
}
