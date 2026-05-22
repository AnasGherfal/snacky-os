import { redirect } from "next/navigation";
import { ReactNode } from "react";
import { ShellChrome } from "@/components/ShellChrome";
import { canAccessPath } from "@/lib/authz";
import { getCurrentProfile } from "@/lib/auth";

const publicShellPrefixes = ["/login", "/unauthorized"];

export function isPublicShellPath(pathname: string) {
  return publicShellPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function requireShellProfile(pathname: string) {
  const profile = await getCurrentProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent(pathname)}`);
  if (profile.active_status !== "active") redirect("/unauthorized");

  const allowed = canAccessPath(
    {
      id: profile.id,
      role: profile.role,
      roles: profile.roles,
      canAddProducts: profile.can_add_products,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    },
    pathname,
  );

  if (!allowed) redirect("/unauthorized");

  return profile;
}

export async function RootAppShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const profile = await requireShellProfile(pathname);

  return <ShellChrome profile={profile}>{children}</ShellChrome>;
}
