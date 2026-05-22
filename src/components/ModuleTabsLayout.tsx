"use client";

import { ReactNode, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ModuleTabs } from "@/components/ModuleTabs";
import { getModuleTabGroupForPath, pathnameFromHref } from "@/components/module-tabs-config";
import { AppRole, canAccessPath } from "@/lib/authz";

type ModuleTabsProfile = {
  id: string;
  role: AppRole;
  roles?: AppRole[] | null;
  can_add_products?: boolean | null;
  active_status: "active" | "inactive";
  team_member_id: string | null;
};

function isPurchasesPath(pathname: string) {
  return pathname === "/purchases" || pathname.startsWith("/purchases/");
}

export function ModuleTabsLayout({ children, profile }: { children: ReactNode; profile: ModuleTabsProfile }) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const moduleParam = searchParams.get("module") ?? (profile.roles?.includes("finance") && isPurchasesPath(pathname) ? "finance" : null);
  const tabGroup = getModuleTabGroupForPath(pathname, moduleParam);
  const visibleTabs = useMemo(
    () => {
      const userContext = {
        id: profile.id,
        role: profile.role,
        roles: profile.roles,
        canAddProducts: profile.can_add_products,
        teamMemberId: profile.team_member_id,
        activeStatus: profile.active_status,
      };

      return tabGroup?.tabs.filter((tab) => canAccessPath(userContext, pathnameFromHref(tab.href))) ?? [];
    },
    [profile.active_status, profile.can_add_products, profile.id, profile.role, profile.roles, profile.team_member_id, tabGroup],
  );

  return (
    <>
      {tabGroup && visibleTabs.length > 1 ? (
        <div className="mb-6">
          <ModuleTabs tabs={visibleTabs} currentPath={pathname} currentSearch={searchParams.toString()} moduleName={tabGroup.name} />
        </div>
      ) : null}
      {children}
    </>
  );
}
