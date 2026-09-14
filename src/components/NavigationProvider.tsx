"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { getDefaultPathForRole, type AppRole, type AuthUserContext } from "@/lib/authz";
import { navigationContextForUser, type NavigationLocation, type NavigationModule } from "@/components/module-tabs-config";

export type NavigationProfile = {
  id: string;
  role: AppRole;
  roles?: AppRole[] | null;
  can_add_products?: boolean | null;
  active_status: "active" | "inactive";
  team_member_id: string | null;
};

type NavigationState = {
  pathname: string;
  search: string;
  user: AuthUserContext;
  modules: NavigationModule[];
  location: NavigationLocation | null;
  homeHref: string;
};

const NavigationContext = createContext<NavigationState | null>(null);

export function NavigationProvider({ profile, children }: { profile: NavigationProfile; children: ReactNode }) {
  const pathname = usePathname() || "/";
  const search = useSearchParams().toString();
  const user = useMemo<AuthUserContext>(() => ({
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    activeStatus: profile.active_status,
    teamMemberId: profile.team_member_id,
  }), [profile.id, profile.role, profile.roles, profile.can_add_products, profile.active_status, profile.team_member_id]);
  const value = useMemo<NavigationState>(() => ({
    pathname,
    search,
    user,
    ...navigationContextForUser(user, pathname, search),
    homeHref: getDefaultPathForRole(user),
  }), [pathname, search, user]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useOptionalAppNavigation() {
  return useContext(NavigationContext);
}

export function useAppNavigation() {
  const context = useOptionalAppNavigation();
  if (!context) throw new Error("App navigation must be inside NavigationProvider.");
  return context;
}
